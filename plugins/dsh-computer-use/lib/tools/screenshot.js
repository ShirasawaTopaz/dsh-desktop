/**
 * dsh-computer-use plugin — the `computer_screenshot` tool.
 *
 * Registered only while an attachment store is mounted (the image rides a
 * durable `ImageBlock`, exactly like `dsh-tool-fs`'s `read_image`). Under
 * `approvalMode: 'all'` even screenshots ask; the default `'mutations'`
 * lets them run freely, matching how file reads are treated.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { ERROR_PREFIX, clampRect, parseCrop } from '../args.js'
import * as backend from '../backend/index.js'
import {
  BOUNDS_TIMEOUT_MS, assertImageCapableRoute, ensureAvailable, requireApproval, screenshotContent,
} from './shared.js'

const EXTENSION_BY_MEDIA_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpg' }

export function registerScreenshotTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'computer_screenshot',
    description: 'Capture the primary display and return the image itself. Requires the current model to accept '
      + 'image input. All other computer_* tools take coordinates as full-screen pixels of this captured space; '
      + 'pass x/y/width/height to capture only a region (useful when the full screen is too large).',
    parameters: {
      x: { type: 'number', description: 'Crop origin X in full-screen pixels. Only with y/width/height together.' },
      y: { type: 'number', description: 'Crop origin Y in full-screen pixels.' },
      width: { type: 'number', description: 'Crop width in pixels.' },
      height: { type: 'number', description: 'Crop height in pixels.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          image: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
          screen: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              cropX: { type: 'integer', required: true },
              cropY: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => screenshotContent(value),
    },
    timeoutMs: config.screenshotTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await ensureAvailable()
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error(`${ERROR_PREFIX} no attachment service is mounted; screenshots cannot be returned`)
      }
      if (config.approvalMode === 'all') {
        await requireApproval(ctx, config.approvalMode, exec, 'computer_screenshot', '截取屏幕画面（screenshot）')
      }
      await assertImageCapableRoute(ctx, exec, 'a screenshot')

      let crop = parseCrop(args)
      const bounds = await backend.bounds({ timeoutMs: BOUNDS_TIMEOUT_MS, signal: exec.signal })
      if (crop !== undefined) crop = clampRect(crop, { x: 0, y: 0, width: bounds.width, height: bounds.height })

      const maxBytes = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      const result = await backend.perform(
        { action: 'screenshot', region: crop, maxImageBytes: maxBytes, jpegQuality: config.jpegQuality },
        { timeoutMs: config.screenshotTimeoutMs, signal: exec.signal })

      const mediaType = result.mediaType
      if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`${ERROR_PREFIX} ${mediaType} screenshots are not accepted by this deployment`)
      }
      const extension = EXTENSION_BY_MEDIA_TYPE[mediaType] ?? 'png'
      const ref = await attachments.saveImage({
        data: Buffer.from(result.dataBase64, 'base64'),
        mediaType,
        name: `screenshot.${extension}`,
      })
      return {
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
        },
        screen: {
          width: result.screenW,
          height: result.screenH,
          cropX: result.cropX,
          cropY: result.cropY,
        },
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: args.x !== undefined ? `Screenshot (${args.x}, ${args.y})` : 'Screenshot full screen',
        kind: 'read',
      }
    },
  }))
}
