#!/usr/bin/env node
/**
 * Write the build version into both `src-tauri/tauri.conf.json` and
 * `src-tauri/Cargo.toml` (tauri-build refuses a config/Cargo version mismatch).
 * Optionally normalize prerelease metadata for Windows MSI constraints.
 *
 * Usage: node scripts/set-version.mjs <v> [--msi-compatible]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

const version = process.argv[2]
const msiCompatible = process.argv.includes('--msi-compatible')
if (version === undefined || !VERSION_RE.test(version)) {
  console.error('usage: node scripts/set-version.mjs <v> [--msi-compatible]')
  process.exit(2)
}

let targetVersion = version
if (msiCompatible) {
  const prerelease = version.match(/-(.+)$/)?.[1]
  if (prerelease !== undefined) {
    const base = version.slice(0, version.indexOf('-'))
    const numericPart = prerelease
      .split('.')
      .find((part) => /^\d+$/.test(part))
    const candidate = numericPart === undefined ? 0 : Number.parseInt(numericPart, 10)
    const bounded = Number.isNaN(candidate) ? 0 : Math.min(candidate, 65535)
    targetVersion = `${base}-${bounded}`
  }
}

const configPath = join(ROOT, 'src-tauri', 'tauri.conf.json')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
config.version = targetVersion
writeFileSync(configPath, JSON.stringify(config, undefined, 2) + '\n')

const cargoPath = join(ROOT, 'src-tauri', 'Cargo.toml')
const cargo = readFileSync(cargoPath, 'utf8')
// \r? tolerates CRLF checkouts (Windows git autocrlf). Presence is judged by
// the regex, not by the replace changing the text: re-running the script for
// the version already in the manifest is a no-op, not an error.
const versionLine = /^version = "[^"]+"\r?$/m
if (!versionLine.test(cargo)) {
  console.error(`set-version: no version line found in ${cargoPath}`)
  process.exit(1)
}
const next = cargo.replace(versionLine, `version = "${targetVersion}"`)
writeFileSync(cargoPath, next)

console.log(`set-version: ${targetVersion}`)
