/**
 * dsh-computer-use plugin — shared tool plumbing.
 *
 * Approval gating follows `@deepseek-ai/dsh-user-approval`: one
 * `approval/request` per mutating call, fail-closed when the service or an
 * answerer is missing, and a no-op only under the explicit `none` mode. The
 * image-route gate mirrors `dsh-tool-fs/read_image` so screenshots refuse
 * with the same vocabulary when the routed model cannot accept images.
 */

import { ERROR_PREFIX } from '../args.js'
import * as backend from '../backend/index.js'

/** Cooperative budget for the cheap bounds probe that precedes actions. */
export const BOUNDS_TIMEOUT_MS = 8000

/**
 * Refuse early when the platform backend is unavailable. Probe results are
 * cached per platform inside the backend module.
 */
export async function ensureAvailable() {
  const status = await backend.probe()
  if (!status.available) throw new Error(`${ERROR_PREFIX} ${status.reason}`)
}

/**
 * Gate one mutating action through the user-approval seam. `reason` is the
 * human-facing description shown in the approval prompt — make it say
 * exactly what is about to happen on the user's desktop.
 */
export async function requireApproval(ctx, approvalMode, exec, toolName, reason) {
  if (approvalMode === 'none') return
  if (exec.agent === undefined) {
    throw new Error(`${ERROR_PREFIX} cannot request approval outside a session; refusing to touch the desktop`)
  }
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error(`${ERROR_PREFIX} no approval service is mounted; refusing to touch the desktop`)
  }
  const outcome = await approval.request({
    agent: exec.agent,
    ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
    toolName,
    reason,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`${ERROR_PREFIX} 用户未批准此次操作 (${outcome})；不要重试同一动作，先向用户说明意图`)
  }
}

/**
 * Require the calling route's resolved model to declare image input, using
 * the exact gate shape `dsh-tool-fs` applies for `read_image`.
 */
export async function assertImageCapableRoute(ctx, exec, what) {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error(`${ERROR_PREFIX} cannot capture ${what}: the current model route could not be resolved`)
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(
      `${ERROR_PREFIX} cannot capture ${what}: model "${model}" does not declare image input; `
      + 'switch to an image-capable model to see screenshots')
  }
}

/** Model-facing envelope beside the screenshot image block. */
export function formatScreenshotEnvelope(value) {
  const cropped = value.screen.cropX !== 0 || value.screen.cropY !== 0
  const lines = [
    `<screen>${value.screen.width}x${value.screen.height} px</screen>`,
    ...(cropped ? [`<crop>origin (${value.screen.cropX}, ${value.screen.cropY}), size ${value.image.width}x${value.image.height} px</crop>`] : []),
    `<coords>All computer_* tool coordinates are full-screen pixels within the ${value.screen.width}x${value.screen.height} screen above.</coords>`,
  ]
  return lines.join('\n')
}

/** Screenshot content blocks: envelope text plus the image itself. */
export function screenshotContent(value) {
  return [
    { type: 'text', text: formatScreenshotEnvelope(value) },
    {
      type: 'image',
      attachment: {
        attachmentId: value.image.attachmentId,
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
      },
    },
  ]
}

/** Clamp a coordinate pair into the display rect (inclusive edges). */
export function clampPoint(x, y, bounds) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  return { x: clamp(Math.round(x), 0, bounds.width - 1), y: clamp(Math.round(y), 0, bounds.height - 1) }
}
