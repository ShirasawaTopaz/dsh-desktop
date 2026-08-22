/**
 * Pure-function tests for the computer-use plugin. Zero dependencies:
 * `node --test plugins/dsh-computer-use/test/` from the repo root.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ERROR_PREFIX,
  clampInt,
  clampRect,
  escapeAppleScriptString,
  formatCombo,
  parseClickArgs,
  parseCrop,
  parseDragArgs,
  parseKeyCombo,
  parseScrollArgs,
  parseTypeArgs,
} from '../lib/args.js'
import { pngSize } from '../lib/backend/darwin.js'

test('parseCrop requires all four fields together', () => {
  assert.equal(parseCrop({}), undefined)
  assert.deepEqual(parseCrop({ x: 10, y: 20, width: 300, height: 200 }), { x: 10, y: 20, width: 300, height: 200 })
  assert.throws(() => parseCrop({ x: 1, y: 2, width: 3 }), /all four/)
  assert.throws(() => parseCrop({ x: 0.5, y: 0, width: 3, height: 4 }), /must be an integer/)
  assert.throws(() => parseCrop({ x: 0, y: 0, width: 0, height: 4 }), /between/)
})

test('clampRect intersects with display bounds', () => {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 }
  assert.deepEqual(clampRect({ x: -50, y: -50, width: 100, height: 100 }, bounds), { x: 0, y: 0, width: 50, height: 50 })
  assert.deepEqual(clampRect({ x: 1900, y: 1000, width: 500, height: 500 }, bounds), { x: 1900, y: 1000, width: 20, height: 80 })
  assert.deepEqual(clampRect({ x: 5000, y: 5000, width: 10, height: 10 }, bounds), { x: 1919, y: 1079, width: 1, height: 1 })
})

test('parseClickArgs validates and defaults', () => {
  assert.deepEqual(parseClickArgs({ x: 5, y: 6 }), { x: 5, y: 6, button: 'left', count: 1 })
  assert.deepEqual(parseClickArgs({ x: 5, y: 6, button: 'RIGHT', count: 9 }), { x: 5, y: 6, button: 'right', count: 3 })
  assert.throws(() => parseClickArgs({ x: 'a', y: 6 }), /x must be an integer/)
  assert.throws(() => parseClickArgs({ x: 1, y: 2, button: 'wheel' }), /button must be one of/)
})

test('parseScrollArgs validates direction and clamps amount', () => {
  assert.deepEqual(parseScrollArgs({ direction: 'down' }), { direction: 'down', amount: 3, x: undefined, y: undefined })
  assert.deepEqual(parseScrollArgs({ direction: 'up', amount: 99, x: 1, y: 2 }), { direction: 'up', amount: 25, x: 1, y: 2 })
  assert.throws(() => parseScrollArgs({ direction: 'sideways' }), /direction must be one of/)
  assert.throws(() => parseScrollArgs({}), /direction must be one of/)
})

test('parseTypeArgs refuses empty and oversized text', () => {
  assert.deepEqual(parseTypeArgs({ text: 'hi' }), { text: 'hi' })
  assert.throws(() => parseTypeArgs({ text: '' }), /non-empty/)
  assert.throws(() => parseTypeArgs({ text: ' '.repeat(20001) }), /split long input/)
})

test('parseKeyCombo normalizes aliases and orders modifiers', () => {
  assert.deepEqual(parseKeyCombo('ctrl+c'), { modifiers: ['ctrl'], char: 'c' })
  assert.deepEqual(parseKeyCombo('CTRL + ALT + DEL'), { modifiers: ['ctrl', 'alt'], special: 'delete' })
  assert.deepEqual(parseKeyCombo('cmd+space'), { modifiers: ['meta'], special: 'space' })
  assert.deepEqual(parseKeyCombo('enter'), { modifiers: [], special: 'enter' })
  assert.deepEqual(parseKeyCombo('esc'), { modifiers: [], special: 'escape' })
  assert.deepEqual(parseKeyCombo('pgdn'), { modifiers: [], special: 'pagedown' })
  assert.deepEqual(parseKeyCombo('f12'), { modifiers: [], special: 'f12' })
  assert.throws(() => parseKeyCombo('ctrl'), /unknown key "ctrl"/)
  assert.throws(() => parseKeyCombo('shift+ctrl+a+b'), /not a modifier/)
  assert.throws(() => parseKeyCombo(''), /non-empty combo/)
  assert.throws(() => parseKeyCombo('hyper+q'), /is not a modifier/)
})

test('formatCombo renders canonical spellings', () => {
  assert.equal(formatCombo(parseKeyCombo('cmd+space')), 'meta+space')
  assert.equal(formatCombo(parseKeyCombo('ctrl+alt+del')), 'ctrl+alt+delete')
  assert.equal(formatCombo(parseKeyCombo('F5')), 'f5')
})

test('escapeAppleScriptString escapes quotes and backslashes only', () => {
  assert.equal(escapeAppleScriptString('plain'), 'plain')
  assert.equal(escapeAppleScriptString('say "hi"'), 'say \\"hi\\"')
  assert.equal(escapeAppleScriptString('back\\slash'), 'back\\\\slash')
  assert.equal(escapeAppleScriptString('new\nline'), 'new\nline')
})

test('clampInt clamps both sides', () => {
  assert.equal(clampInt(-5, 0, 10), 0)
  assert.equal(clampInt(15, 0, 10), 10)
  assert.equal(clampInt(7, 0, 10), 7)
})

test('pngSize reads IHDR dimensions', () => {
  // Minimal PNG header: signature + IHDR length/type + 4-byte W + 4-byte H.
  const header = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(2880, 16)
  header.writeUInt32BE(1800, 20)
  assert.deepEqual(pngSize(header), { width: 2880, height: 1800 })
  const junk = Buffer.alloc(24, 7)
  assert.equal(pngSize(junk), undefined)
  assert.equal(pngSize(Buffer.alloc(0)), undefined)
})

test('error messages carry the plugin prefix', () => {
  try {
    parseTypeArgs({ text: '' })
    assert.fail('should have thrown')
  } catch (error) {
    assert.ok(error.message.startsWith(ERROR_PREFIX), error.message)
  }
})
