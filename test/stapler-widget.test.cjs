'use strict';

// The floating Stapler: the geometry main uses to keep the widget on screen
// and to grow/shrink it in place, the crop maths, and the message a batch of
// screenshots becomes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const W = loadTs('src/shared/staplerWidget.ts');

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 1280, height: 720 };

test('a drag in either direction is the same rectangle', () => {
  assert.deepEqual(W.normalizeDrag({ x: 10, y: 20 }, { x: 110, y: 70 }), { x: 10, y: 20, width: 100, height: 50 });
  assert.deepEqual(W.normalizeDrag({ x: 110, y: 70 }, { x: 10, y: 20 }), { x: 10, y: 20, width: 100, height: 50 });
});

test('a region scales to device pixels and is clipped to the image', () => {
  assert.deepEqual(W.scaleRect({ x: 10, y: 10, width: 100, height: 50 }, 2, { width: 4000, height: 2000 }), { x: 20, y: 20, width: 200, height: 100 });
  // Past the right edge: clipped, never negative.
  assert.deepEqual(W.scaleRect({ x: 1900, y: 0, width: 100, height: 10 }, 1, { width: 1920, height: 1080 }), { x: 1900, y: 0, width: 20, height: 10 });
  assert.deepEqual(W.scaleRect({ x: 2000, y: 0, width: 100, height: 10 }, 1, { width: 1920, height: 1080 }).width, 0);
});

test('a click is not a region', () => {
  assert.equal(W.isUsableRegion({ x: 0, y: 0, width: 2, height: 2 }), false);
  assert.equal(W.isUsableRegion({ x: 0, y: 0, width: 40, height: 4 }), true);
  assert.equal(W.isUsableRegion(null), false);
});

test('the default spot is the bottom-right corner of the work area, a margin in', () => {
  const size = W.WIDGET_SIZE.closed;
  const p = W.defaultWidgetPosition(primary, size);
  assert.deepEqual(p, { x: 1920 - size.width - W.WIDGET_MARGIN, y: 1040 - size.height - W.WIDGET_MARGIN });
});

test('a widget on a display stays there; one off every display comes home', () => {
  const size = W.WIDGET_SIZE.closed;
  // Inside the second display: untouched.
  assert.deepEqual(W.clampToDisplays({ x: 2000, y: 100, ...size }, [primary, second]), { x: 2000, y: 100 });
  // Hanging off the second display's bottom edge: pulled up.
  const low = W.clampToDisplays({ x: 2000, y: 700, ...size }, [primary, second]);
  assert.equal(low.y, 720 - size.height);
  // The monitor it lived on is gone: default corner of the primary.
  assert.deepEqual(W.clampToDisplays({ x: 2000, y: 100, ...size }, [primary]), W.defaultWidgetPosition(primary, size));
});

test('the ring grows toward the middle of the screen and shrinks back to the same corner', () => {
  const closed = W.WIDGET_SIZE.closed, open = W.WIDGET_SIZE.open;
  // Bottom-right face → ring keeps the bottom-right corner.
  const face = { x: 1800, y: 900, ...closed };
  const grown = W.expandedPosition(face, open, primary);
  assert.deepEqual(grown, { x: 1800 + closed.width - open.width, y: 900 + closed.height - open.height });
  const back = W.collapsedPosition({ ...grown, ...open }, closed, primary);
  assert.deepEqual(back, { x: face.x, y: face.y });
  // Top-left face → ring keeps the top-left corner.
  assert.deepEqual(W.expandedPosition({ x: 30, y: 30, ...closed }, open, primary), { x: 30, y: 30 });
});

test('screenshots go to the agent as the composer sends attachments', () => {
  const shots = [{ path: 'C:\\shots\\a.png', name: 'a.png' }, { path: 'C:\\shots\\b.png', name: 'b.png' }];
  assert.equal(W.shotsMessage('Look at the header', shots), 'Look at the header\n\nAttached files:\n- C:\\shots\\a.png (a.png)\n- C:\\shots\\b.png (b.png)');
  assert.equal(W.shotsMessage('  ', shots), 'Attached files:\n- C:\\shots\\a.png (a.png)\n- C:\\shots\\b.png (b.png)');
  assert.equal(W.shotsMessage('just words', []), 'just words');
  // Same block the queue composer writes.
  assert.match(read('src/renderer/src/components/MessageQueueComposer.tsx'), /'Attached files:\\n'/);
});

test('shot filenames sort and never collide within a second', () => {
  const now = new Date('2026-10-04T10:00:00Z');
  assert.equal(W.shotFilename(now, 0), 'shot-20261004100000.png');
  assert.equal(W.shotFilename(now, 2), 'shot-20261004100000-2.png');
});

test('the widget cannot open while Stapler is off, and the overlay is always protected', () => {
  const src = read('src/main/staplerWindow.ts');
  assert.match(src, /open\(\): \{ ok: boolean; error\?: string \} \{\s*if \(!this\.deps\.enabled\(\)\) return \{ ok: false/);
  assert.match(src, /overlay\.setContentProtection\(true\)/);
  // The widget must never be allowed to report recorder state as if it were the primary.
  assert.match(src, /if \(sw\.isWidgetSender\(e\.sender\)\) return;/);
});

test('the three locales carry the same staplerWidget keys', () => {
  const keys = (code) => Object.keys(JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`)).staplerWidget).sort();
  assert.deepEqual(keys('zh-CN'), keys('en'));
  assert.deepEqual(keys('ar'), keys('en'));
});
