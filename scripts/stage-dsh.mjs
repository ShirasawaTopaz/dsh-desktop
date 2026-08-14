#!/usr/bin/env node
/**
 * Stage the dsh desktop runtime payload for the current platform:
 *
 *   1. `npm install` the exact upstream version of `@deepseek-ai/dsh` into a
 *      staging tree, pinning the whole `@deepseek-ai/dsh-*` family to that
 *      version through npm `overrides` (two passes: install, read the lockfile
 *      for the family member list, then reinstall with the complete override
 *      set), and copy the result into `resources/dsh/`.
 *   2. Download the pinned official Node.js runtime for the current platform
 *      and place it under `src-tauri/binaries/` with the Tauri sidecar naming
 *      convention (`node-<target-triple>[.exe]`), unless `--system-node` is
 *      passed (local smoke runs use the ambient Node instead).
 *   3. Write `resources/version.json` (upstream version, node version, target).
 *
 * The staged tree is what `tauri build` embeds; the app then spawns
 * `node node_modules/@deepseek-ai/dsh/lib/bin.js --profile web ...` from
 * `resources/dsh` as a sidecar.
 *
 * Usage: node scripts/stage-dsh.mjs --version <v> [--system-node] [--npm-cache <dir>]
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

  // Assemble resources/dsh (the sidecar working directory at runtime).
  rmSync(resourcesDsh, { recursive: true, force: true })
  mkdirSync(resourcesDsh, { recursive: true })
  cpSync(join(stagingDir, 'node_modules'), join(resourcesDsh, 'node_modules'), { recursive: true })
  cpSync(manifestPath, join(resourcesDsh, 'package.json'))
  cpSync(lockPath, join(resourcesDsh, 'package-lock.json'))

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
