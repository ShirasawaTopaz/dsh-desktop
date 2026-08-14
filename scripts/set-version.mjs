#!/usr/bin/env node
/**
 * Write the upstream dsh version into both `src-tauri/tauri.conf.json` and
 * `src-tauri/Cargo.toml` so the Tauri build carries the exact version being
 * wrapped (tauri-build refuses a config/Cargo version mismatch).
 *
 * Usage: node scripts/set-version.mjs <v>
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

const version = process.argv[2]
if (version === undefined || !VERSION_RE.test(version)) {
  console.error('usage: node scripts/set-version.mjs <v>')
  process.exit(2)
}

const configPath = join(ROOT, 'src-tauri', 'tauri.conf.json')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
config.version = version
writeFileSync(configPath, JSON.stringify(config, undefined, 2) + '\n')

const cargoPath = join(ROOT, 'src-tauri', 'Cargo.toml')
const cargo = readFileSync(cargoPath, 'utf8')
const next = cargo.replace(/^version = "[^"]+"$/m, `version = "${version}"`)
if (next === cargo) {
  console.error(`set-version: no version line found in ${cargoPath}`)
  process.exit(1)
}
writeFileSync(cargoPath, next)

console.log(`set-version: ${version}`)
