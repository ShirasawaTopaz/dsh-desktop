#!/usr/bin/env node
/**
 * Prepare the Tauri updater signing key for CI.
 *
 * `tauri build` always base64-decodes `TAURI_SIGNING_PRIVATE_KEY`. The GitHub
 * secret may be stored either as that base64 blob, or as the raw minisign key
 * (`untrusted comment:` …). Passing the raw form yields:
 *
 *   failed to decode base64 key: Invalid symbol 32, offset 9
 *
 * (`untrusted comment:` has a space at index 9.)
 *
 * This script normalizes to a single-line base64 blob and exports it through
 * `GITHUB_ENV` as `NAME=value` (not a file path: Windows backslashes in
 * `GITHUB_ENV` get eaten, `exists()` fails, and Tauri then decodes the path).
 * An absent key disables `bundle.createUpdaterArtifacts` so the build can
 * still produce unsigned installers.
 *
 * Usage:
 *   node scripts/prepare-updater-key.mjs [--config <tauri.conf.json>]
 *   node scripts/prepare-updater-key.mjs --self-test
 *
 * Reads `RAW_SIGNING_KEY` / `RAW_SIGNING_PASSWORD` from the environment.
 */

import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_CONFIG = join(ROOT, 'src-tauri', 'tauri.conf.json')

function usage() {
  console.error(
    'usage: node scripts/prepare-updater-key.mjs [--config <tauri.conf.json>]\n' +
      '       node scripts/prepare-updater-key.mjs --self-test',
  )
  process.exit(2)
}

function parseArgs(argv) {
  const args = { config: DEFAULT_CONFIG, selfTest: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--config') args.config = argv[++i]
    else if (arg === '--self-test') args.selfTest = true
    else usage()
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

/**
 * Export a single-line value via `GITHUB_ENV`. Never use a heredoc here: the
 * extra newline would be part of the value, and Tauri would fail base64
 * padding. Never export a Windows path: `\` in `GITHUB_ENV` is unreliable.
 */
function appendGitHubEnv(name, value) {
  const envFile = process.env.GITHUB_ENV
  if (envFile === undefined || envFile === '') return
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    throw new Error(`${name} must be a single line to export via GITHUB_ENV`)
  }
  appendFileSync(envFile, `${name}=${value}\n`)
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
    if (value.includes(' ') || value.includes('\n') || value.includes('\r')) {
      throw new Error(`${label}: normalized key still has whitespace`)
    }
    const roundTrip = Buffer.from(value, 'base64').toString('utf8')
    if (!looksLikeMinisign(roundTrip)) throw new Error(`${label}: lost minisign comment`)
    if (roundTrip.trim() !== minisign.trim()) throw new Error(`${label}: round-trip mismatch`)
  }
  if (normalizePassword('secret\n\n') !== 'secret') throw new Error('password trim failed')
  if (normalizePassword('') !== '') throw new Error('empty password should stay empty')

  const envFile = join(tmpdir(), `dsh-github-env-${process.pid}.env`)
  writeFileSync(envFile, '')
  const previousEnv = process.env.GITHUB_ENV
  process.env.GITHUB_ENV = envFile
  try {
    appendGitHubEnv('TAURI_SIGNING_PRIVATE_KEY', fromBase64)
    appendGitHubEnv('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'secret')
    const body = readFileSync(envFile, 'utf8')
    const expected =
      `TAURI_SIGNING_PRIVATE_KEY=${fromBase64}\n` +
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD=secret\n'
    if (body !== expected) throw new Error(`GITHUB_ENV format mismatch: ${JSON.stringify(body)}`)
  } finally {
    if (previousEnv === undefined) delete process.env.GITHUB_ENV
    else process.env.GITHUB_ENV = previousEnv
    unlinkSync(envFile)
  }
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
  appendGitHubEnv('TAURI_SIGNING_PRIVATE_KEY', key)
  appendGitHubEnv('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', password)
  if (process.env.GITHUB_ENV) {
    console.log(`prepare-updater-key: exported signing key via GITHUB_ENV (${key.length} bytes, base64)`)
  } else {
    console.log('prepare-updater-key: GITHUB_ENV unset; skipped export')
  }
}

try {
  main()
} catch (error) {
  console.error(`prepare-updater-key: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
