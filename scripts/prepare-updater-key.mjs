#!/usr/bin/env node
/**
 * Prepare the Tauri updater signing key for CI.
 *
 * `tauri build` always base64-decodes `TAURI_SIGNING_PRIVATE_KEY` (or the
 * contents of the file it points at). The GitHub secret may be stored either
 * as that base64 blob, or as the raw minisign key (`untrusted comment:` …).
 *
 * Passing the raw minisign form yields:
 *
 *   failed to decode base64 key: Invalid symbol 32, offset 9
 *
 * (`untrusted comment:` has a space at index 9.) Passing a Windows path
 * through `GITHUB_ENV` is also unreliable: backslashes can be eaten, `exists()`
 * then fails, and Tauri base64-decodes the path string instead.
 *
 * This script normalizes to the single-line base64 form and writes it to a
 * file. `--exec` loads that file and runs the Tauri CLI, so the CLI only ever
 * sees a one-line base64 blob (safe for cmd.exe). An absent key disables
 * `bundle.createUpdaterArtifacts` so the build can still produce unsigned
 * installers.
 *
 * Usage:
 *   node scripts/prepare-updater-key.mjs [--key-out <path>] [--password-out <path>]
 *   node scripts/prepare-updater-key.mjs --self-test
 *   node scripts/prepare-updater-key.mjs --exec [tauri cli args...]
 *
 * Defaults (GitHub Actions): `$GITHUB_WORKSPACE/.ci-tauri-updater.key`.
 *
 * Reads `RAW_SIGNING_KEY` / `RAW_SIGNING_PASSWORD` from the environment.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_CONFIG = join(ROOT, 'src-tauri', 'tauri.conf.json')
const DEFAULT_DIR = process.env.GITHUB_WORKSPACE || ROOT
const DEFAULT_KEY_OUT = join(DEFAULT_DIR, '.ci-tauri-updater.key')
const DEFAULT_PASSWORD_OUT = join(DEFAULT_DIR, '.ci-tauri-updater.password')
const TAURI_NPM_SPEC = '@tauri-apps/cli@^2'

function usage() {
  console.error(
    'usage: node scripts/prepare-updater-key.mjs [--key-out <path>] [--password-out <path>] [--config <tauri.conf.json>]\n' +
      '       node scripts/prepare-updater-key.mjs --self-test\n' +
      '       node scripts/prepare-updater-key.mjs --exec [tauri cli args...]',
  )
  process.exit(2)
}

function parseArgs(argv) {
  const args = {
    keyOut: DEFAULT_KEY_OUT,
    passwordOut: DEFAULT_PASSWORD_OUT,
    config: DEFAULT_CONFIG,
    selfTest: false,
    exec: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--key-out') args.keyOut = argv[++i]
    else if (arg === '--password-out') args.passwordOut = argv[++i]
    else if (arg === '--config') args.config = argv[++i]
    else if (arg === '--self-test') args.selfTest = true
    else if (arg === '--exec') {
      args.exec = argv.slice(i + 1)
      break
    } else usage()
  }
  return args
}

function looksLikeMinisign(text) {
  return text.trimStart().startsWith('untrusted comment:')
}

/** Expand a GitHub-secret-style literal `\n` only when the value is still one line. */
function unescapeNewlines(text) {
  if (text.includes('\n') || !text.includes('\\n')) return text
  return text.replace(/\\n/g, '\n')
}

/**
 * GitHub's Windows env injection sometimes flattens the two-line minisign
 * secret into one line (`untrusted comment: … <base64>`). Restore the newline
 * before the payload so minisign can parse it.
 */
function restoreFlattenedMinisign(text) {
  if (text.includes('\n') || !looksLikeMinisign(text)) return text
  const match = text.match(/^(untrusted comment:[^\n]+?)\s+([A-Za-z0-9+/]+=*)\s*$/)
  if (match === null || match[2].length < 80) return text
  return `${match[1]}\n${match[2]}`
}

function asMinisignKey(text) {
  const trimmed = restoreFlattenedMinisign(
    text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim(),
  )
  if (!looksLikeMinisign(trimmed)) return null
  return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`
}

/**
 * Node's base64 decoder is lenient; reject payloads that are not real base64
 * of a minisign secret key.
 */
function decodeTauriBase64(text) {
  const compact = text.replace(/\s+/g, '')
  if (compact.length === 0 || compact.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null
  const decoded = Buffer.from(compact, 'base64').toString('utf8')
  if (!looksLikeMinisign(decoded)) return null
  return decoded
}

/** Return the single-line base64 blob `tauri build` expects. */
function normalizePrivateKey(raw) {
  const expanded = unescapeNewlines(String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
  const minisign = asMinisignKey(expanded)
  if (minisign !== null) return Buffer.from(minisign, 'utf8').toString('base64')
  const decoded = decodeTauriBase64(expanded.trim())
  if (decoded === null) {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY is neither a minisign secret key nor Tauri base64')
  }
  const canonical = asMinisignKey(decoded)
  if (canonical === null) {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY is neither a minisign secret key nor Tauri base64')
  }
  return Buffer.from(canonical, 'utf8').toString('base64')
}

/** Strip the trailing newline GitHub's secret UI commonly appends. */
function normalizePassword(raw) {
  return String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/\n+$/u, '')
}

function disableUpdaterArtifacts(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.bundle.createUpdaterArtifacts = false
  writeFileSync(configPath, JSON.stringify(config, undefined, 2) + '\n')
  console.log(`prepare-updater-key: no signing key; disabled createUpdaterArtifacts in ${configPath}`)
}

function writeSecretFile(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function firstExistingFile(paths) {
  for (const path of paths) {
    if (path && existsSync(path)) return path
  }
  return undefined
}

function applySigningEnv(args) {
  const keyFile = firstExistingFile([
    process.env.TAURI_UPDATER_KEY_FILE,
    args.keyOut,
    DEFAULT_KEY_OUT,
  ])
  const passwordFile = firstExistingFile([
    process.env.TAURI_UPDATER_PASSWORD_FILE,
    args.passwordOut,
    DEFAULT_PASSWORD_OUT,
  ])

  let rawKey = ''
  if (keyFile !== undefined) rawKey = readFileSync(keyFile, 'utf8')
  else if (process.env.TAURI_SIGNING_PRIVATE_KEY) rawKey = process.env.TAURI_SIGNING_PRIVATE_KEY
  else if (process.env.RAW_SIGNING_KEY) rawKey = process.env.RAW_SIGNING_KEY

  let rawPassword = ''
  if (passwordFile !== undefined) rawPassword = readFileSync(passwordFile, 'utf8')
  else if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD !== undefined) {
    rawPassword = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  } else if (process.env.RAW_SIGNING_PASSWORD !== undefined) {
    rawPassword = process.env.RAW_SIGNING_PASSWORD
  }

  if (rawKey.trim() === '') {
    delete process.env.TAURI_SIGNING_PRIVATE_KEY
    delete process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    console.log('prepare-updater-key: --exec with no signing key')
    return
  }

  const key = normalizePrivateKey(rawKey)
  const password = normalizePassword(rawPassword)
  if (key.includes(' ') || key.includes('\n') || key.includes('\r')) {
    throw new Error('normalized signing key is not a single-line base64 blob')
  }
  process.env.TAURI_SIGNING_PRIVATE_KEY = key
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = password
  const source = keyFile !== undefined ? `file ${keyFile}` : 'environment'
  console.log(`prepare-updater-key: --exec using ${source} (${key.length} bytes, base64)`)
}

function quoteCmdArg(value) {
  if (/^[\w@./:=+-]+$/.test(value)) return value
  return `"${String(value).replace(/"/g, '""')}"`
}

function execTauri(args) {
  applySigningEnv(args)
  const isWin = process.platform === 'win32'
  // cmd.exe treats `^` as an escape; quote the npm spec. Pass a single command
  // string so Node does not warn on `shell: true` + args (DEP0190).
  const child = isWin
    ? spawn(
        ['npx', '--yes', quoteCmdArg(TAURI_NPM_SPEC), ...args.exec.map(quoteCmdArg)].join(' '),
        { stdio: 'inherit', env: process.env, shell: true },
      )
    : spawn('npx', ['--yes', TAURI_NPM_SPEC, ...args.exec], {
        stdio: 'inherit',
        env: process.env,
      })
  child.on('error', (error) => {
    console.error(`prepare-updater-key: failed to spawn tauri cli: ${error.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 1)
  })
}

function selfTest() {
  // Encrypted with an empty password; taken from tauri-cli's updater_signature tests.
  const tauriKey =
    'dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5ClJXUlRZMEl5dkpDN09RZm5GeVAzc2RuYlNzWVVJelJRQnNIV2JUcGVXZUplWXZXYXpqUUFBQkFBQUFBQUFBQUFBQUlBQUFBQTZrN2RnWGh5dURxSzZiL1ZQSDdNcktiaHRxczQwMXdQelRHbjRNcGVlY1BLMTBxR2dpa3I3dDE1UTVDRDE4MXR4WlQwa1BQaXdxKy9UU2J2QmVSNXhOQWFDeG1GSVllbUNpTGJQRkhhTnROR3I5RmdUZi90OGtvaGhJS1ZTcjdZU0NyYzhQWlQ5cGM9Cg=='
  const minisign = Buffer.from(tauriKey, 'base64').toString('utf8')
  if (!looksLikeMinisign(minisign)) throw new Error('fixture is not minisign')
  if (minisign.charCodeAt(9) !== 32) throw new Error('fixture space is not at offset 9')
  const fromBase64 = normalizePrivateKey(tauriKey)
  const fromMinisign = normalizePrivateKey(minisign)
  const fromWrapped = normalizePrivateKey(`\n${tauriKey}\n`)
  const fromEscaped = normalizePrivateKey(minisign.trim().replace(/\n/g, '\\n'))
  const fromFlattened = normalizePrivateKey(minisign.trim().replace(/\n/g, ' '))
  for (const [label, value] of [
    ['base64', fromBase64],
    ['minisign', fromMinisign],
    ['wrapped', fromWrapped],
    ['escaped', fromEscaped],
    ['flattened', fromFlattened],
  ]) {
    if (value.includes(' ') || value.includes('\n')) {
      throw new Error(`${label}: normalized key still has whitespace`)
    }
    const roundTrip = Buffer.from(value, 'base64').toString('utf8')
    if (!looksLikeMinisign(roundTrip)) throw new Error(`${label}: lost minisign comment`)
    if (roundTrip.trim() !== minisign.trim()) throw new Error(`${label}: round-trip mismatch`)
  }
  if (normalizePassword('secret\n\n') !== 'secret') throw new Error('password trim failed')
  if (normalizePassword('') !== '') throw new Error('empty password should stay empty')
  console.log('prepare-updater-key: self-test ok')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.selfTest) {
    selfTest()
    return
  }
  if (args.exec !== null) {
    execTauri(args)
    return
  }

  const rawKey = process.env.RAW_SIGNING_KEY ?? ''
  const rawPassword = process.env.RAW_SIGNING_PASSWORD ?? ''
  if (rawKey.trim() === '') {
    disableUpdaterArtifacts(args.config)
    return
  }

  const key = normalizePrivateKey(rawKey)
  const password = normalizePassword(rawPassword)
  writeSecretFile(args.keyOut, key)
  writeSecretFile(args.passwordOut, password)
  console.log(`prepare-updater-key: wrote signing key to ${args.keyOut}`)
}

try {
  main()
} catch (error) {
  console.error(`prepare-updater-key: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
