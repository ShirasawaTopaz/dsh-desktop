#!/usr/bin/env node
/**
 * Stage the dsh desktop runtime payload for the current platform:
 *
 *   1. `npm install` the exact upstream version of `@deepseek-ai/dsh` into a
 *      staging tree, pinning the whole `@deepseek-ai/dsh-*` family to that
 *      version through npm `overrides` (two passes: install, read the lockfile
 *      for the family member list, then reinstall with the complete override
 *      set). Direct dependency specifiers are saved exact so they match the
 *      overrides (npm 11 otherwise writes `^` and a later `npm install` into
 *      the same prefix throws EOVERRIDE). Drop musl-only native addons on
 *      glibc Linux, prune runtime fat (debug symbols, source maps,
 *      declarations, docs, foreign-platform prebuilds), fetch this platform's
 *      sharp native addon (and libvips on Darwin/Linux) in an isolated prefix
 *      that has no overrides, wire sharp's libvips shared library into every
 *      baked rpath, and copy the result into `resources/dsh/`.
 *   2. Download the pinned official Node.js runtime for the current platform
 *      and place it under `src-tauri/binaries/` with the Tauri sidecar naming
 *      convention (`node-<target-triple>[.exe]`), unless `--system-node` is
 *      passed (local smoke runs use the ambient Node instead).
 *   3. Copy the wrapper-owned `dsh-desktop` plugin into the staged
 *      `node_modules` and declare it in the vendored dsh manifest (so the
 *      profile module fallback resolves it at boot).
 *   4. Write `resources/version.json` (upstream version, node version, target).
 *
 * The staged tree is what `tauri build` embeds; the app then spawns
 * `node node_modules/@deepseek-ai/dsh/lib/bin.js --profile web ...` from
 * `resources/dsh` as a sidecar.
 *
 * Usage: node scripts/stage-dsh.mjs --version <v> [--system-node] [--npm-cache <dir>]
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Wrapper-owned plugin injected into the staged tree (shutdown bridge +
 * Settings → About page). The plugin package ships from `plugins/dsh-desktop/`
 * and is copied into the staged `node_modules`; the vendored `@deepseek-ai/dsh`
 * manifest additionally declares it as a dependency so dsh's profile module
 * fallback symlinks it into `~/.dsh/profiles/node_modules`, which is what
 * makes the bare-name loader row and the browser client-modules resolution
 * both work at runtime.
 */
const WRAPPER_PLUGIN_PACKAGE = 'dsh-desktop'
const WRAPPER_PLUGIN_VERSION = '0.0.0'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NODE_DIST_BASE = 'https://nodejs.org/dist'

/** Target-triple and Node artifact per (platform, arch) this wrapper builds. */
const TARGETS = {
  'win32-x64': { triple: 'x86_64-pc-windows-msvc', archive: v => `node-v${v}-win-x64.zip`, bin: 'node.exe' },
  'win32-arm64': { triple: 'aarch64-pc-windows-msvc', archive: v => `node-v${v}-win-arm64.zip`, bin: 'node.exe' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin', archive: v => `node-v${v}-darwin-arm64.tar.gz`, bin: 'bin/node' },
  'darwin-x64': { triple: 'x86_64-apple-darwin', archive: v => `node-v${v}-darwin-x64.tar.gz`, bin: 'bin/node' },
  'linux-x64': { triple: 'x86_64-unknown-linux-gnu', archive: v => `node-v${v}-linux-x64.tar.gz`, bin: 'bin/node' },
  'linux-arm64': { triple: 'aarch64-unknown-linux-gnu', archive: v => `node-v${v}-linux-arm64.tar.gz`, bin: 'bin/node' },
}

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

function usage() {
  console.error('usage: node scripts/stage-dsh.mjs --version <v> [--system-node] [--npm-cache <dir>]')
  process.exit(2)
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (result.status !== 0) {
    console.error(`stage-dsh: ${cmd} ${args.join(' ')} failed (exit ${String(result.status)})`)
    process.exit(1)
  }
}

/**
 * Resolve an npm invocation that Node can spawn on this platform. Spawning a
 * `.cmd` shim directly (`spawnSync('npm.cmd', ...)`) fails with EINVAL on
 * Windows, so the npm CLI is executed through its real `node` entry instead.
 */
function npmInvocation() {
  if (process.platform !== 'win32') return { cmd: 'npm', base: [] }
  const which = spawnSync('where.exe', ['npm'], { stdio: 'pipe' })
  const first = (which.stdout ?? Buffer.alloc(0)).toString().split(/\r?\n/).find(line => line.trim() !== '')
  if (which.status === 0 && first !== undefined) {
    const cli = join(dirname(first), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(cli)) return { cmd: process.execPath, base: [cli] }
  }
  return { cmd: 'cmd.exe', base: ['/d', '/s', '/c', 'npm'] }
}

/** Collect every @deepseek-ai/dsh-* package name from a package-lock.json. */
function dshFamilyFromLock(lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const names = []
  for (const key of Object.keys(lock.packages ?? {})) {
    const match = /^node_modules\/(@deepseek-ai\/dsh(?:-[^/]+)?)$/.exec(key)
    if (match !== null) names.push(match[1])
  }
  return names.sort()
}

/**
 * Official Node (and this wrapper) is glibc. Packages such as
 * `@koromix/koffi-linux-x64` ship both `gnu_*` / `linux_*` and `musl_*`
 * addons in one tarball. linuxdeploy then walks every ELF in the AppDir,
 * cannot resolve `libc.musl-x86_64.so.1` on Ubuntu runners, and aborts
 * AppImage bundling. The musl binaries cannot load against the embedded
 * glibc Node anyway, so drop them from the staged tree.
 */
function isMuslNativeDir(name) {
  return (
    /^musl[_-]/i.test(name)
    || /linuxmusl/i.test(name)
    || /[-_]musl$/i.test(name)
    || /[-_]musl[-_]/i.test(name)
  )
}

function pruneMuslNativeAddons(root) {
  const removed = []
  function walk(dir) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (isMuslNativeDir(entry.name)) {
        rmSync(full, { recursive: true, force: true })
        removed.push(relative(root, full).replaceAll('\\', '/'))
        continue
      }
      walk(full)
    }
  }
  walk(root)
  if (removed.length === 0) {
    console.log('stage-dsh: no musl native addon paths to prune')
    return
  }
  console.log(`stage-dsh: pruned ${String(removed.length)} musl native addon path(s) (glibc runtime)`)
  for (const path of removed) console.log(`  - ${path}`)
}

/**
 * Runtime-fat pruning. The vendored tree only ever executes through
 * `node lib/bin.js`; the assets below are dead weight in a shipped desktop
 * build and dropping them roughly halves the payload (and the file count,
 * which is its own win for install time and antivirus scanning):
 *
 *   - Windows debug symbols (`.pdb`, node-pty alone ships ~53 MB);
 *   - source maps (`.map`) and TypeScript declarations (`.d.ts/.d.mts/.d.cts`)
 *     — dev-time assets the Node runtime never loads;
 *   - C++ sources/headers shipped inside native-addon packages;
 *   - prose docs (`.md`), keeping NOTICE/LICENSE/COPYING for compliance;
 *   - `prebuilds/<tag>/` dirs whose tag does not match this build's
 *     `<platform>-<arch>` (e.g. win32-arm64 prebuilds inside an x64 build).
 *     `@img` is left intact: sharp's Darwin/Linux addons load `libvips-cpp`
 *     via baked rpaths, and pruning `@img/sharp-*` previously deleted the
 *     sibling `@img/sharp-libvips-*` package (the `^sharp-` match).
 *
 * Deliberately NOT touched: non-declaration `.ts`/`.mts` (some packages ship
 * runtime TS sources, including @deepseek-ai/cordis), `.node`/`.dll`/`.exe`
 * native binaries, `package.json`/lockfiles, and LICENSE files of any shape.
 */
const FAT_EXTENSIONS = new Set(['.pdb', '.map', '.cc', '.cpp', '.h', '.hh'])
const DECLARATION_RE = /\.d\.[cm]?ts$/i
const DOC_RE = /\.md$/i
const LEGAL_RE = /(?:NOTICE|LICEN[CS]E|COPYING)/i

function pruneRuntimeFat(root, platformKey) {
  const keepPrebuildTag = platformKey
  let removedFiles = 0
  let removedBytes = 0
  const removedDirs = []

  function extOf(name) {
    const dot = name.lastIndexOf('.')
    return dot > 0 ? name.slice(dot).toLowerCase() : ''
  }

  function isFatFile(name) {
    if (FAT_EXTENSIONS.has(extOf(name))) return true
    if (DECLARATION_RE.test(name)) return true
    if (DOC_RE.test(name) && !LEGAL_RE.test(name)) return true
    return false
  }

  function dirSize(dir) {
    let total = 0
    let count = 0
    function walkDir(path) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name)
        if (entry.isDirectory()) walkDir(full)
        else if (entry.isFile()) {
          try {
            total += statSync(full).size
            count += 1
          } catch { /* unstatistable files are still removed */ }
        }
      }
    }
    try {
      walkDir(dir)
    } catch {
      /* unreadable trees are still removed wholesale */
    }
    return { total, count }
  }

  function removeDir(full) {
    const { total, count } = dirSize(full)
    removedFiles += count
    removedBytes += total
    rmSync(full, { recursive: true, force: true })
  }

  function walk(dir) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const parent = basename(dir)
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Foreign native prebuilds (node-pty and friends tag dirs with the
        // runtime pair, e.g. prebuilds/win32-x64).
        if (parent === 'prebuilds' && !entry.name.startsWith(keepPrebuildTag)) {
          removedDirs.push(relative(root, full).replaceAll('\\', '/'))
          removeDir(full)
          continue
        }
        // Leave @img intact. sharp's native addon and libvips packages are
        // both named `sharp-*`; deleting "foreign" variants used to remove
        // `@img/sharp-libvips-*` and break Darwin/Linux dlopen.
        if (parent === '@img') continue
        walk(full)
      } else if (entry.isFile() && isFatFile(entry.name)) {
        let size = 0
        try {
          size = statSync(full).size
        } catch { /* unstatistable files still get removed */ }
        removedFiles += 1
        removedBytes += size
        rmSync(full, { force: true })
      }
    }
  }

  walk(root)
  console.log(
    `stage-dsh: pruned runtime fat for ${platformKey}: ${String(removedFiles)} file(s) / `
    + `${(removedBytes / 1e6).toFixed(1)} MB${removedDirs.length > 0 ? `, dirs: ${removedDirs.join(', ')}` : ''}`,
  )
}

const SHARP_LIB_PATH_FILE = '.dsh-lib-path'

function libvipsCppName(name, platformKey) {
  if (platformKey.startsWith('darwin')) return /^libvips-cpp\..+\.dylib$/.test(name)
  return /^libvips-cpp\.so/.test(name)
}

function walkEntries(dir, visit, depth = 0) {
  if (depth > 24) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) visit(full, entry.name, true, false)
    else if (entry.isSymbolicLink()) {
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      visit(full, entry.name, isDir, true)
    } else if (entry.isFile()) visit(full, entry.name, false, false)
  }
}

function machoRpaths(buf) {
  const ncmds = buf.readUInt32LE(16)
  let off = 32
  const out = []
  for (let i = 0; i < ncmds; i += 1) {
    const cmd = buf.readUInt32LE(off)
    const cmdsize = buf.readUInt32LE(off + 4)
    if (cmdsize < 8 || off + cmdsize > buf.length) break
    if (cmd === 0x8000001c) {
      const pathOff = buf.readUInt32LE(off + 8)
      let start = off + pathOff
      let end = start
      while (end < off + cmdsize && buf[end] !== 0) end += 1
      out.push(buf.toString('utf8', start, end))
    }
    off += cmdsize
  }
  return out
}

function elfRpaths(buf) {
  const le = buf[5] === 1
  const u16 = o => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
  const u32 = o => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  const u64 = o => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o))
  const e_shoff = u64(40)
  const e_shentsize = u16(58)
  const e_shnum = u16(60)
  const e_shstrndx = u16(62)
  const shstr = e_shoff + e_shstrndx * e_shentsize
  const shstrOff = u64(shstr + 24)
  function shName(off) {
    let i = shstrOff + off
    let s = ''
    while (buf[i] !== 0) {
      s += String.fromCharCode(buf[i])
      i += 1
    }
    return s
  }
  let dynOff = 0
  let dynSize = 0
  const sections = []
  for (let i = 0; i < e_shnum; i += 1) {
    const o = e_shoff + i * e_shentsize
    const rec = { name: shName(u32(o)), addr: u64(o + 16), offset: u64(o + 24), size: Number(u64(o + 32)) }
    sections.push(rec)
    if (rec.name === '.dynamic') {
      dynOff = rec.offset
      dynSize = rec.size
    }
  }
  const e_phoff = u64(32)
  const e_phentsize = u16(54)
  const e_phnum = u16(56)
  const loads = []
  for (let i = 0; i < e_phnum; i += 1) {
    const o = e_phoff + i * e_phentsize
    if (u32(o) === 1) loads.push({ offset: u64(o + 8), vaddr: u64(o + 16), filesz: Number(u64(o + 32)) })
  }
  function vaToOff(va) {
    for (const l of loads) {
      if (va >= l.vaddr && va < l.vaddr + l.filesz) return l.offset + (va - l.vaddr)
    }
    for (const s of sections) {
      if (va >= s.addr && va < s.addr + s.size) return s.offset + (va - s.addr)
    }
    return va
  }
  function readStr(strtab, off) {
    let i = strtab + off
    let s = ''
    while (buf[i] !== 0) {
      s += String.fromCharCode(buf[i])
      i += 1
    }
    return s
  }
  const DT_RPATH = 15
  const DT_RUNPATH = 29
  const DT_STRTAB = 5
  let strtabVA
  let rpath
  let runpath
  for (let o = dynOff; o < dynOff + dynSize; o += 16) {
    const tag = u64(o)
    const val = u64(o + 8)
    if (tag === 0) break
    if (tag === DT_STRTAB) strtabVA = val
    if (tag === DT_RPATH) rpath = val
    if (tag === DT_RUNPATH) runpath = val
  }
  if (strtabVA === undefined) return []
  const strtab = vaToOff(strtabVA)
  const raw = [rpath, runpath].filter(v => v !== undefined).map(v => readStr(strtab, v)).join(':')
  return raw.split(':').map(s => s.trim()).filter(s => s !== '')
}

function nativeRpaths(nodeFile) {
  const buf = readFileSync(nodeFile)
  if (buf.length >= 4 && buf[0] === 0x7f && buf.toString('ascii', 1, 4) === 'ELF') return elfRpaths(buf)
  const magic = buf.readUInt32LE(0)
  if (magic === 0xfeedfacf || magic === 0xcffaedfe) return machoRpaths(buf)
  return []
}

function resolveOriginPath(nodeDir, token) {
  if (token === '$ORIGIN' || token === '@loader_path' || token === '@executable_path' || token === '.') {
    return nodeDir
  }
  const stripped = token
    .replace(/^\$ORIGIN(?=\/|$)/, '.')
    .replace(/^@loader_path(?=\/|$)/, '.')
    .replace(/^@executable_path(?=\/|$)/, '.')
  return resolve(nodeDir, stripped)
}

function sameFile(a, b) {
  if (resolve(a) === resolve(b)) return true
  try {
    return existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

function placeLibvips(src, destDir, libFile) {
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, libFile)
  // One baked rpath is the libvips package's own lib/ (where we found src).
  if (sameFile(src, dest)) return
  cpSync(src, dest, { dereference: true })
  try {
    chmodSync(dest, 0o755)
  } catch { /* mode is best-effort */ }
}

function materializeAtImg(root) {
  const targets = []
  function walk(dir, depth) {
    if (depth > 20) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const parent = basename(dir)
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (parent === '@img' && entry.isSymbolicLink()) {
        try {
          if (statSync(full).isDirectory()) targets.push(full)
        } catch { /* broken symlink */ }
        continue
      }
      if (entry.isDirectory()) walk(full, depth + 1)
    }
  }
  walk(root, 0)
  for (const dir of targets) {
    const real = realpathSync(dir)
    const tmp = `${dir}.__real`
    rmSync(tmp, { recursive: true, force: true })
    cpSync(real, tmp, { recursive: true, dereference: true })
    rmSync(dir, { force: true })
    renameSync(tmp, dir)
    console.log(`stage-dsh: materialized ${relative(root, dir).replaceAll('\\', '/')}`)
  }
}

function writeStagingManifest(manifestPath, version, family) {
  writeFileSync(manifestPath, JSON.stringify({
    name: 'dsh-desktop-staging',
    private: true,
    version: '0.0.0',
    dependencies: { '@deepseek-ai/dsh': version },
    overrides: Object.fromEntries(family.map(name => [name, version])),
  }, undefined, 2) + '\n')
}

function readPackageManifest(nodeModules, name) {
  const parts = name.split('/')
  const hoisted = join(nodeModules, ...parts, 'package.json')
  if (existsSync(hoisted)) return JSON.parse(readFileSync(hoisted, 'utf8'))
  function walk(dir, depth) {
    if (depth > 10) return null
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name === 'node_modules') {
        const nested = join(full, ...parts, 'package.json')
        if (existsSync(nested)) return JSON.parse(readFileSync(nested, 'utf8'))
        const found = walk(full, depth + 1)
        if (found) return found
      } else if (entry.name.startsWith('@')) {
        const found = walk(full, depth + 1)
        if (found) return found
      }
    }
    return null
  }
  return walk(nodeModules, 0)
}

function sharpPlatformSpecs(nodeModules, platformKey) {
  const names = [`@img/sharp-${platformKey}`]
  if (!platformKey.startsWith('win32')) names.push(`@img/sharp-libvips-${platformKey}`)
  const sharp = readPackageManifest(nodeModules, 'sharp')
  const optional = sharp?.optionalDependencies ?? {}
  return names.map(name => (optional[name] !== undefined ? `${name}@${optional[name]}` : name))
}

/**
 * Fetch this platform's sharp addon + libvips in an isolated prefix that has
 * no `overrides`. A second `npm install` into staging hits EOVERRIDE on npm 11
 * when the direct `@deepseek-ai/dsh` specifier is `^x.y.z` but the override
 * pins the exact version. Copy the resulting `@img/*` trees in as real files.
 */
function installSharpPlatformPackages(nodeModules, cacheDir, platformKey, npm) {
  const pkgs = sharpPlatformSpecs(nodeModules, platformKey)
  const tmp = join(dirname(nodeModules), '.sharp-install')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({
    name: 'dsh-desktop-sharp',
    private: true,
    version: '0.0.0',
  }, undefined, 2) + '\n')
  const dash = platformKey.indexOf('-')
  const os = platformKey.slice(0, dash)
  const cpu = platformKey.slice(dash + 1)
  console.log(`stage-dsh: installing ${pkgs.join(', ')} for ${os}/${cpu} (isolated prefix)`)
  run(npm.cmd, [
    ...npm.base,
    'install', '--prefix', tmp, '--no-audit', '--no-fund',
    '--include=optional', `--os=${os}`, `--cpu=${cpu}`,
    '--cache', cacheDir, ...pkgs,
  ])
  const srcImg = join(tmp, 'node_modules', '@img')
  const destImg = join(nodeModules, '@img')
  if (!existsSync(srcImg)) {
    console.error(`stage-dsh: isolated sharp install produced no ${srcImg}`)
    process.exit(1)
  }
  mkdirSync(destImg, { recursive: true })
  for (const name of readdirSync(srcImg)) {
    const dest = join(destImg, name)
    rmSync(dest, { recursive: true, force: true })
    cpSync(join(srcImg, name), dest, { recursive: true, dereference: true })
    console.log(`stage-dsh: copied @img/${name}`)
  }
  rmSync(tmp, { recursive: true, force: true })
}

/**
 * Copy `libvips-cpp` next to every sharp `.node` and into every directory
 * named by that binary's baked rpath (`$ORIGIN` / `@loader_path` relative).
 * Guessing npm's hoist layout is not enough; the error path
 * `@img-sharp-libvips-*-npm-<hash>/...` is one of those baked rpaths.
 */
function wireSharpNative(nodeModules, platformKey, dshRoot) {
  if (platformKey.startsWith('win32')) return
  const marker = `/sharp-${platformKey}/`
  const libvipsFiles = []
  const nodeFiles = []
  function walk(dir, depth) {
    if (depth > 24) return
    walkEntries(dir, (full, name, isDir) => {
      if (isDir) {
        walk(full, depth + 1)
        return
      }
      if (libvipsCppName(name, platformKey)) libvipsFiles.push(full)
      if (name.endsWith('.node') && full.replaceAll('\\', '/').includes(marker)) nodeFiles.push(full)
    })
  }
  walk(nodeModules, 0)
  if (libvipsFiles.length === 0) {
    console.error(`stage-dsh: libvips-cpp not found under node_modules (need @img/sharp-libvips-${platformKey})`)
    process.exit(1)
  }
  if (nodeFiles.length === 0) {
    console.error(`stage-dsh: sharp addon .node not found (need @img/sharp-${platformKey})`)
    process.exit(1)
  }
  const src = libvipsFiles[0]
  const libFile = basename(src)
  const placed = new Set()
  for (const nodeFile of nodeFiles) {
    const nodeDir = dirname(nodeFile)
    placeLibvips(src, nodeDir, libFile)
    placed.add(nodeDir)
    const rpaths = nativeRpaths(nodeFile)
    console.log(`stage-dsh: ${relative(nodeModules, nodeFile).replaceAll('\\', '/')} rpaths: ${rpaths.join(' | ') || '(none)'}`)
    for (const token of rpaths) {
      const destDir = resolveOriginPath(nodeDir, token)
      placeLibvips(src, destDir, libFile)
      placed.add(destDir)
    }
    if (platformKey.startsWith('linux')) {
      const printed = spawnSync('patchelf', ['--print-rpath', nodeFile], { encoding: 'utf8' })
      if (printed.status === 0) {
        const current = (printed.stdout ?? '').trim()
        if (!current.split(':').includes('$ORIGIN')) {
          const next = current === '' ? '$ORIGIN' : `$ORIGIN:${current}`
          spawnSync('patchelf', ['--force-rpath', '--set-rpath', next, nodeFile], { encoding: 'utf8' })
        }
      }
    } else if (platformKey.startsWith('darwin')) {
      const added = spawnSync('install_name_tool', ['-add_rpath', '@loader_path', nodeFile], { encoding: 'utf8' })
      const err = `${added.stderr ?? ''}${added.stdout ?? ''}`
      if (added.status === 0) {
        spawnSync('codesign', ['--sign', '-', '--force', '--timestamp=none', nodeFile], { encoding: 'utf8' })
      } else if (!/duplicate/i.test(err)) {
        console.error(`stage-dsh: warning: install_name_tool: ${err}`)
      }
    }
  }
  const relDirs = [...placed]
    .map(dir => relative(dshRoot, dir).replaceAll('\\', '/'))
    .filter(dir => dir !== '' && !dir.startsWith('..'))
    .sort()
  writeFileSync(join(dshRoot, SHARP_LIB_PATH_FILE), relDirs.join('\n') + '\n')
  console.log(`stage-dsh: placed ${libFile} in ${String(placed.size)} dir(s), wrote ${SHARP_LIB_PATH_FILE}`)
}

/** Assert every installed @deepseek-ai/dsh-* package sits on the exact version. */
function verifyFamilyVersion(lockPath, version) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const offenders = []
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!/^node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/.test(key)) continue
    if (entry.version !== version) offenders.push(`${key}@${entry.version}`)
  }
  if (offenders.length > 0) {
    console.error(`stage-dsh: family version mismatch (want ${version}): ${offenders.join(', ')}`)
    process.exit(1)
  }
}

/**
 * Inject the wrapper-owned dsh-desktop plugin into the assembled payload:
 * copy the package into the staged `node_modules` and declare it as a
 * dependency of the vendored `@deepseek-ai/dsh` manifest. The manifest entry
 * is what makes `healProfilesModuleFallback` symlink the package into the
 * profile's module fallback dir at boot, which both the loader (bare-name row
 * `dsh-desktop`) and the browser client-modules resolution depend on.
 *
 * The vendored manifest is regenerated on every stage (fresh npm install), so
 * this patch is applied per stage and never drifts across releases.
 */
function injectWrapperPlugin(resourcesDsh) {
  const source = join(ROOT, 'plugins', WRAPPER_PLUGIN_PACKAGE)
  const dest = join(resourcesDsh, 'node_modules', WRAPPER_PLUGIN_PACKAGE)
  if (!existsSync(join(source, 'package.json'))) {
    console.error(`stage-dsh: wrapper plugin missing at ${source}`)
    process.exit(1)
  }
  rmSync(dest, { recursive: true, force: true })
  cpSync(source, dest, { recursive: true })

  const appManifestPath = join(resourcesDsh, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const appManifest = JSON.parse(readFileSync(appManifestPath, 'utf8'))
  const dependencies = appManifest.dependencies ?? {}
  if (dependencies[WRAPPER_PLUGIN_PACKAGE] === undefined) {
    dependencies[WRAPPER_PLUGIN_PACKAGE] = WRAPPER_PLUGIN_VERSION
    appManifest.dependencies = Object.fromEntries(
      Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
    )
    writeFileSync(appManifestPath, JSON.stringify(appManifest, undefined, 2) + '\n')
  }

  // Verify both post-conditions fail loud (mirrors verifyFamilyVersion).
  const packaged = join(dest, 'package.json')
  if (!existsSync(packaged)) {
    console.error(`stage-dsh: wrapper plugin not staged at ${packaged}`)
    process.exit(1)
  }
  const patched = JSON.parse(readFileSync(appManifestPath, 'utf8'))
  if (patched.dependencies?.[WRAPPER_PLUGIN_PACKAGE] !== WRAPPER_PLUGIN_VERSION) {
    console.error('stage-dsh: vendored dsh manifest missing the dsh-desktop dependency')
    process.exit(1)
  }
  console.log(`stage-dsh: wrapper plugin ${WRAPPER_PLUGIN_PACKAGE} staged`)
}

async function main() {
  const args = process.argv.slice(2)
  let version
  let systemNode = false
  let npmCache
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--version') version = args[++i]
    else if (arg === '--system-node') systemNode = true
    else if (arg === '--npm-cache') npmCache = args[++i]
    else usage()
  }
  if (version === undefined || !VERSION_RE.test(version)) usage()

  const key = `${process.platform}-${process.arch}`
  const target = TARGETS[key]
  if (target === undefined) {
    console.error(`stage-dsh: unsupported platform/arch ${key}`)
    process.exit(1)
  }

  const stagingDir = join(ROOT, 'staging')
  const cacheDir = npmCache ?? join(ROOT, '.npm-cache')
  const resourcesDsh = join(ROOT, 'resources', 'dsh')
  mkdirSync(stagingDir, { recursive: true })
  mkdirSync(cacheDir, { recursive: true })

  // Pass 1: install the exact root package so the lockfile reveals the family.
  // `--save-exact` keeps the direct specifier identical to the override; npm 11
  // otherwise writes `^version` and any later install into this prefix fails
  // with EOVERRIDE ("conflicts with direct dependency").
  const manifestPath = join(stagingDir, 'package.json')
  writeStagingManifest(manifestPath, version, ['@deepseek-ai/dsh'])

  const installArgs = [
    'install', '--prefix', stagingDir, '--no-audit', '--no-fund', '--save-exact',
    '--cache', cacheDir,
  ]
  const npm = npmInvocation()
  run(npm.cmd, [...npm.base, ...installArgs])

  // Pass 2: pin every family member to the exact version (workspace:^ ranges
  // publish as ^0.x.y and would otherwise drift to a later rc of the same
  // release numbers).
  const lockPath = join(stagingDir, 'package-lock.json')
  const family = dshFamilyFromLock(lockPath)
  writeStagingManifest(manifestPath, version, family)
  run(npm.cmd, [...npm.base, ...installArgs])
  verifyFamilyVersion(lockPath, version)
  installSharpPlatformPackages(join(stagingDir, 'node_modules'), cacheDir, key, npm)
  if (process.platform === 'linux') {
    pruneMuslNativeAddons(join(stagingDir, 'node_modules'))
  }
  pruneRuntimeFat(join(stagingDir, 'node_modules'), key)
  materializeAtImg(join(stagingDir, 'node_modules'))

  // Assemble resources/dsh (the sidecar working directory at runtime).
  rmSync(resourcesDsh, { recursive: true, force: true })
  mkdirSync(resourcesDsh, { recursive: true })
  cpSync(join(stagingDir, 'node_modules'), join(resourcesDsh, 'node_modules'), { recursive: true })
  wireSharpNative(join(resourcesDsh, 'node_modules'), key, resourcesDsh)
  cpSync(manifestPath, join(resourcesDsh, 'package.json'))
  cpSync(lockPath, join(resourcesDsh, 'package-lock.json'))
  injectWrapperPlugin(resourcesDsh)

  // Node runtime sidecar.
  let nodeVersion = null
  if (systemNode) {
    console.log(`stage-dsh: --system-node, skipping the Node download (target ${target.triple})`)
  } else {
    nodeVersion = process.env.DSH_NODE_VERSION
    if (nodeVersion === undefined || !VERSION_RE.test(nodeVersion)) {
      console.error('stage-dsh: DSH_NODE_VERSION must be an exact Node version (e.g. 24.13.0) unless --system-node is set')
      process.exit(1)
    }
    const archiveName = target.archive(nodeVersion)
    const archiveUrl = `${NODE_DIST_BASE}/v${nodeVersion}/${archiveName}`
    const archivePath = join(stagingDir, archiveName)
    const extractDir = join(stagingDir, 'node-dist')
    console.log(`stage-dsh: downloading ${archiveUrl}`)
    const response = await fetch(archiveUrl)
    if (!response.ok) {
      console.error(`stage-dsh: download failed: ${response.status} ${response.statusText}`)
      process.exit(1)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    writeFileSync(archivePath, bytes)
    rmSync(extractDir, { recursive: true, force: true })
    mkdirSync(extractDir, { recursive: true })
    // bsdtar (Windows) and GNU tar both handle .zip and .tar.gz.
    run('tar', ['-xf', archivePath, '-C', extractDir])

    // Official Node archives carry a platform-suffixed top-level directory
    // (node-v<v>-win-x64, node-v<v>-darwin-arm64, ...).
    const topLevel = archiveName.replace(/\.(zip|tar\.gz)$/, '')
    const extracted = join(extractDir, topLevel, target.bin)
    if (!existsSync(extracted)) {
      console.error(`stage-dsh: node binary not found at ${extracted}`)
      process.exit(1)
    }
    const sidecarName = `node-${target.triple}${target.bin.endsWith('.exe') ? '.exe' : ''}`
    const sidecarDir = join(ROOT, 'src-tauri', 'binaries')
    mkdirSync(sidecarDir, { recursive: true })
    cpSync(extracted, join(sidecarDir, sidecarName))
    if (process.platform !== 'win32') chmodSync(join(sidecarDir, sidecarName), 0o755)
    console.log(`stage-dsh: node ${nodeVersion} staged as ${sidecarName}`)
  }

  const payload = {
    version,
    nodeVersion,
    target: target.triple,
    platform: process.platform,
    arch: process.arch,
  }
  writeFileSync(join(ROOT, 'resources', 'version.json'), JSON.stringify(payload, undefined, 2) + '\n')
  console.log(`stage-dsh: staged ${version} for ${target.triple} into resources/dsh`)
}

await main()
