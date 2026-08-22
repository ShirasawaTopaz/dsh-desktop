/**
 * dsh-computer-use plugin — Linux backend (X11 only).
 *
 * Input runs through `xdotool`, which executes chained commands inside a
 * single invocation (`mousemove … mousedown 1 … mouseup 1`), so drags never
 * interpolate model strings into a shell. Screenshots try the usual capture
 * tools in order and the PNG header supplies dimensions; oversize captures
 * refuse with a region hint instead of re-encoding (no JPEG tool assumed).
 *
 * Wayland sessions are detected up front and refused with an explanation:
 * xdotool cannot drive them, and every compositor screenshots differently.
 */

import { execFile } from 'node:child_process'
import { access, constants, readFile, rm } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { ERROR_PREFIX } from '../args.js'
import { pngSize } from './darwin.js'

const SCREENSHOT_CANDIDATES = [
  { name: 'gnome-screenshot', args: file => ['-f', file], regionArgs: null },
  { name: 'maim', args: file => [file], regionArgs: (rect, file) => [String(rect.x), String(rect.y), String(rect.width), String(rect.height), file] },
  { name: 'scrot', args: file => ['-o', file], regionArgs: (rect, file) => ['-a', `${rect.x},${rect.y},${rect.width},${rect.height}`, '-o', file] },
  { name: 'import', args: file => ['-window', 'root', file], regionArgs: (rect, file) => ['-window', 'root', '-crop', `${rect.width}x${rect.height}+${rect.x}+${rect.y}`, file] }, // ImageMagick
]

const execFileP = promisify(execFile)

/** Locate an executable on PATH without spawning anything. */
async function findInPath(name) {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(entry => entry !== '')
  for (const dir of dirs) {
    const full = join(dir, name)
    try {
      await access(full, constants.X_OK)
      return full
    } catch { /* keep scanning */ }
  }
  return undefined
}

function isWayland() {
  return process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY !== undefined
}

let screenshotTool

export async function probe() {
  if (isWayland()) {
    return {
      available: false,
      reason: 'this is a Wayland session; computer-use only supports X11 (xdotool cannot inject events into Wayland compositors)',
    }
  }
  if (process.env.DISPLAY === undefined) {
    return { available: false, reason: 'DISPLAY is not set; computer-use needs a running X11 session' }
  }
  if (await findInPath('xdotool') === undefined) {
    return { available: false, reason: 'xdotool was not found on PATH; install it (e.g. apt install xdotool) for keyboard and mouse control' }
  }
  for (const candidate of SCREENSHOT_CANDIDATES) {
    if (await findInPath(candidate.name) !== undefined) {
      screenshotTool = candidate
      break
    }
  }
  if (screenshotTool === undefined) {
    return {
      available: false,
      reason: 'no supported screenshot tool found (tried gnome-screenshot, maim, scrot, import); install one of them',
    }
  }
  return { available: true, reason: `input via xdotool, screenshots via ${screenshotTool.name}` }
}

/** Run xdotool with timeout + abort wiring. */
async function xdotool(args, { timeoutMs, signal } = {}) {
  const bin = await findInPath('xdotool')
  if (bin === undefined) throw new Error(`${ERROR_PREFIX} xdotool disappeared from PATH`)
  const options = { timeout: timeoutMs, killSignal: 'SIGKILL' }
  if (signal !== undefined) {
    if (signal.aborted) throw new Error(`${ERROR_PREFIX} action cancelled`)
    options.signal = signal
  }
  try {
    return await execFileP(bin, args.map(String), options)
  } catch (error) {
    if (signal?.aborted || error.killed || error.signal === 'SIGKILL') {
      throw new Error(`${ERROR_PREFIX} action cancelled or timed out`)
    }
    throw new Error(`${ERROR_PREFIX} xdotool failed (${String(error.message).slice(0, 200)})`)
  }
}

export async function bounds(opts) {
  // Prints "<width> <height>" for the default screen, in pixels.
  const result = await xdotool(['getdisplaygeometry'], opts)
  const match = /^(\d+)\s+(\d+)/.exec(result.stdout.trim())
  if (match === null) throw new Error(`${ERROR_PREFIX} could not parse display geometry from "${result.stdout.trim()}"`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** Map canonical special-key names to X keysym names xdotool expects. */
const KEYSYMS = {
  enter: 'Return', tab: 'Tab', escape: 'Escape', space: 'space',
  backspace: 'BackSpace', delete: 'Delete', insert: 'Insert',
  home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
  left: 'Left', right: 'Right', down: 'Down', up: 'Up',
  capslock: 'Caps_Lock',
}
for (let i = 1; i <= 24; i++) KEYSYMS[`f${i}`] = `F${i}`

const MODIFIER_KEYSYM = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super' }

async function performScreenshot(request, opts) {
  let tool = screenshotTool
  if (tool === undefined) {
    for (const candidate of SCREENSHOT_CANDIDATES) {
      if (await findInPath(candidate.name) !== undefined) { tool = candidate; screenshotTool = candidate; break }
    }
    if (tool === undefined) throw new Error(`${ERROR_PREFIX} CAPTURE_FAILED: no screenshot tool available`)
  }
  // Full-display size feeds the model-facing envelope even on crops.
  const display = await bounds(opts)
  const tmp = join(tmpdir(), `dsh-cu-shot-${randomUUID()}.png`)
  try {
    let args
    if (request.region !== undefined) {
      if (tool.regionArgs === null) {
        throw new Error(
          `${ERROR_PREFIX} CAPTURE_FAILED: ${tool.name} cannot crop to a region; install maim, scrot, or ImageMagick import `
          + 'for region screenshots, or retry without the crop parameters')
      }
      args = tool.regionArgs(request.region, tmp)
    } else {
      args = tool.args(tmp)
    }
    await execFileP(await findInPath(tool.name), args.map(String), {
      timeout: opts.timeoutMs,
      killSignal: 'SIGKILL',
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
    const bytes = await readFile(tmp)
    const size = pngSize(bytes.subarray(0, 32))
    if (size === undefined) {
      throw new Error(`${ERROR_PREFIX} CAPTURE_FAILED: ${tool.name} did not produce a PNG image`)
    }
    if (bytes.byteLength > request.maxImageBytes) {
      throw new Error(
        `${ERROR_PREFIX} TOO_LARGE: screenshot is ${bytes.byteLength} bytes, over the ${request.maxImageBytes} byte limit`
        + '; retry with a smaller region (x, y, width, height)')
    }
    return {
      ok: true,
      mediaType: 'image/png',
      dataBase64: bytes.toString('base64'),
      width: size.width,
      height: size.height,
      scale: 1,
      screenW: display.width,
      screenH: display.height,
      cropX: request.region !== undefined ? request.region.x : 0,
      cropY: request.region !== undefined ? request.region.y : 0,
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

async function performClick(request, opts) {
  const button = { left: 1, middle: 2, right: 3 }[request.button] ?? 1
  await xdotool(['mousemove', request.x, request.y], opts)
  await xdotool(['click', '--repeat', request.count, button], opts)
  return { ok: true }
}

async function performType(request, opts) {
  // Text rides as its own argv element after "--"; xdotool types it verbatim.
  await xdotool(['type', '--delay', '12', '--', request.text], opts)
  return { ok: true }
}

async function performKey(request, opts) {
  const tokens = []
  for (const modifier of request.modifiers ?? []) {
    const keysym = MODIFIER_KEYSYM[modifier]
    if (keysym === undefined) throw new Error(`${ERROR_PREFIX} BAD_KEY: unknown modifier "${modifier}"`)
    tokens.push(keysym)
  }
  if (request.special !== undefined) {
    const keysym = KEYSYMS[request.special]
    if (keysym === undefined) throw new Error(`${ERROR_PREFIX} UNSUPPORTED_KEY: "${request.special}" has no X keysym mapping`)
    tokens.push(keysym)
  } else {
    tokens.push(request.char)
  }
  await xdotool(['key', '--clearmodifiers', ...tokens], opts)
  return { ok: true }
}

async function performScroll(request, opts) {
  const buttons = { up: 4, down: 5, left: 6, right: 7 }
  const button = buttons[request.direction]
  if (request.x !== undefined && request.y !== undefined) {
    await xdotool(['mousemove', request.x, request.y], opts)
  }
  await xdotool(['click', '--repeat', request.amount, button], opts)
  return { ok: true }
}

async function performDrag(request, opts) {
  const steps = 20
  const args = ['mousemove', request.startX, request.startY, 'mousedown', 1]
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const x = Math.round(request.startX + (request.endX - request.startX) * t)
    const y = Math.round(request.startY + (request.endY - request.startY) * t)
    args.push('mousemove', x, y)
  }
  args.push('mouseup', 1)
  await xdotool(args, opts)
  return { ok: true }
}

export async function perform(request, opts) {
  switch (request.action) {
    case 'screenshot': return performScreenshot(request, opts)
    case 'click': return performClick(request, opts)
    case 'type': return performType(request, opts)
    case 'key': return performKey(request, opts)
    case 'scroll': return performScroll(request, opts)
    case 'drag': return performDrag(request, opts)
    default:
      throw new Error(`${ERROR_PREFIX} BAD_ACTION: unknown action "${request.action}"`)
  }
}
