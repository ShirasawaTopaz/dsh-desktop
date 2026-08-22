/**
 * dsh-computer-use plugin — the five mutating desktop-action tools.
 *
 * click / type / key / scroll / drag share one shape:
 *
 *   1. `describe(args)` validates cheaply and yields the human-readable
 *      approval reason (what the user sees before consenting);
 *   2. the call gates through ctx.approval unless approvalMode is 'none';
 *   3. `build(args, bounds)` re-validates, clamps every coordinate into the
 *      display rect, and produces the backend request plus canonical value;
 *   4. the backend executes and the value renders as one readable line.
 *
 * All five declare exclusive concurrency so the tool runtime serializes
 * them against each other and against screenshots.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { ERROR_PREFIX, MOUSE_BUTTONS, SCROLL_DIRECTIONS, clampInt, formatCombo, parseClickArgs, parseDragArgs, parseKeyCombo, parseScrollArgs, parseTypeArgs } from '../args.js'
import * as backend from '../backend/index.js'
import { BOUNDS_TIMEOUT_MS, clampPoint, ensureAvailable, requireApproval } from './shared.js'

const BUTTON_LABEL = { left: '左键', right: '右键', middle: '中键' }
const DIRECTION_LABEL = { up: '向上', down: '向下', left: '向左', right: '向右' }

/**
 * Shared registration body. Tool budgets leave room for the bounds probe
 * plus helper startup on top of the per-action helper budget.
 */
function registerAction(ctx, config, spec) {
  ctx.tools.register(defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: spec.schema,
      render: (_args, value) => [{ type: 'text', text: spec.render(value) }],
    },
    timeoutMs: config.actionTimeoutMs + BOUNDS_TIMEOUT_MS + 5000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await ensureAvailable()
      const described = spec.describe(args)
      await requireApproval(ctx, config.approvalMode, exec, spec.name, described.reason)
      const bounds = described.needsBounds
        ? await backend.bounds({ timeoutMs: BOUNDS_TIMEOUT_MS, signal: exec.signal })
        : undefined
      const built = spec.build(args, bounds)
      await backend.perform(
        { action: spec.action, ...built.request },
        { timeoutMs: config.actionTimeoutMs, signal: exec.signal })
      return built.value
    },
    presentCall(args) {
      try {
        return { card: 'generic', title: spec.describe(args).reason, kind: 'generic' }
      } catch {
        return { card: 'generic', title: spec.title, kind: 'generic' }
      }
    },
  }))
}

export function registerClickTool(ctx, config) {
  registerAction(ctx, config, {
    name: 'computer_click',
    title: 'Mouse click',
    description: 'Move the mouse to full-screen pixel coordinates and click. Coordinates refer to the screen space '
      + 'of the last computer_screenshot capture; take a screenshot first if none exists.',
    parameters: {
      x: { type: 'number', required: true, description: 'Target X in full-screen pixels.' },
      y: { type: 'number', required: true, description: 'Target Y in full-screen pixels.' },
      button: { type: 'string', enum: [...MOUSE_BUTTONS], description: 'Mouse button. Defaults to left.' },
      count: { type: 'number', description: '1 single, 2 double, 3 triple click. Defaults to 1.' },
    },
    describe(args) {
      const parsed = parseClickArgs(args)
      const repeat = parsed.count === 2 ? '双击' : parsed.count === 3 ? '三击' : '单击'
      return { reason: `在 (${parsed.x}, ${parsed.y}) ${BUTTON_LABEL[parsed.button]}${repeat}`, needsBounds: true }
    },
    build(args, bounds) {
      const parsed = parseClickArgs(args)
      const point = clampPoint(parsed.x, parsed.y, bounds ?? { width: 100000, height: 100000 })
      return {
        request: { x: point.x, y: point.y, button: parsed.button, count: parsed.count },
        value: { action: 'click', x: point.x, y: point.y, button: parsed.button, count: parsed.count },
      }
    },
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', required: true },
        x: { type: 'integer', required: true },
        y: { type: 'integer', required: true },
        button: { type: 'string', required: true },
        count: { type: 'integer', required: true },
      },
    },
    render(value) {
      const repeat = value.count > 1 ? ` ×${String(value.count)}` : ''
      return `Clicked ${value.button}${repeat} at (${String(value.x)}, ${String(value.y)})`
    },
  })
}

export function registerTypeTool(ctx, config) {
  registerAction(ctx, config, {
    name: 'computer_type',
    title: 'Keyboard typing',
    description: 'Type literal text into the focused window via the keyboard (Unicode path; newlines become Enter). '
      + 'Focus the right input first, e.g. by clicking it.',
    parameters: {
      text: { type: 'string', required: true, description: 'The exact text to type.' },
    },
    describe(args) {
      const { text } = parseTypeArgs(args)
      const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text
      return { reason: `向焦点窗口键入文本：${preview}`, needsBounds: false }
    },
    build(args) {
      const { text } = parseTypeArgs(args)
      return {
        request: { text },
        value: { action: 'type', length: text.length },
      }
    },
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', required: true },
        length: { type: 'integer', required: true },
      },
    },
    render: value => `Typed ${String(value.length)} characters`,
  })
}

export function registerKeyTool(ctx, config) {
  registerAction(ctx, config, {
    name: 'computer_key',
    title: 'Key press',
    description: 'Press a key or chord such as "enter", "ctrl+c", "ctrl+shift+t", "cmd+space" (macOS), "alt+f4". '
      + 'Modifiers: ctrl|alt|shift|meta. Terminal keys: single characters, f1-f24, enter, tab, escape, space, '
      + 'backspace, delete, insert, home, end, pageup, pagedown, arrows, capslock.',
    parameters: {
      key: { type: 'string', required: true, description: 'Key combo with modifiers joined by "+" (e.g. "ctrl+c").' },
    },
    describe(args) {
      const combo = parseKeyCombo(args.key)
      return { reason: `按下组合键 ${formatCombo(combo)}`, needsBounds: false }
    },
    build(args) {
      const combo = parseKeyCombo(args.key)
      return {
        request: {
          modifiers: combo.modifiers,
          ...(combo.special !== undefined ? { special: combo.special } : {}),
          ...(combo.char !== undefined ? { char: combo.char } : {}),
        },
        value: { action: 'key', combo: formatCombo(combo) },
      }
    },
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', required: true },
        combo: { type: 'string', required: true },
      },
    },
    render: value => `Pressed ${value.combo}`,
  })
}

export function registerScrollTool(ctx, config) {
  registerAction(ctx, config, {
    name: 'computer_scroll',
    title: 'Scroll',
    description: 'Scroll at the current cursor position, or move the cursor to x/y first when both are given. '
      + 'Amount is wheel notches (default 3).',
    parameters: {
      direction: { type: 'string', enum: [...SCROLL_DIRECTIONS], required: true, description: 'Scroll direction.' },
      amount: { type: 'number', description: 'Notches to scroll (1-25). Defaults to 3.' },
      x: { type: 'number', description: 'Optional cursor X before scrolling (full-screen pixels).' },
      y: { type: 'number', description: 'Optional cursor Y before scrolling.' },
    },
    describe(args) {
      const parsed = parseScrollArgs(args)
      const at = parsed.x !== undefined && parsed.y !== undefined ? `在 (${parsed.x}, ${parsed.y}) ` : ''
      return { reason: `${at}${DIRECTION_LABEL[parsed.direction]}滚动 ${parsed.amount} 格`, needsBounds: parsed.x !== undefined }
    },
    build(args, bounds) {
      const parsed = parseScrollArgs(args)
      const request = { direction: parsed.direction, amount: parsed.amount }
      const value = { action: 'scroll', direction: parsed.direction, amount: parsed.amount }
      if (parsed.x !== undefined && parsed.y !== undefined) {
        const point = clampPoint(parsed.x, parsed.y, bounds ?? { width: 100000, height: 100000 })
        request.x = point.x
        request.y = point.y
        value.x = point.x
        value.y = point.y
      }
      return { request, value }
    },
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', required: true },
        direction: { type: 'string', required: true },
        amount: { type: 'integer', required: true },
        x: { type: 'integer' },
        y: { type: 'integer' },
      },
    },
    render(value) {
      const at = value.x !== undefined ? ` at (${String(value.x)}, ${String(value.y)})` : ''
      return `Scrolled ${value.direction} ${String(value.amount)}${at}`
    },
  })
}

export function registerDragTool(ctx, config) {
  registerAction(ctx, config, {
    name: 'computer_drag',
    title: 'Mouse drag',
    description: 'Press the left button at start, interpolate movement to end over durationMs, release. Coordinates '
      + 'are full-screen screenshot pixels.',
    parameters: {
      startX: { type: 'number', required: true, description: 'Drag origin X.' },
      startY: { type: 'number', required: true, description: 'Drag origin Y.' },
      endX: { type: 'number', required: true, description: 'Drag target X.' },
      endY: { type: 'number', required: true, description: 'Drag target Y.' },
      durationMs: { type: 'number', description: 'Movement duration in ms (50-5000). Defaults to 500.' },
    },
    describe(args) {
      const parsed = parseDragArgs(args)
      return {
        reason: `从 (${parsed.startX}, ${parsed.startY}) 拖拽到 (${parsed.endX}, ${parsed.endY})`,
        needsBounds: true,
      }
    },
    build(args, bounds) {
      const parsed = parseDragArgs(args)
      const fallback = { width: 100000, height: 100000 }
      const from = clampPoint(parsed.startX, parsed.startY, bounds ?? fallback)
      const to = clampPoint(parsed.endX, parsed.endY, bounds ?? fallback)
      return {
        request: { startX: from.x, startY: from.y, endX: to.x, endY: to.y },
        value: {
          action: 'drag',
          startX: from.x,
          startY: from.y,
          endX: to.x,
          endY: to.y,
          durationMs: clampInt(Math.round(parsed.durationMs), 50, 5000),
        },
      }
    },
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', required: true },
        startX: { type: 'integer', required: true },
        startY: { type: 'integer', required: true },
        endX: { type: 'integer', required: true },
        endY: { type: 'integer', required: true },
        durationMs: { type: 'integer', required: true },
      },
    },
    render: value =>
      `Dragged (${String(value.startX)}, ${String(value.startY)}) -> (${String(value.endX)}, ${String(value.endY)}) over ${String(value.durationMs)}ms`,
  })
}
