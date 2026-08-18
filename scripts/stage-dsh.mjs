#!/usr/bin/env node
/**
 * Stage the dsh desktop runtime payload for the current platform:
 *
 *   1. `npm install` the exact upstream version of `@deepseek-ai/dsh` into a
 *      staging tree, pinning the whole `@deepseek-ai/dsh-*` family to that
 *      version through npm `overrides` (two passes: install, read the lockfile
 *      for the family member list, then reinstall with the complete override
 *      set), drop musl-only native addons on glibc Linux, prune runtime fat
 *      (debug symbols, source maps, declarations, docs, foreign-platform
 *      prebuilds and sharp variants), and copy the result into
 *      `resources/dsh/`.
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
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
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
 *     `<platform>-<arch>` (e.g. win32-arm64 prebuilds inside an x64 build);
 *   - `@img/sharp-*` platform packages other than this build's native addon
 *     and (on Darwin/Linux) its sibling `@img/sharp-libvips-*` shared library.
 *     The prebuilt `.node` rpath does not search the addon's own `lib/`, so
 *     after prune we copy libvips next to every nested addon, embed
 *     `libvips-cpp` beside the `.node`, and add `$ORIGIN` / `@loader_path`.
 *     Windows vendors libvips DLLs inside `sharp-win32-*`, so there is no
 *     separate libvips package to keep. The wasm fallback only ever loads
 *     when no native build exists.
 *
 * Deliberately NOT touched: non-declaration `.ts`/`.mts` (some packages ship
 * runtime TS sources, including @deepseek-ai/cordis), `.node`/`.dll`/`.exe`
 * native binaries, `package.json`/lockfiles, and LICENSE files of any shape.
 */
const FAT_EXTENSIONS = new Set(['.pdb', '.map', '.cc', '.cpp', '.h', '.hh'])
const DECLARATION_RE = /\.d\.[cm]?ts$/i
const DOC_RE = /\.md$/i
const LEGAL_RE = /(?:NOTICE|LICEN[CS]E|COPYING)/i

/**
 * `@img` packages that must survive for each build target.
 *
 * Darwin/Linux load `libvips-cpp` from a sibling `@img/sharp-libvips-*`
 * package (rpath / DT_NEEDED). A keep-list of only `sharp-<platform>-<arch>`
 * used to match `^sharp-` against `sharp-libvips-*` as well and delete it,
 * which then failed smoke with `no such file` / `ERR_DLOPEN_FAILED`.
 * Windows has no published `@img/sharp-libvips-win32-*` optional dep.
 */
function sharpPackagesToKeep(platformKey) {
  return new Set([`sharp-${platformKey}`, `sharp-libvips-${platformKey}`])
}

function pruneRuntimeFat(root, platformKey) {
  const keepPrebuildTag = platformKey
  const keepSharp = sharpPackagesToKeep(platformKey)
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
    const inSharpScope = parent === '@img'
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
        // @img ships one addon + (unix) libvips package per platform, plus a
        // wasm fallback. Only this build's native pair can be selected; leave
        // kept packages intact (do not fat-prune inside them).
        if (inSharpScope && /^sharp-/.test(entry.name)) {
          if (!keepSharp.has(entry.name)) {
            removedDirs.push(`@img/${entry.name}`)
            removeDir(full)
          }
          continue
        }
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

/**
 * Locate every `node_modules/@img/<packageName>` directory, including copies
 * nested under `sharp` or other dependents. Follows directory symlinks.
 */
function findAtImgPackages(root, packageName) {
  const found = []
  const seen = new Set()
  function walk(dir) {
    let real
    try {
      real = realpathSync(dir)
    } catch {
      return
    }
    const already = seen.has(real)
    seen.add(real)
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const parent = basename(dir)
    for (const entry of entries) {
      const full = join(dir, entry.name)
      let isDir = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory()
        } catch {
          continue
        }
      }
      if (!isDir) continue
      // Record every logical path, even when this dir is a symlink to one
      // already walked — Node may dlopen via the nested path, and $ORIGIN
      // then will not match the hoisted sibling.
      if (parent === '@img' && entry.name === packageName) found.push(full)
      if (!already) walk(full)
    }
  }
  walk(root)
  return found
}

function libvipsSharedLib(libDir, platformKey) {
  if (!existsSync(libDir)) return null
  const re = platformKey.startsWith('darwin')
    ? /^libvips-cpp\..+\.dylib$/
    : /^libvips-cpp\.so/
  return readdirSync(libDir).find(name => re.test(name)) ?? null
}

/**
 * The prebuilt `.node` rpath lists sibling/hoist/yarn/npm-hash layouts but
 * not `$ORIGIN` / `@loader_path` (the addon's own `lib/` directory). Copy
 * libvips-cpp next to the addon and add that rpath so dlopen no longer
 * depends on npm's hoist vs nest layout.
 */
function patchLoaderRpath(nodeFile, platformKey) {
  if (platformKey.startsWith('linux')) {
    const printed = spawnSync('patchelf', ['--print-rpath', nodeFile], { encoding: 'utf8' })
    if (printed.status !== 0) {
      console.error(
        `stage-dsh: warning: patchelf --print-rpath failed for ${nodeFile}: ${printed.stderr || printed.stdout}`
        + ' (install patchelf; falling back to LD_LIBRARY_PATH at runtime)',
      )
      return
    }
    const current = (printed.stdout ?? '').trim()
    if (current.split(':').includes('$ORIGIN')) return
    const next = current === '' ? '$ORIGIN' : `$ORIGIN:${current}`
    const patched = spawnSync(
      'patchelf',
      ['--force-rpath', '--set-rpath', next, nodeFile],
      { encoding: 'utf8' },
    )
    if (patched.status !== 0) {
      console.error(
        `stage-dsh: warning: patchelf --set-rpath failed for ${nodeFile}: ${patched.stderr || patched.stdout}`,
      )
    }
    return
  }
  if (platformKey.startsWith('darwin')) {
    const added = spawnSync('install_name_tool', ['-add_rpath', '@loader_path', nodeFile], { encoding: 'utf8' })
    const err = `${added.stderr ?? ''}${added.stdout ?? ''}`
    if (added.status !== 0 && !/duplicate/i.test(err)) {
      console.error(`stage-dsh: install_name_tool failed for ${nodeFile}: ${err}`)
      process.exit(1)
    }
    if (added.status === 0) {
      const signed = spawnSync(
        'codesign',
        ['--sign', '-', '--force', '--timestamp=none', nodeFile],
        { encoding: 'utf8' },
      )
      if (signed.status !== 0) {
        console.error(`stage-dsh: codesign failed for ${nodeFile}: ${signed.stderr || signed.stdout}`)
        process.exit(1)
      }
    }
  }
}

function embedLibvipsBesideAddon(nativeDir, canonical, libFile, platformKey, patchedNodes) {
  const destLib = join(nativeDir, 'lib')
  if (!existsSync(destLib)) {
    console.error(`stage-dsh: sharp native package has no lib/: ${nativeDir}`)
    process.exit(1)
  }
  const dest = join(destLib, libFile)
  cpSync(join(canonical, 'lib', libFile), dest, { dereference: true })
  try {
    chmodSync(dest, 0o755)
  } catch { /* mode is best-effort on some filesystems */ }
  for (const name of readdirSync(destLib)) {
    if (!name.endsWith('.node')) continue
    const nodeFile = join(destLib, name)
    let real
    try {
      real = realpathSync(nodeFile)
    } catch {
      real = nodeFile
    }
    if (patchedNodes.has(real)) continue
    patchedNodes.add(real)
    patchLoaderRpath(nodeFile, platformKey)
  }
}

/** Replace a package directory symlink with a real copy so later tree copies stay valid. */
function materializePackageDir(dir) {
  let st
  try {
    st = lstatSync(dir)
  } catch {
    return
  }
  if (!st.isSymbolicLink()) return
  const real = realpathSync(dir)
  const tmp = `${dir}.__real`
  rmSync(tmp, { recursive: true, force: true })
  cpSync(real, tmp, { recursive: true, dereference: true })
  rmSync(dir, { force: true })
  renameSync(tmp, dir)
}

/**
 * Darwin/Linux `.node` addons load `libvips-cpp` via rpath that expects a
 * sibling `@img/sharp-libvips-*` (and several package-manager layouts), but
 * not the addon's own `lib/` directory. npm often hoists libvips while
 * nesting the addon (or the reverse). Copy libvips next to every addon, then
 * also drop `libvips-cpp` beside the `.node` and add `$ORIGIN` / `@loader_path`
 * so dlopen works regardless of hoist layout.
 */
function vendorSharpLibvips(root, platformKey) {
  if (platformKey.startsWith('win32')) return
  const nativeName = `sharp-${platformKey}`
  const vipsName = `sharp-libvips-${platformKey}`
  const nativeDirs = findAtImgPackages(root, nativeName)
  const vipsDirs = findAtImgPackages(root, vipsName)
  if (nativeDirs.length === 0) {
    console.error(`stage-dsh: required sharp native package missing: @img/${nativeName}`)
    process.exit(1)
  }
  let canonical
  let libFile
  for (const dir of vipsDirs) {
    const hit = libvipsSharedLib(join(dir, 'lib'), platformKey)
    if (hit !== null) {
      canonical = dir
      libFile = hit
      break
    }
  }
  if (canonical === undefined || libFile === undefined) {
    console.error(
      vipsDirs.length === 0
        ? `stage-dsh: required sharp libvips package missing: @img/${vipsName}`
        : `stage-dsh: @img/${vipsName} is present but lib/ has no libvips-cpp shared library`,
    )
    process.exit(1)
  }
  let copied = 0
  const patchedNodes = new Set()
  for (const nativeDir of nativeDirs) {
    const sibling = join(dirname(nativeDir), vipsName)
    let same = false
    try {
      same = existsSync(sibling) && realpathSync(sibling) === realpathSync(canonical)
    } catch {
      same = false
    }
    if (!(same || libvipsSharedLib(join(sibling, 'lib'), platformKey) === libFile)) {
      rmSync(sibling, { recursive: true, force: true })
      cpSync(canonical, sibling, { recursive: true, dereference: true })
      copied += 1
    }
    embedLibvipsBesideAddon(nativeDir, canonical, libFile, platformKey, patchedNodes)
  }
  for (const dir of [...nativeDirs, canonical, ...vipsDirs]) {
    materializePackageDir(dir)
  }
  console.log(
    `stage-dsh: sharp libvips ${libFile} next to ${String(nativeDirs.length)} native addon(s)`
    + (copied > 0 ? `, copied ${String(copied)}` : '')
    + (patchedNodes.size > 0 ? `, patched ${String(patchedNodes.size)} .node rpath(s)` : ''),
  )
}

/** Fail the stage if prune (or a skipped optional install) dropped sharp's native pair. */
function verifySharpNative(root, platformKey) {
  const nativeName = `sharp-${platformKey}`
  const nativeDirs = findAtImgPackages(root, nativeName)
  if (nativeDirs.length === 0) {
    console.error(`stage-dsh: required sharp native package missing: @img/${nativeName}`)
    process.exit(1)
  }
  if (platformKey.startsWith('win32')) return
  const vipsName = `sharp-libvips-${platformKey}`
  for (const nativeDir of nativeDirs) {
    const besideNode = join(nativeDir, 'lib')
    if (libvipsSharedLib(besideNode, platformKey) === null) {
      console.error(
        `stage-dsh: libvips-cpp missing beside .node at ${relative(root, besideNode).replaceAll('\\', '/')}`,
      )
      process.exit(1)
    }
    const siblingLib = join(dirname(nativeDir), vipsName, 'lib')
    if (libvipsSharedLib(siblingLib, platformKey) === null) {
      console.error(
        `stage-dsh: libvips-cpp missing next to ${relative(root, nativeDir).replaceAll('\\', '/')} `
        + `(looked in ${relative(root, siblingLib).replaceAll('\\', '/')})`,
      )
      process.exit(1)
    }
  }
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
  const manifestPath = join(stagingDir, 'package.json')
  writeFileSync(manifestPath, JSON.stringify({
    name: 'dsh-desktop-staging',
    private: true,
    version: '0.0.0',
    overrides: { '@deepseek-ai/dsh': version },
  }, undefined, 2) + '\n')

  const installArgs = [
    'install', '--prefix', stagingDir, '--no-audit', '--no-fund',
    '--cache', cacheDir, `@deepseek-ai/dsh@${version}`,
  ]
  const npm = npmInvocation()
  run(npm.cmd, [...npm.base, ...installArgs])

  // Pass 2: pin every family member to the exact version (workspace:^ ranges
  // publish as ^0.x.y and would otherwise drift to a later rc of the same
  // release numbers).
  const lockPath = join(stagingDir, 'package-lock.json')
  const family = dshFamilyFromLock(lockPath)
  const overrides = Object.fromEntries(family.map(name => [name, version]))
  writeFileSync(manifestPath, JSON.stringify({
    name: 'dsh-desktop-staging',
    private: true,
    version: '0.0.0',
    overrides,
  }, undefined, 2) + '\n')
  run(npm.cmd, [...npm.base, ...installArgs])
  verifyFamilyVersion(lockPath, version)
  if (process.platform === 'linux') {
    pruneMuslNativeAddons(join(stagingDir, 'node_modules'))
  }
  pruneRuntimeFat(join(stagingDir, 'node_modules'), key)
  vendorSharpLibvips(join(stagingDir, 'node_modules'), key)
  verifySharpNative(join(stagingDir, 'node_modules'), key)

  // Assemble resources/dsh (the sidecar working directory at runtime).
  rmSync(resourcesDsh, { recursive: true, force: true })
  mkdirSync(resourcesDsh, { recursive: true })
  cpSync(join(stagingDir, 'node_modules'), join(resourcesDsh, 'node_modules'), { recursive: true })
  verifySharpNative(join(resourcesDsh, 'node_modules'), key)
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
