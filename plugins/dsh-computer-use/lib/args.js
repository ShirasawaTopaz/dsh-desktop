/**
 * dsh-computer-use plugin — argument parsing and validation pure functions.
 *
 * Everything here is side-effect free and platform independent so the
 * `test/args.test.js` suite can exercise it on any machine. Error messages
 * are model-facing: they always carry the `[computer-use]` prefix and say
 * what a correct call looks like, mirroring the structured-refusal style of
 * the shipped `dsh-tool-*` packages.
 */

export const ERROR_PREFIX = '[computer-use]'

/** Raise a model-facing validation error. */
export function invalid(message) {
  throw new Error(`${ERROR_PREFIX} ${message}`)
}

/** Whether `value` is an integer (not merely a finite number). */
function isInteger(value) {
  return typeof value === 'number' && Number.isInteger(value)
}

/** Require an integer coordinate within `[min, max]`; `name` feeds the error text. */
export function requireInt(name, value, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (!isInteger(value)) invalid(`${name} must be an integer, got ${JSON.stringify(value)}`)
  if (value < min || value > max) invalid(`${name} must be between ${min} and ${max}, got ${value}`)
  return value
}

/** Clamp an integer into `[min, max]`. */
export function clampInt(value, min, max) {
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * Validate the four optional screenshot crop fields into a rect or undefined.
 * Absent everywhere means full screen; all four must be present together.
 * Coordinates are validated against the captured display bounds afterwards
 * (see clampRect), so only sign/shape checks happen here.
 * @returns `{x,y,width,height}` or `undefined`.
 */
export function parseCrop(args) {
  const keys = ['x', 'y', 'width', 'height']
  const present = keys.filter(key => args[key] !== undefined)
  if (present.length === 0) return undefined
  if (present.length !== keys.length) {
    invalid(`crop requires all four of x, y, width, height together (got only: ${present.join(', ')})`)
  }
  for (const key of ['x', 'y']) requireInt(key, args[key], -100000, 100000)
  for (const key of ['width', 'height']) requireInt(key, args[key], 1, 100000)
  return { x: args.x, y: args.y, width: args.width, height: args.height }
}

/** Clamp a crop rect into display bounds, preserving area intersection.
 *  Edges collapse onto the last VALID pixel (width/height minus one) so a
 *  fully-out-of-screen rect degrades to a 1x1 capture at the corner instead
 *  of an off-screen coordinate. */
export function clampRect(rect, bounds) {
  const maxX = bounds.x + bounds.width - 1
  const maxY = bounds.y + bounds.height - 1
  const x0 = clampInt(rect.x, bounds.x, maxX)
  const y0 = clampInt(rect.y, bounds.y, maxY)
  const x1 = clampInt(rect.x + rect.width - 1, bounds.x, maxX)
  const y1 = clampInt(rect.y + rect.height - 1, bounds.y, maxY)
  return { x: x0, y: y0, width: Math.max(1, x1 - x0 + 1), height: Math.max(1, y1 - y0 + 1) }
}

/** Mouse buttons accepted by computer_click. */
export const MOUSE_BUTTONS = ['left', 'right', 'middle']

/** Validate click parameters; coordinates are pixels in the last returned screenshot. */
export function parseClickArgs(args) {
  const x = requireInt('x', args.x, -100000, 100000)
  const y = requireInt('y', args.y, -100000, 100000)
  let button = args.button ?? 'left'
  if (typeof button === 'string') button = button.toLowerCase()
  if (!MOUSE_BUTTONS.includes(button)) invalid(`button must be one of ${MOUSE_BUTTONS.join('|')}, got ${JSON.stringify(args.button)}`)
  let count = args.count ?? 1
  if (!isInteger(count)) invalid(`count must be an integer, got ${JSON.stringify(args.count)}`)
  count = clampInt(count, 1, 3)
  return { x, y, button, count }
}

/** Scroll directions accepted by computer_scroll. */
export const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right']

/** Validate scroll parameters; x/y optionally position the cursor first. */
export function parseScrollArgs(args) {
  let direction = args.direction
  if (typeof direction === 'string') direction = direction.toLowerCase()
  if (!SCROLL_DIRECTIONS.includes(direction)) invalid(`direction must be one of ${SCROLL_DIRECTIONS.join('|')}, got ${JSON.stringify(args.direction)}`)
  let amount = args.amount ?? 3
  if (!isInteger(amount)) invalid(`amount must be an integer, got ${JSON.stringify(args.amount)}`)
  amount = clampInt(amount, 1, 25)
  let x
  let y
  if (args.x !== undefined || args.y !== undefined) {
    x = requireInt('x', args.x, -100000, 100000)
    y = requireInt('y', args.y, -100000, 100000)
  }
  return { direction, amount, x, y }
}

/** Validate type parameters; empty text is refused (a no-op call is a bug). */
export function parseTypeArgs(args) {
  if (typeof args.text !== 'string' || args.text.length === 0) invalid('text must be a non-empty string')
  if (args.text.length > 20000) invalid(`text is ${args.text.length} characters; split long input into multiple calls (max 20000)`)
  return { text: args.text }
}

/** Validate drag parameters; durationMs clamps to a sane band. */
export function parseDragArgs(args) {
  const startX = requireInt('startX', args.startX, -100000, 100000)
  const startY = requireInt('startY', args.startY, -100000, 100000)
  const endX = requireInt('endX', args.endX, -100000, 100000)
  const endY = requireInt('endY', args.endY, -100000, 100000)
  let durationMs = args.durationMs ?? 500
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) invalid(`durationMs must be a number, got ${JSON.stringify(args.durationMs)}`)
  durationMs = clampInt(Math.round(durationMs), 50, 5000)
  return { startX, startY, endX, endY, durationMs }
}

/** Modifier names accepted inside key combos (model-facing spellings). */
export const KEY_MODIFIERS = ['ctrl', 'alt', 'shift', 'meta']

/** Common model spellings for meta (Windows key / Cmd / Super). */
const MODIFIER_ALIASES = {
  win: 'meta',
  windows: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
}

/**
 * Special key vocabulary shared by every backend. Aliases normalize common
 * model spellings; the canonical name is what backends switch on.
 */
const SPECIAL_KEY_ALIASES = {
  return: 'enter',
  esc: 'escape',
  del: 'delete',
  ins: 'insert',
  pgup: 'pageup',
  pagedn: 'pagedown',
  pgdn: 'pagedown',
  spacebar: 'space',
  win: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  leftarrow: 'left',
  rightarrow: 'right',
  uparrow: 'up',
  downarrow: 'down',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  capslk: 'capslock',
}

export const SPECIAL_KEYS = new Set([
  'enter', 'tab', 'escape', 'space', 'backspace', 'delete', 'insert',
  'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right',
  'capslock',
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
])

/**
 * Parse one key combo like "ctrl+shift+t", "enter", or "cmd+space" into
 * `{modifiers:[...], special?:'enter'|..., char?:'t'}`. Modifiers dedupe and
 * sort canonically; the terminal token is either a known special key, a
 * single character (letter/digit/punctuation), or an error.
 */
export function parseKeyCombo(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') invalid('key must be a non-empty combo string like "ctrl+c" or "enter"')
  const tokens = raw.split('+').map(token => token.trim().toLowerCase()).filter(token => token !== '')
  if (tokens.length === 0) invalid(`key ${JSON.stringify(raw)} parses to no tokens`)
  const modifiers = []
  for (const token of tokens.slice(0, -1)) {
    const canonical = MODIFIER_ALIASES[token] ?? token
    if (!KEY_MODIFIERS.includes(canonical)) {
      invalid(`key ${JSON.stringify(raw)}: "${token}" is not a modifier (use ctrl|alt|shift|meta); only the final token may be a regular key`)
    }
    if (!modifiers.includes(canonical)) modifiers.push(canonical)
  }
  // Canonical modifier order so backend dispatch and error text are stable.
  modifiers.sort((a, b) => KEY_MODIFIERS.indexOf(a) - KEY_MODIFIERS.indexOf(b))
  const last = tokens[tokens.length - 1]
  const aliased = SPECIAL_KEY_ALIASES[last] ?? last
  if (SPECIAL_KEYS.has(aliased)) return { modifiers, special: aliased }
  if (last.length === 1) return { modifiers, char: last }
  invalid(`key ${JSON.stringify(raw)}: unknown key "${last}"; use a single character, f1-f24, or one of ${[...SPECIAL_KEYS].filter(name => !/^f\d+$/.test(name)).join(', ')}`)
}

/** Rebuild the canonical combo spelling for prompts, results, and tests. */
export function formatCombo(combo) {
  const parts = [...combo.modifiers]
  if (combo.special !== undefined) parts.push(combo.special)
  else parts.push(combo.char)
  return parts.join('+')
}

/**
 * Escape an arbitrary string for safe embedding inside a double-quoted
 * AppleScript string literal. Backslash and double quote are escaped; other
 * characters pass through (AppleScript string literals are byte-transparent
 * beyond those two). Control characters the model may emit (\n, \t, \r) are
 * fine inside literals — only quote/backslash terminate or escape.
 */
export function escapeAppleScriptString(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

