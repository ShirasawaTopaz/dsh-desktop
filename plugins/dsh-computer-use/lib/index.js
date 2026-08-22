/**
 * dsh-computer-use plugin — host half.
 *
 * Mounted through the wrapper's `--patch` overlay as a bare-name row
 * `dsh-computer-use` resolved from the staged `resources/dsh/node_modules`
 * tree via the profile module fallback (same path as the dsh-desktop
 * wrapper plugin). Registers:
 *
 *   - six model-facing tools: computer_screenshot, computer_click,
 *     computer_type, computer_key, computer_scroll, computer_drag;
 *   - one system-prompt section with usage guidance;
 *   - GET /api/computer-use/status — loopback-only diagnostics route that
 *     reports platform availability (the smoke test asserts it).
 *
 * Screenshots flow through the durable attachment store as ImageBlocks and
 * only register while that service is mounted; every mutating action gates
 * through ctx.approval unless approvalMode is 'none'. Actions run on the
 * user's real desktop by design: this plugin executes in the sidecar Node
 * process, outside any file sandbox, because that is the only way to reach
 * the actual screen.
 */

import z from '@deepseek-ai/schemastery'
import { ERROR_PREFIX } from './args.js'
import * as backend from './backend/index.js'
import {
  registerClickTool, registerDragTool, registerKeyTool, registerScrollTool, registerTypeTool,
} from './tools/actions.js'
import { registerScreenshotTool } from './tools/screenshot.js'

export const name = 'dsh-computer-use'

export const inject = ['tools', 'systemPrompt', 'webServer']

/** Runtime configuration schema (set per row under `config:` in a patch). */
export const Config = z.object({
  // Which actions ask through ctx.approval: 'mutations' (default) leaves
  // screenshots free and gates every input action; 'all' gates both;
  // 'none' acts without prompting.
  approvalMode: z.union(['mutations', 'all', 'none']).default('mutations'),
  actionTimeoutMs: z.number().default(10_000),
  screenshotTimeoutMs: z.number().default(20_000),
  jpegQuality: z.number().default(80),
})

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function loopbackForbidden(req, res) {
  const hostname = (req.headers.host ?? '').split(':')[0]
  if (!LOOPBACK_HOSTS.has(hostname)) {
    res.writeHead(403)
    res.end('forbidden')
    return true
  }
  return false
}

function assertPositiveInteger(label, value) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`computer-use: ${label} must be a positive integer`)
  if (label === 'jpegQuality' && value > 100) throw new Error('computer-use: jpegQuality must be 1-100')
}

function promptSection(approvalMode) {
  const gating = approvalMode === 'none'
    ? 'Actions run without per-action approval on this deployment.'
    : approvalMode === 'all'
      ? 'Every action including screenshots asks the user for approval.'
      : 'Screenshots are free but every mouse/keyboard action asks the user for approval first.'
  return [
    'Computer-use tools see and control this desktop.',
    '',
    'Workflow: computer_screenshot -> decide -> act -> computer_screenshot to verify. Never act blind:',
    '- Coordinates for click/scroll/drag are FULL-SCREEN PIXELS of the last screenshot\'s screen space;',
    '  when you capture a crop (x/y/width/height), convert crop-relative points back to full-screen pixels',
    '  before acting (the envelope shows both).',
    `- ${gating}`,
    'These tools drive the user\'s REAL desktop alongside them: keep actions minimal, exactly task-scoped,',
    'and never type into or close windows outside the task. Prefer keyboard shortcuts over precise clicking,',
    'and re-screenshot after each action instead of assuming it worked. If an action is refused, explain',
    'your intent to the user rather than retrying.',
  ].join('\n')
}

export function apply(ctx, config) {
  const resolved = config
  assertPositiveInteger('actionTimeoutMs', resolved.actionTimeoutMs)
  assertPositiveInteger('screenshotTimeoutMs', resolved.screenshotTimeoutMs)
  assertPositiveInteger('jpegQuality', resolved.jpegQuality)

  ctx.systemPrompt.section({
    name: 'tool:computer-use',
    order: 112,
    text: promptSection(resolved.approvalMode),
  })

  // Register once per attached scope so the screenshot tool exists exactly
  // while an attachment store is mounted (read_image's composition rule).
  ctx.inject(['attachments'], imageCtx => {
    registerScreenshotTool(imageCtx, resolved)
  })

  registerClickTool(ctx, resolved)
  registerTypeTool(ctx, resolved)
  registerKeyTool(ctx, resolved)
  registerScrollTool(ctx, resolved)
  registerDragTool(ctx, resolved)

  // Loopback-only diagnostics surface: what the smoke test (and a curious
  // user hitting it in a browser) can read without booting an agent.
  let statusCache
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/computer-use/status',
    handler: async (req, res) => {
      if (loopbackForbidden(req, res)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      if (statusCache === undefined) {
        try {
          statusCache = await backend.probe()
        } catch (error) {
          statusCache = { available: false, reason: String(error?.message ?? error) }
        }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(JSON.stringify({
        plugin: name,
        platform: process.platform,
        available: statusCache.available === true,
        ...(statusCache.reason !== undefined ? { reason: statusCache.reason } : {}),
      }))
    },
  }), 'dsh-computer-use: /api/computer-use/status route')
}
