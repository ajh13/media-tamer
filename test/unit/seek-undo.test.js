import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const code = readFileSync(
  new URL('../../extensions/media-tamer/seek-undo.js', import.meta.url),
  'utf8',
);
function setup(t) {
  const dom = new JSDOM('<video></video><input><button>focus</button>', {
    runScripts: 'outside-only',
    url: 'https://example.test',
  });
  t.after(() => {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    dom.window.close();
  });
  const win = dom.window;
  let handler;
  win.browser = {
    runtime: {
      id: 'test-id',
      onMessage: {
        addListener(fn) {
          handler = fn;
        },
      },
    },
  };
  win.eval(code);
  const video = win.document.querySelector('video');
  const event = (type) => video.dispatchEvent(new win.Event(type));
  const message = (data, sender = { id: 'test-id' }) => Promise.resolve(handler(data, sender));
  return { win, video, event, message };
}
function makeSeek(ctx, from = 20, to = 80) {
  ctx.video.currentTime = from;
  ctx.event('timeupdate');
  ctx.event('play');
  ctx.video.currentTime = to;
  ctx.event('seeking');
  ctx.event('seeked');
}
function press(win, target, key = 'z', mods = { ctrlKey: true }) {
  const ev = new win.KeyboardEvent('keydown', {
    key,
    ...mods,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return ev.defaultPrevented;
}
test('Ctrl+Z undo is default and leaves native text undo alone', async (t) => {
  const ctx = setup(t);
  makeSeek(ctx);
  assert.equal(press(ctx.win, ctx.win.document.querySelector('input')), false);
  assert.equal(ctx.video.currentTime, 80);
  assert.equal(press(ctx.win, ctx.win.document.body), true);
  assert.equal(ctx.video.currentTime, 20);
  ctx.event('seeking');
  ctx.event('seeked');
  assert.equal(press(ctx.win, ctx.win.document.body), false);
});
test('trusted configurable keybind works, untrusted and invalid configs rejected', async (t) => {
  const ctx = setup(t);
  makeSeek(ctx);
  assert.equal(
    await ctx.message(
      { type: 'VC_SEEK_CONFIG', binding: { key: 'x', altKey: true } },
      { id: 'foreign' },
    ),
    undefined,
  );
  const changed = await ctx.message({
    type: 'VC_SEEK_CONFIG',
    binding: { key: 'x', ctrlKey: false, altKey: true, metaKey: false, shiftKey: false },
    enabled: true,
  });
  assert.equal(changed.binding.key, 'x');
  assert.equal(press(ctx.win, ctx.win.document.body), false);
  assert.equal(press(ctx.win, ctx.win.document.body, 'x', { altKey: true }), true);
  const bad = await ctx.message({ type: 'VC_SEEK_CONFIG', binding: { key: 3 } });
  assert.ok(bad.error);
});
test('classic content script accepts trusted runtime requests and records a real seek sequence', async (t) => {
  const { video, event, message } = setup(t);
  video.currentTime = 20;
  event('timeupdate');
  event('play');
  video.currentTime = 80;
  event('seeking');
  event('timeupdate');
  event('seeked');
  assert.equal((await message({ type: 'VC_SEEK_GET' })).historyCount, 1);
  const result = await message({ type: 'VC_SEEK_UNDO' });
  assert.equal(result.success, true);
  assert.equal(video.currentTime, 20);
  event('seeking');
  event('timeupdate');
  event('seeked');
  assert.equal(
    (await message({ type: 'VC_SEEK_GET' })).historyCount,
    0,
    'asynchronous undo events must not re-record undo',
  );
});
