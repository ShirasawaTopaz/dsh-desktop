#!/usr/bin/env node
/**
 * Prepare the Tauri updater signing key for CI.
 *
 * `tauri build` always base64-decodes `TAURI_SIGNING_PRIVATE_KEY` (or the
 * contents of the file it points at). The GitHub secret may be stored either
 * as that base64 blob, or as the raw minisign key (`untrusted comment:` …).
 * Passing the raw form, or round-tripping a multiline key through
 * `GITHUB_OUTPUT`, yields:
 *
 *   failed to decode secret key: incorrect updater private key password:
 *   Missing comment in secret key
 *
 * This script normalizes to the single-line base64 form, writes it to a file,
 * and (when `GITHUB_ENV` is set) exports the file path plus the password.
 * An absent key disables `bundle.createUpdaterArtifacts` so the build can
 * still produce unsigned installers.
 *
 * Usage:
 *   node scripts/prepare-updater-key.mjs [--key-out <path>] [--config <tauri.conf.json>]
 *   node scripts/prepare-updater-key.mjs --self-test
 *
 * `--key-out` defaults to `$RUNNER_TEMP/tauri-updater.key` in GitHub Actions.
 *
 * Reads `RAW_SIGNING_KEY` / `RAW_SIGNING_PASSWORD` from the environment.
 */

import { randomBytes } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_CONFIG = join(ROOT, 'src-tauri', 'tauri.conf.json')
const DEFAULT_KEY_OUT = process.env.RUNNER_TEMP
  ? join(process.env.RUNNER_TEMP, 'tauri-updater.key')
  : undefined

function usage() {
  console.error('usage: node scripts/prepare-updater-key.mjs --key-out <path> [--config <tauri.conf.json>]')
  process.exit(2)
}

function parseArgs(argv) {
  const args = { keyOut: DEFAULT_KEY_OUT, config: DEFAULT_CONFIG, selfTest: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--key-out') args.keyOut = argv[++i]
    else if (arg === '--config') args.config = argv[++i]
    else if (arg === '--self-test') args.selfTest = true
    else usage()
  }
  if (!args.selfTest && args.keyOut === undefined) usage()
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

function asMinisignKey(text) {
  const trimmed = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
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

function appendGitHubEnv(name, value) {
  const envFile = process.env.GITHUB_ENV
  if (envFile === undefined || envFile === '') return
  // Prefer `name=value`: a heredoc trailing newline would make Tauri treat
  // the key-file path as missing (`exists()` fails) and then base64-decode
  // the path string instead.
  if (!value.includes('\n') && !value.includes('\r')) {
    appendFileSync(envFile, `${name}=${value}\n`)
    return
  }
  const delim = `EOF_${randomBytes(8).toString('hex')}`
  appendFileSync(envFile, `${name}<<${delim}\n${value}\n${delim}\n`)
}

function selfTest() {
  // Encrypted with an empty password; taken from tauri-cli's updater_signature tests.
  const tauriKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5ClJXUlRZMEl5dkpDN09RZm5GeVAzc2RuYlNzWVVJelJRQnNIV2JUcGVXZUplWXZXYXpqUUFBQkFBQUFBQUFBQUFBQUlBQUFBQTZrN2RnWGh5dURxSzZiL1ZQSDdNcktiaHRxczQwMXdQelRHbjRNcGVlY1BLMTBxR2dpa3I3dDE1UTVDRDE4MXR4WlQwa1BQaXdxKy9UU2J2QmVSNXhOQWFDeG1GSVllbUNpTGJQRkhhTnROR3I5RmdUZi90OGtvaGhJS1ZTcjdZU0NyYzhQWlQ5cGM9Cg=='
  const minisign = Buffer.from(tauriKey, 'base64').toString('utf8')
  if (!looksLikeMinisign(minisign)) throw new Error('fixture is not minisign')
  const fromBase64 = normalizePrivateKey(tauriKey)
  const fromMinisign = normalizePrivateKey(minisign)
  const fromWrapped = normalizePrivateKey(`\n${tauriKey}\n`)
  const fromEscaped = normalizePrivateKey(minisign.trim().replace(/\n/g, '\\n'))
  for (const [label, value] of [
    ['base64', fromBase64],
    ['minisign', fromMinisign],
    ['wrapped', fromWrapped],
    ['escaped', fromEscaped],
  ]) {
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

  const rawKey = process.env.RAW_SIGNING_KEY ?? ''
  const rawPassword = process.env.RAW_SIGNING_PASSWORD ?? ''
  if (rawKey.trim() === '') {
    disableUpdaterArtifacts(args.config)
    return
  }

  const key = normalizePrivateKey(rawKey)
  const password = normalizePassword(rawPassword)
  writeFileSync(args.keyOut, key)
  appendGitHubEnv('TAURI_SIGNING_PRIVATE_KEY', args.keyOut)
  appendGitHubEnv('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', password)
  console.log(`prepare-updater-key: wrote signing key to ${args.keyOut}`)
}

try {
  main()
} catch (error) {
  console.error(`prepare-updater-key: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
