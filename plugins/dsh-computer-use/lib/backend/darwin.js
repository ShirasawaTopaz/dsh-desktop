/**
 * dsh-computer-use plugin — macOS backend.
 *
 * Screenshots run through `/usr/sbin/screencapture` (Screen Recording
 * permission), dimensions come straight from the PNG IHDR header, and JPEG
 * degradation goes through `/usr/bin/sips`. Mouse/wheel/drag actions post
 * CGEvents through the bundled JXA helper; typing and key combos use System
 * Events keystroke scripts whose only interpolated content passes through
 * `escapeAppleScriptString`. Both input paths require the Accessibility
 * permission; a refusal surfaces as structured PERMISSION_DENIED guidance.
 *
 * Coordinate mapping: screenshots are physical pixels; `-R` crops and CGEvent
 * positions are logical points, so everything converts through the main
 * screen's backing scale factor (probed once alongside bounds).
 */

import { execFile } from 'node:child_process'
import { access, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ERROR_PREFIX, escapeAppleScriptString } from '../args.js'

const SCREENCAPTURE = '/usr/sbin/screencapture'
const OSASCRIPT = '/usr/bin/osascript'
const SIPS = '/usr/bin/sips'

const JXA_SOURCE = fileURLToPath(new URL('./native/darwin.jxa.js', import.meta.url))

const execFileP = promisify(execFile)

/** Run one helper invocation with timeout + abort wiring. */
async function run(file, args, { timeoutMs, signal, env } = {}) {
  const options = { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true }
  if (env !== undefined) options.env = { ...process.env, ...env }
  if (signal !== undefined) {
    if (signal.aborted) throw new Error(`${ERROR_PREFIX} action cancelled`)
    options.signal = signal
  }
  try {
    return await execFileP(file, args, options)
  } catch (error) {
    if (signal?.aborted || error.killed || error.signal === 'SIGKILL') {
      throw new Error(`${ERROR_PREFIX} action cancelled or timed out`)
    }
    const stderrText = typeof error.stderr === 'string' ? error.stderr : ''
    if (/assistive access|not allowed to send/i.test(stderrText)) {
      throw new Error(
        `${ERROR_PREFIX} PERMISSION_DENIED: macOS refused input injection because this app lacks the Accessibility permission; `
        + 'grant it under System Settings > Privacy & Security > Accessibility and retry')
    }
    throw new Error(`${ERROR_PREFIX} ${basename(file)} failed (${error.message.slice(0, 200)})`)
  }
}

function basename(path) {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}

/**
 * Parse a PNG's intrinsic size from its IHDR chunk without any dependency.
 * @returns `{width, height}` or `undefined` when the bytes are not a PNG.
 */
export function pngSize(header) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (header.length < 24 || !header.subarray(0, 8).equals(signature)) return undefined
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
}

/** Cached display geometry in screenshot pixels plus the point scale. */
let geometry

async function probe() {
  for (const candidate of [SCREENCAPTURE, OSASCRIPT]) {
    try {
      await access(candidate)
    } catch {
      return { available: false, reason: `${candidate} not found; computer-use requires a standard macOS install` }
    }
  }
  return {
    available: true,
    reason: 'input actions require the Accessibility permission, screenshots require Screen Recording '
      + '(System Settings > Privacy & Security); without them actions fail closed or capture wallpaper-only frames',
  }
}

/** Backing scale of the main screen, probed through AppKit once. */
async function backingScale({ timeoutMs, signal }) {
  if (geometry?.scale !== undefined) return geometry.scale
  const result = await run(OSASCRIPT, ['-l', 'JavaScript', '-e',
    'ObjC.import("AppKit"); String(NSScreen.mainScreen.backingScaleFactor)'],
  { timeoutMs, signal })
  const scale = Number.parseFloat(result.stdout.trim())
  const value = Number.isFinite(scale) && scale >= 1 ? scale : 1
  geometry = { ...geometry, scale: value }
  return value
}

export async function bounds({ timeoutMs, signal }) {
  if (geometry?.width !== undefined) return { width: geometry.width, height: geometry.height }
  const tmp = join(tmpdir(), `dsh-cu-bounds-${randomUUID()}.png`)
  try {
    await run(SCREENCAPTURE, ['-x', tmp], { timeoutMs, signal })
    const header = await readFile(tmp).then(buf => buf.subarray(0, 32))
    const size = pngSize(header)
    if (size === undefined) throw new Error('screencapture did not produce a PNG')
    geometry = { ...geometry, width: size.width, height: size.height }
    return { width: size.width, height: size.height }
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

async function performScreenshot(request, opts) {
  const scale = await backingScale(opts)
  // Populate the geometry cache so the envelope reports full-screen size
  // even when the capture is a crop.
  await bounds(opts)
  const tmp = join(tmpdir(), `dsh-cu-shot-${randomUUID()}.png`)
  const args = ['-x']
  let cropX = 0
  let cropY = 0
  let cropW
  let cropH
  if (request.region !== undefined) {
    // -R speaks logical points; the request speaks screenshot pixels.
    cropX = Math.round(request.region.x / scale)
    cropY = Math.round(request.region.y / scale)
    cropW = Math.max(1, Math.round(request.region.width / scale))
    cropH = Math.max(1, Math.round(request.region.height / scale))
    args.push('-R', `${cropX},${cropY},${cropW},${cropH}`)
  }
  args.push(tmp)
  try {
    await run(SCREENCAPTURE, args, opts)
    const bytes = await readFile(tmp)
    const size = pngSize(bytes.subarray(0, 32))
    if (size === undefined) {
      throw new Error(
        `${ERROR_PREFIX} CAPTURE_FAILED: screencapture produced no PNG (is the Screen Recording permission granted? `
        + 'ungranted captures can come back empty); grant it under System Settings > Privacy & Security > Screen Recording')
    }

    let mediaType = 'image/png'
    let data = bytes
    if (bytes.byteLength > request.maxImageBytes) {
      const jpgTmp = `${tmp}.jpg`
      try {
        await run(SIPS, ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(request.jpegQuality), tmp, '--out', jpgTmp], opts)
        data = await readFile(jpgTmp)
        mediaType = 'image/jpeg'
      } finally {
        await rm(jpgTmp, { force: true }).catch(() => {})
      }
      if (data.byteLength > request.maxImageBytes) {
        throw new Error(
          `${ERROR_PREFIX} TOO_LARGE: screenshot still exceeds the ${request.maxImageBytes} byte limit after JPEG encoding`
          + ` (${data.byteLength} bytes); retry with a smaller region`)
      }
    }

    return {
      ok: true,
      mediaType,
      dataBase64: data.toString('base64'),
      width: size.width,
      height: size.height,
      scale,
      screenW: geometry.width ?? size.width,
      screenH: geometry.height ?? size.height,
      cropX: request.region !== undefined ? request.region.x : 0,
      cropY: request.region !== undefined ? request.region.y : 0,
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/** macOS virtual-key codes for the special-key vocabulary (kVK_*). */
const KEY_CODES = {
  enter: 36, tab: 48, escape: 53, space: 49, backspace: 51, delete: 117,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111, f13: 105, f14: 107, f15: 113,
  f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
}

const MODIFIER_NAMES = { ctrl: 'control', alt: 'option', shift: 'shift', meta: 'command' }

function applescriptSource(lines) {
  return lines.join('\n')
}

function modifierClause(modifiers) {
  const names = (modifiers ?? []).map(name => MODIFIER_NAMES[name]).filter(name => name !== undefined)
  return names.length === 0 ? '' : ` using {${names.map(name => `${name} down`).join(', ')}}`
}

function performType(request, opts) {
  // System Events types the literal text into the frontmost application.
  const source = applescriptSource([
    'tell application "System Events"',
    `keystroke "${escapeAppleScriptString(request.text)}"`,
    'end tell',
  ])
  return run(OSASCRIPT, ['-e', source], opts).then(() => ({ ok: true }))
}

function performKey(request, opts) {
  const clause = modifierClause(request.modifiers)
  let statement
  if (request.special !== undefined) {
    const code = KEY_CODES[request.special]
    if (code === undefined) {
      throw new Error(`${ERROR_PREFIX} UNSUPPORTED_KEY: "${request.special}" has no macOS mapping (unsupported: capslock, insert, f21-f24)`)
    }
    statement = `key code ${String(code)}${clause}`
  } else {
    statement = `keystroke "${escapeAppleScriptString(request.char)}"${clause}`
  }
  const source = applescriptSource(['tell application "System Events"', statement, 'end tell'])
  return run(OSASCRIPT, ['-e', source], opts).then(() => ({ ok: true }))
}

async function performJxa(request, opts) {
  const source = await readFile(JXA_SOURCE, 'utf8')
  const result = await run(OSASCRIPT, ['-l', 'JavaScript', '-e', source], { ...opts, env: { CU_REQUEST: JSON.stringify(request) } })
  let parsed
  try {
    parsed = JSON.parse(result.stdout.trim())
  } catch {
    throw new Error(`${ERROR_PREFIX} JXA helper produced no valid response${result.stderr.trim() !== '' ? `: ${result.stderr.trim().slice(-300)}` : ''}`)
  }
  if (parsed.ok === false) throw new Error(`${ERROR_PREFIX} ${parsed.message ?? parsed.code ?? 'helper failed'}`)
  return parsed
}

export async function perform(request, opts) {
  switch (request.action) {
    case 'screenshot': return performScreenshot(request, opts)
    case 'type': return performType(request, opts)
    case 'key': return performKey(request, opts)
    case 'click':
    case 'scroll':
    case 'drag': return performJxa(request, opts)
    default:
      throw new Error(`${ERROR_PREFIX} BAD_ACTION: unknown action "${request.action}"`)
  }
}
