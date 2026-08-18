#!/usr/bin/env node
/**
 * Payload smoke test: boot the staged dsh web profile exactly the way the
 * Tauri shell does (sidecar node + `--profile web --host 127.0.0.1 --port 0`
 * + the wrapper patch overlay + the shutdown token env), then prove the
 * runtime contract:
 *
 *   1. the readiness line `dsh web: http://127.0.0.1:<port>` appears on stdout;
 *   2. `GET /` serves the injected `window.__DSH_BOOT__` boot graph;
 *   3. a module row URL from the boot graph serves its client bundle;
 *   4. the dsh-desktop plugin is composed: its boot-graph row serves the
 *      client bundle, `GET /api/tauri/version` answers with the payload
 *      (and answers 403 to a non-loopback Host), and
 *      `POST /api/tauri/shutdown` with the token ends the process with code 0.
 *
 * Usage:
 *   node scripts/smoke.mjs --dsh <resources/dsh> [--node <node binary>]
 *                          [--home <temp DSH_HOME>] [--timeout-ms <ms>]
 */

import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const READINESS_RE = /dsh web: http:\/\/127\.0\.0\.1:(\d+)/

/** Default node binary: the staged sidecar (from version.json), else system node. */
function defaultNode() {
  try {
    const payload = JSON.parse(readFileSync(join(ROOT, 'resources', 'version.json'), 'utf8'))
    if (typeof payload.target === 'string') {
      const exe = process.platform === 'win32' ? '.exe' : ''
      return join(ROOT, 'src-tauri', 'binaries', `node-${payload.target}${exe}`)
    }
  } catch {
    // version.json absent (never staged) — fall through to system node.
  }
  return process.execPath
}

function parseArgs(argv) {
  const args = { dsh: join(ROOT, 'resources', 'dsh'), node: defaultNode(), home: null, timeoutMs: 60_000 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dsh') args.dsh = argv[++i]
    else if (arg === '--node') args.node = argv[++i]
    else if (arg === '--home') args.home = argv[++i]
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i])
    else {
      console.error(`smoke: unknown argument ${arg}`)
      process.exit(2)
    }
  }
  return args
}

/**
 * Directories that contain `libvips-cpp`, so Linux dlopen can find it via
 * LD_LIBRARY_PATH. Prefers `.dsh-lib-path` written by stage-dsh; falls back
 * to a tree walk. macOS signed Node often ignores DYLD_*.
 */
function sharpLibraryEnv(dshRoot) {
  if (process.platform === 'win32') return {}
  const dirs = []
  const listed = join(dshRoot, '.dsh-lib-path')
  if (existsSync(listed)) {
    for (const line of readFileSync(listed, 'utf8').split(/\r?\n/)) {
      const rel = line.trim()
      if (rel === '') continue
      const dir = join(dshRoot, rel)
      if (existsSync(dir)) dirs.push(dir)
    }
  }
  if (dirs.length === 0) {
    function walk(dir, depth) {
      if (depth > 16) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isFile() && /^libvips-cpp\./.test(entry.name)) {
          dirs.push(dir)
          return
        }
        if (entry.isDirectory()) walk(full, depth + 1)
      }
    }
    walk(join(dshRoot, 'node_modules'), 0)
  }
  if (dirs.length === 0) return {}
  const envName = process.platform === 'darwin' ? 'DYLD_FALLBACK_LIBRARY_PATH' : 'LD_LIBRARY_PATH'
  const prev = process.env[envName]
  const value = prev ? `${dirs.join(delimiter)}${delimiter}${prev}` : dirs.join(delimiter)
  console.log(`smoke: ${envName}=${value}`)
  return { [envName]: value }
}

/** Read the child's stdout line stream, resolving with the matched port. */
function waitForReadiness(child, regex, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    let stderrTail = ''
    const timer = setTimeout(() => {
      reject(new Error(`smoke: readiness line not seen within ${timeoutMs}ms (stderr: ${stderrTail})`))
    }, timeoutMs)
    child.stderr.on('data', chunk => {
      stderrTail = (stderrTail + String(chunk)).slice(-2000)
    })
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        const match = regex.exec(line)
        if (match !== null) {
          clearTimeout(timer)
          resolve(Number(match[1]))
          return
        }
      }
    })
    child.on('exit', code => {
      clearTimeout(timer)
      reject(new Error(`smoke: dsh exited early (code ${String(code)}); stderr tail: ${stderrTail}`))
    })
  })
}

function fail(message) {
  console.error(`smoke: FAIL — ${message}`)
  process.exit(1)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const bin = join(args.dsh, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const home = args.home ?? mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
  const token = 'smoke-token-' + Math.random().toString(16).slice(2)

  // The wrapper patch overlay, exactly as the Rust shell generates it at launch.
  const patchPath = join(home, 'tauri.patch.yml')
  writeFileSync(patchPath, [
    '# Generated by dsh-desktop smoke; do not edit.',
    '- insert:',
    '    - id: dsh-desktop',
    "      name: 'dsh-desktop'",
    '',
  ].join('\n'))

  const child = spawn(args.node, [
    bin, '--patch', patchPath,
    '--profile', 'web', '--host', '127.0.0.1', '--port', '0',
  ], {
    cwd: args.dsh,
    env: {
      ...process.env,
      ...sharpLibraryEnv(args.dsh),
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TAURI_SHUTDOWN_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let port
  try {
    port = await waitForReadiness(child, READINESS_RE, args.timeoutMs)
  } catch (error) {
    fail(error.message)
  }
  console.log(`smoke: ready on http://127.0.0.1:${port}`)

  const index = await fetch(`http://127.0.0.1:${port}/`)
  const html = await index.text()
  if (index.status !== 200 || !html.includes('window.__DSH_BOOT__')) {
    fail(`GET / status ${index.status}, __DSH_BOOT__ injection missing`)
  }
  console.log('smoke: index serves window.__DSH_BOOT__')

  // Fetch one module row from the boot graph to prove client bundles serve.
  // The injected script is `window.__DSH_BOOT__ = {...}</script>`; extract
  // tolerantly (the JSON may carry a trailing dot/space before the tag).
  const marker = 'window.__DSH_BOOT__ = '
  const at = html.indexOf(marker)
  if (at === -1) fail('boot graph script tag not found')
  let raw = html.slice(at + marker.length)
  const scriptEnd = raw.indexOf('</script>')
  if (scriptEnd !== -1) raw = raw.slice(0, scriptEnd)
  const cut = raw.lastIndexOf('}')
  if (cut === -1) fail('boot graph JSON not found')
  let boot
  try {
    boot = JSON.parse(raw.slice(0, cut + 1))
  } catch {
    fail('boot graph JSON parse failed')
  }

  const firstRow = boot.entries?.find(row => typeof row.url === 'string')
  if (firstRow !== undefined) {
    const client = await fetch(`http://127.0.0.1:${port}${firstRow.url}`)
    if (client.status !== 200) fail(`module bundle GET ${firstRow.url} status ${client.status}`)
    console.log(`smoke: module bundle serves (${firstRow.url})`)
  } else {
    fail('boot graph carries no module rows to fetch')
  }

  // The wrapper's dsh-desktop client plugin must be composed into the graph
  // and its bundle served to the browser.
  const wrapperRow = boot.entries?.find(row => row.id === 'dsh-desktop')
  if (wrapperRow === undefined || typeof wrapperRow.url !== 'string') {
    fail('boot graph missing the dsh-desktop entry (is the plugin staged?)')
  }
  const wrapperBundle = await fetch(`http://127.0.0.1:${port}${wrapperRow.url}`)
  const wrapperSource = await wrapperBundle.text()
  if (wrapperBundle.status !== 200 || !wrapperSource.includes('__ModuleLoader__.load')) {
    fail(`dsh-desktop bundle GET ${wrapperRow.url} status ${wrapperBundle.status}`)
  }
  console.log('smoke: dsh-desktop client plugin composed and served')

  // The version route must answer with the wrapper payload to loopback hosts
  // and refuse non-loopback Host headers.
  const versionRes = await fetch(`http://127.0.0.1:${port}/api/tauri/version`)
  const versionBody = await versionRes.json()
  if (versionRes.status !== 200 || typeof versionBody.version !== 'string') {
    fail(`version route status ${versionRes.status}, payload ${JSON.stringify(versionBody)}`)
  }
  console.log(`smoke: version route answers (${versionBody.version})`)
  const forged = await new Promise(resolve => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/api/tauri/version',
      headers: { host: 'evil.example' },
    }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', error => resolve(`error: ${error.message}`))
    req.end()
  })
  if (forged !== 403) fail(`version route forged-Host status ${String(forged)} (want 403)`)
  console.log('smoke: version route rejects non-loopback Host')

  // Register the exit watcher BEFORE requesting shutdown: the sidecar can
  // exit within milliseconds of the 204, and a late listener would miss it.
  const exitPromise = new Promise(resolve => {
    const timer = setTimeout(() => resolve('timeout'), 15_000)
    child.on('exit', code => { clearTimeout(timer); resolve(code) })
  })

  const shutdown = await fetch(`http://127.0.0.1:${port}/api/tauri/shutdown`, {
    method: 'POST',
    headers: { 'X-Dsh-Shutdown-Token': token },
  })
  if (shutdown.status !== 204) fail(`shutdown route status ${shutdown.status}`)
  console.log('smoke: shutdown route answered 204')

  const exitCode = await exitPromise
  if (exitCode !== 0) fail(`dsh exit code ${String(exitCode)} (want 0)`)
  console.log('smoke: dsh exited cleanly with code 0')
  console.log('smoke: PASS')

  if (args.home === null) rmSync(home, { recursive: true, force: true })
}

await main()
