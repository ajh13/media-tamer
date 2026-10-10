import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const code = readFileSync(
  new URL('../../extensions/media-tamer/content.js', import.meta.url),
  'utf8',
);
function setup(t, html = '<video></video>') {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test' });
  t.after(() => dom.window.close());
  dom.window.eval(code);
  return dom.window;
}
function dispatch(win, target = win.document.body, key = '5', options = {}) {
  let reached = false;
  const listener = () => {
    reached = true;
  };
  win.addEventListener(options.type || 'keydown', listener);
  const ev = new win.KeyboardEvent(options.type || 'keydown', {
    key,
    bubbles: true,
    composed: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(ev);
  win.removeEventListener(options.type || 'keydown', listener);
  return { reached, defaultPrevented: ev.defaultPrevented };
}
for (const html of [
  '<input>',
  '<textarea></textarea>',
  '<select><option>5</option></select>',
  '<div contenteditable><span id="target"></span></div>',
  '<div contenteditable="plaintext-only"></div>',
  '<div role="textbox"></div>',
  '<div role="searchbox"></div>',
  '<div role="combobox"></div>',
  '<div role="spinbutton"></div>',
]) {
  test(`preserves editing in ${html}`, (t) => {
    const win = setup(t, '<video></video>' + html);
    const target = win.document.querySelector('#target') || win.document.body.lastElementChild;
    assert.equal(dispatch(win, target).reached, true);
  });
}
test('preserves document designMode', (t) => {
  const win = setup(t);
  win.document.designMode = 'on';
  assert.equal(dispatch(win).reached, true);
});
test('nested open shadow videos are detected immediately; shadow text fields still work', (t) => {
  const win = setup(t, '<div id="host"></div>');
  const root = win.document.querySelector('#host').attachShadow({ mode: 'open' });
  const host = win.document.createElement('div');
  root.append(host);
  const inner = host.attachShadow({ mode: 'open' });
  inner.innerHTML = '<video></video><input>';
  assert.equal(dispatch(win).reached, false);
  assert.equal(dispatch(win, inner.querySelector('input')).reached, true);
});
test('document_start can run without documentElement', (t) => {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.document.documentElement.remove();
  assert.doesNotThrow(() => dom.window.eval(code));
});
test('dynamic insert/remove is reflected synchronously', (t) => {
  const win = setup(t, '<div></div>');
  assert.equal(dispatch(win).reached, true);
  const video = win.document.createElement('video');
  win.document.body.append(video);
  assert.equal(dispatch(win).reached, false);
  video.remove();
  assert.equal(dispatch(win).reached, true);
});
for (const type of ['keydown', 'keypress', 'keyup'])
  test(`${type} blocks all digits including numpad, preserves non-digits and modifiers`, (t) => {
    const win = setup(t);
    for (const key of '0123456789')
      assert.equal(dispatch(win, undefined, key, { type, code: 'Numpad' + key }).reached, false);
    for (const key of ['f', ' ', 'ArrowRight', '.', ','])
      assert.equal(dispatch(win, undefined, key, { type }).reached, true);
    for (const mod of ['ctrlKey', 'altKey', 'shiftKey', 'metaKey', 'isComposing'])
      assert.equal(dispatch(win, undefined, '5', { type, [mod]: true }).reached, true);
  });
test('ordinary contentEditable=inherit is not treated as an editor', (t) => {
  const win = setup(t);
  win.document.body.contentEditable = 'inherit';
  assert.equal(dispatch(win).reached, false);
});
test('classic script loads and blocks body digits immediately before DOMContentLoaded', (t) => {
  const win = setup(t);
  assert.deepEqual(dispatch(win), { reached: false, defaultPrevented: false });
});
