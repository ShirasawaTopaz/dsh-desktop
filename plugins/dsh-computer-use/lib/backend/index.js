/**
 * dsh-computer-use plugin — platform dispatch.
 *
 * The three backends share one contract:
 *
 *   probe()                    -> { available: boolean, reason?: string }
 *   bounds({timeoutMs})        -> { width, height }  full-screen screenshot pixels
 *   perform(request, {timeoutMs, signal}) -> response object; throws
 *                                 `[computer-use] …` errors on failure
 *
 * Requests and responses are plain JSON-able objects. All coordinates that
 * cross the boundary are full-screen screenshot pixels — the same space as
 * the images `computer_screenshot` returns — and each backend maps them to
 * its native input coordinate system internally (Windows: physical pixels,
 * identity; macOS: divided by the Retina backing scale inside the JXA
 * helper; Linux X11: identity).
 */

import * as win32 from './win32.js'
import * as darwin from './darwin.js'
import * as linux from './linux.js'

const IMPLS = { win32, darwin, linux }

/** Probe results are stable for the process lifetime; cache per platform. */
const probeCache = new Map()

/** Screen size changes mid-session are rare; cache bounds per platform. */
const boundsCache = new Map()

export function platformKey(platform = process.platform) {
  return IMPLS[platform] === undefined ? 'unsupported' : platform
}

export async function probe(platform = process.platform) {
  if (probeCache.has(platform)) return probeCache.get(platform)
  let result
  try {
    const impl = IMPLS[platform]
    result = impl === undefined
      ? { available: false, reason: `platform "${platform}" is not supported by computer-use (win32, darwin, or linux only)` }
      : await impl.probe()
  } catch (error) {
    result = { available: false, reason: `platform probe failed: ${error.message}` }
  }
  probeCache.set(platform, result)
  return result
}

export async function bounds({ timeoutMs, signal } = {}, platform = process.platform) {
  if (boundsCache.has(platform)) return boundsCache.get(platform)
  const impl = IMPLS[platform]
  if (impl === undefined) throw new Error(`[computer-use] no backend for platform "${platform}"`)
  const value = await impl.bounds({ timeoutMs, signal })
  boundsCache.set(platform, value)
  return value
}

export async function perform(request, opts = {}, platform = process.platform) {
  const impl = IMPLS[platform]
  if (impl === undefined) throw new Error(`[computer-use] no backend for platform "${platform}"`)
  return impl.perform(request, opts)
}
