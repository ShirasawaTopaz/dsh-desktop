/**
 * dsh-computer-use plugin — Windows backend.
 *
 * Every action spawns a fresh `powershell.exe` (5.1 ships with Windows) over
 * the bundled `native/win.ps1` helper. The request travels as JSON on stdin
 * and the response as JSON on stdout, so model-supplied strings (typed text,
 * key names) never touch a command line — there is no interpolation surface.
 */

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ERROR_PREFIX } from '../args.js'

const SCRIPT = fileURLToPath(new URL('./native/win.ps1', import.meta.url))

/** Windows PowerShell 5.1 is always present; prefer the absolute path. */
const POWERSHELL = process.env.SystemRoot !== undefined
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe'

const ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT]

/** Run one helper request through the JSON-over-stdio protocol. */
function runHelper(request, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, ARGS, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer

    const settle = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      if (err !== undefined) reject(err)
      else resolve(value)
    }
    const onAbort = () => {
      try { child.kill() } catch { /* already dead */ }
      settle(new Error(`${ERROR_PREFIX} action cancelled`))
    }
    if (signal !== undefined) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    timer = setTimeout(() => {
      try { child.kill() } catch { /* already dead */ }
      settle(new Error(`${ERROR_PREFIX} helper timed out after ${timeoutMs}ms and was killed`))
    }, timeoutMs)

    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdin.on('error', () => { /* helper may exit before stdin closes */ })
    child.on('error', error => {
      settle(new Error(`${ERROR_PREFIX} cannot launch powershell.exe: ${error.message}`))
    })
    child.on('close', code => {
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch {
        settle(new Error(
          `${ERROR_PREFIX} helper produced no valid response (exit ${String(code)})`
          + (stderr.trim() !== '' ? `; stderr: ${stderr.trim().slice(-400)}` : '')))
        return
      }
      if (parsed === null || typeof parsed !== 'object') {
        settle(new Error(`${ERROR_PREFIX} helper response is not an object`))
        return
      }
      if (parsed.ok === false) {
        settle(new Error(`${ERROR_PREFIX} ${parsed.message ?? parsed.code ?? 'helper failed'}`))
        return
      }
      settle(undefined, parsed)
    })

    child.stdin.end(JSON.stringify(request))
  })
}

export async function probe() {
  try {
    await access(POWERSHELL)
    await access(SCRIPT)
  } catch {
    return { available: false, reason: `powershell.exe or the bundled win.ps1 helper is missing (looked for ${POWERSHELL} and ${SCRIPT})` }
  }
  return { available: true }
}

export async function bounds({ timeoutMs, signal }) {
  const result = await runHelper({ action: 'bounds' }, { timeoutMs, signal })
  return { width: result.screenW, height: result.screenH }
}

export async function perform(request, { timeoutMs, signal }) {
  return runHelper(request, { timeoutMs, signal })
}
