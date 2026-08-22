// dsh-computer-use native helper (macOS input actions).
//
// Runs under: /usr/bin/osascript -l JavaScript -e <this source>
// The request arrives as JSON in the CU_REQUEST environment variable; the
// response is the script's final expression (one JSON line on stdout).
// osascript prints console.log to stderr, so stdout must carry ONLY this
// final value - the Node side parses it strictly.
//
// Mouse and wheel events post through the CoreGraphics event bridge
// (ObjC.bindFunction); coordinates arrive in full-screen screenshot pixels
// and are divided by the main screen's backing scale factor because CGEvent
// mouse positions are logical points. Posting events to other applications
// requires the Accessibility permission for the host app.
//
// Keep this file pure ASCII (osascript sources have no encoding contract).

ObjC.import('Foundation')
ObjC.import('AppKit')
ObjC.import('CoreGraphics')

// CGEventType / CGMouseButton / tap / scroll-unit constants (CoreGraphics).
var kCGEventMouseMoved = 5
var kCGEventLeftMouseDown = 1
var kCGEventLeftUp = 2
var kCGEventRightMouseDown = 3
var kCGEventRightUp = 4
var kCGEventOtherMouseDown = 25
var kCGEventOtherUp = 26
var kCGEventLeftDragged = 6
var kCGMouseButtonLeft = 0
var kCGMouseButtonRight = 1
var kCGMouseButtonCenter = 2
var kCGSessionEventTap = 1
var kCGScrollEventUnitLine = 1
var kCGMouseEventClickState = 1

ObjC.bindFunction('CGEventCreateMouseEvent', ['^v', 'i', 'point', 'i', 'id'])
ObjC.bindFunction('CGEventPost', ['i', 'id', 'void'])
ObjC.bindFunction('CGEventSetIntegerValueField', ['id', 'i', 'q', 'void'])
ObjC.bindFunction('CGEventCreateScrollWheelEvent', ['^v', 'i', 'i', 'i', 'id'])

var RESPONSE = 'no response produced'

function respond(obj) { RESPONSE = JSON.stringify(obj) }
function fail(code, message) { respond({ ok: false, code: code, message: message }) }
function sleep(seconds) { $.NSThread.sleepForSeconds(seconds) }

function backingScale() {
  var factor = NSScreen.mainScreen.backingScaleFactor
  if (factor === undefined || factor < 1) return 1
  return factor
}
function toLogical(px) { return px / backingScale() }

function mouseEvent(type, x, y, button) {
  return $.CGEventCreateMouseEvent($(), type, { x: x, y: y }, button)
}
function post(event) { $.CGEventPost(kCGSessionEventTap, event) }

function buttonPair(name) {
  if (name === 'right') return [kCGEventRightMouseDown, kCGEventRightUp, kCGMouseButtonRight]
  if (name === 'middle') return [kCGEventOtherMouseDown, kCGEventOtherUp, kCGMouseButtonCenter]
  return [kCGEventLeftMouseDown, kCGEventLeftUp, kCGMouseButtonLeft]
}

function doClick(req) {
  var x = toLogical(req.x)
  var y = toLogical(req.y)
  var pair = buttonPair(req.button)
  post(mouseEvent(kCGEventMouseMoved, x, y, 0))
  sleep(0.03)
  for (var i = 1; i <= req.count; i++) {
    // Real double/triple clicks carry an increasing click state so the
    // receiving app counts them instead of seeing separate clicks.
    var down = mouseEvent(pair[0], x, y, pair[2])
    $.CGEventSetIntegerValueField(down, kCGMouseEventClickState, i)
    post(down)
    sleep(0.02)
    var up = mouseEvent(pair[1], x, y, pair[2])
    $.CGEventSetIntegerValueField(up, kCGMouseEventClickState, i)
    post(up)
    if (i < req.count) sleep(0.06)
  }
}

function doScroll(req) {
  if (req.direction === 'left' || req.direction === 'right') {
    fail('UNSUPPORTED_ACTION', 'horizontal scrolling is not supported on macOS in this version; use keyboard navigation or vertical scroll instead')
    return
  }
  // Positive line deltas scroll content up.
  var lines = req.direction === 'down' ? -req.amount : req.amount
  var event = $.CGEventCreateScrollWheelEvent($(), kCGScrollEventUnitLine, 1, lines)
  post(event)
  sleep(0.05)
}

function doDrag(req) {
  var startX = toLogical(req.startX)
  var startY = toLogical(req.startY)
  var endX = toLogical(req.endX)
  var endY = toLogical(req.endY)
  post(mouseEvent(kCGEventMouseMoved, startX, startY, 0))
  sleep(0.06)
  var down = mouseEvent(kCGEventLeftMouseDown, startX, startY, kCGMouseButtonLeft)
  $.CGEventSetIntegerValueField(down, kCGMouseEventClickState, 1)
  post(down)
  sleep(0.08)
  var steps = 20
  for (var i = 1; i <= steps; i++) {
    var t = i / steps
    post(mouseEvent(kCGEventLeftDragged,
      startX + (endX - startX) * t,
      startY + (endY - startY) * t,
      kCGMouseButtonLeft))
    sleep(Math.max(0.005, req.durationMs / steps / 1000))
  }
  sleep(0.06)
  post(mouseEvent(kCGEventLeftUp, endX, endY, kCGMouseButtonLeft))
}

function dispatch(req) {
  switch (req.action) {
    case 'click': doClick(req); break
    case 'scroll': doScroll(req); break
    case 'drag': doDrag(req); break
    default:
      fail('BAD_ACTION', "action '" + String(req.action) + "' does not run through the JXA helper")
      return false
  }
  return true
}

try {
  var raw = $.NSProcessInfo.processInfo.environment.objectForKey('CU_REQUEST')
  var missing = raw === undefined || (raw.isNil !== undefined && raw.isNil())
  if (missing) {
    fail('BAD_REQUEST', 'CU_REQUEST environment variable is missing')
  } else {
    var req = JSON.parse(ObjC.deepUnbind(raw))
    if (dispatch(req) !== false) respond({ ok: true })
  }
} catch (e) {
  fail('ACTION_FAILED', String(e))
}
