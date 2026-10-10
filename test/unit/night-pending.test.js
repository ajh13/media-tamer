/**
 * TDD — pending night-mode state regression tests.
 *
 * Reproduces the bug: VC_NIGHT_SET with suspended AudioContext stores pending
 * strength, but VC_NIGHT_GET reports status=idle/active=false as if nothing
 * happened. Also verifies popup renders actionable message while pending.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_DIR = path.join(__dirname, '..', '..', 'extensions', 'media-tamer');
const VOLUME_JS = path.join(EXT_DIR, 'volume.js');
const NIGHT_MODE_JS = path.join(EXT_DIR, 'night-mode.js');
const POPUP_JS = path.join(EXT_DIR, 'popup.js');

const EXT_ID = 'media-tamer@example.invalid';

function createMockAudioContext(state = 'running', opts = {}) {
  const nodes = [];
  const param = (value = 1) => ({
    value,
    setTargetAtTime(v) {
      this.value = v;
    },
  });
  const ctx = {
    state,
    currentTime: 0,
    nodes,
    resumeCount: 0,
    createGain() {
      const n = {
        type: 'gain',
        gain: param(),
        edges: [],
        connect(x) {
          this.edges.push(x);
        },
        disconnect() {
          this.edges = [];
        },
      };
      nodes.push(n);
      return n;
    },
    createMediaElementSource(el) {
      const n = {
        type: 'source',
        element: el,
        edges: [],
        connect(x) {
          this.edges.push(x);
        },
        disconnect() {
          this.edges = [];
        },
      };
      nodes.push(n);
      return n;
    },
    createDynamicsCompressor() {
      const n = {
        type: 'compressor',
        threshold: param(),
        ratio: param(),
        knee: param(),
        attack: param(),
        release: param(),
        reduction: 0,
        edges: [],
        connect(x) {
          this.edges.push(x);
        },
        disconnect() {
          this.edges = [];
        },
      };
      nodes.push(n);
      return n;
    },
    destination: {
      type: 'destination',
      edges: [],
      connect(x) {
        this.edges.push(x);
      },
      disconnect() {
        this.edges = [];
      },
    },
    resume() {
      ctx.resumeCount++;
      if (opts.resumeLag)
        return new Promise((r) =>
          setTimeout(() => {
            state = 'running';
            r();
          }, opts.resumeLag),
        );
      if (state === 'suspended') state = 'running';
      return Promise.resolve();
    },
  };
  return ctx;
}

function loadNightMode() {
  const ctx = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(NIGHT_MODE_JS, 'utf8'), ctx);
  return vm.runInContext('VC_NIGHT_MODE', ctx);
}

function createEnv(opts = {}) {
  const extId = opts.extId || EXT_ID;
  const html = opts.html || '<!DOCTYPE html><html><body></body></html>';
  const audioState = opts.audioState || 'running';
  const dom = new JSDOM(html, {
    url: 'https://example.com/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  let messageListener = null;
  const mockAudioCtx = createMockAudioContext(audioState, opts);
  const runtime = {
    id: extId,
    onMessage: {
      addListener(fn) {
        messageListener = fn;
      },
    },
    sendMessage() {
      return Promise.resolve();
    },
  };
  const nightApi = opts.nightApi !== undefined ? opts.nightApi : loadNightMode();
  const context = {
    console: window.console,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    MutationObserver: window.MutationObserver,
    URL: window.URL,
    document: window.document,
    location: window.location,
    browser: { runtime },
    AudioContext: function AudioContext() {
      return mockAudioCtx;
    },
    VC_NIGHT_MODE: nightApi,
  };
  context.window = context;
  context.globalThis = context;
  context.global = context;

  // Mock event system on the vm "window" (the context itself) so interaction
  // listener can attach and we can dispatch synthetic events to drive the
  // trusted-gesture resume path.
  const eventListeners = new Map();
  context.addEventListener = function (type, listener, opts) {
    if (!eventListeners.has(type)) eventListeners.set(type, []);
    eventListeners.get(type).push({ listener, opts });
  };
  context.dispatchEvent = function (event) {
    const type = event.type;
    const listeners = eventListeners.get(type) || [];
    for (const { listener } of listeners) {
      try {
        listener(event);
      } catch (_) {}
    }
  };

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(VOLUME_JS, 'utf8'), context, { filename: 'volume.js' });
  if (document.readyState === 'loading')
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
  function send(msg, senderId) {
    return new Promise((resolve) => {
      if (!messageListener) {
        resolve(undefined);
        return;
      }
      let responded = false;
      const sendResponse = (resp) => {
        if (responded) return;
        responded = true;
        resolve(resp);
      };
      const sender = {
        id: senderId !== undefined ? senderId : extId,
        tab: { id: 1 },
        frameId: 0,
        url: 'https://example.com/',
      };
      try {
        const handled = messageListener(msg, sender, sendResponse);
        if (handled === true)
          setTimeout(() => {
            if (!responded) resolve(undefined);
          }, 100);
        else resolve(undefined);
      } catch (e) {
        resolve({ __error: String(e) });
      }
    });
  }
  // Dispatch events to the vm context (which has addEventListener from above)
  function dispatchEvent(type) {
    const event = { type, target: context, preventDefault() {}, stopPropagation() {} };
    context.dispatchEvent(event);
  }
  return { send, window, document, context, mockAudioCtx, dom, dispatchEvent };
}

function createPopupEnv(runtimeSendMessage) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body>' +
      '<div id="volume-status"></div><div id="volume-value"></div><input id="volume-slider" /><div id="volume-surface"></div>' +
      '<div id="speed-status"></div><div id="speed-value"></div><input id="speed-slider" /><div id="speed-surface"></div>' +
      '<div id="peaks-status"></div><div id="peaks-value"></div><input id="peaks-slider" /><div id="peaks-surface"></div>' +
      '<div id="seek-binding"></div><button id="seek-undo"></button><button id="seek-capture"></button>' +
      '<button id="reset-all"></button><button id="settings-toggle"></button><div id="settings-panel" hidden></div>' +
      '<select id="appearance-select"><option value="system"></option><option value="light"></option><option value="dark"></option></select>' +
      '<button id="mr-download"></button><div id="mr-status"></div><div id="mr-config-status"></div>' +
      '<input id="mr-baseurl" /><button id="mr-save"></button><details id="mr-settings"></details>' +
      '</body></html>',
    { url: `moz-extension://${EXT_ID}/popup.html`, runScripts: 'outside-only' },
  );
  const { window } = dom;
  const runtime = {
    id: EXT_ID,
    onMessage: { addListener() {} },
    getURL(p) {
      return `moz-extension://${EXT_ID}/${p}`;
    },
    sendMessage: runtimeSendMessage,
  };
  const ctx = {
    console: window.console,
    document: window.document,
    window,
    browser: {
      runtime,
      tabs: {
        query() {
          return Promise.resolve([{ id: 1 }]);
        },
      },
    },
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
  };
  ctx.globalThis = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(POPUP_JS, 'utf8'), ctx, { filename: 'popup.js' });
  if (window.document.readyState === 'loading')
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return { window, dom };
}

describe('TDD: pending night-mode state (SET suspended → GET reports pending)', () => {
  test('BUG: VC_NIGHT_SET 70 on suspended AudioContext → GET must report needsInteraction=true, not idle', async () => {
    const env = createEnv({ html: '<video></video>', audioState: 'suspended' });
    const setResp = await env.send({ type: 'VC_NIGHT_SET', strength: 70 });
    assert.equal(
      setResp.needsInteraction,
      true,
      'SET should signal needsInteraction when suspended',
    );
    assert.equal(setResp.strength, 70, 'SET should retain requested strength');
    const getResp = await env.send({ type: 'VC_NIGHT_GET' });
    assert.notEqual(
      getResp.status,
      'idle',
      'GET must not report idle after SET with pending state',
    );
    assert.equal(getResp.strength, 70, 'GET must retain requested strength');
    assert.equal(
      getResp.needsInteraction,
      true,
      'GET must propagate needsInteraction while pending',
    );
    assert.equal(getResp.active, false, 'active=false while not yet applied');
    env.dom.window.close();
  });

  test('BUG: popup must show actionable message when peaks needsInteraction (pending)', async () => {
    const sendMessage = () =>
      Promise.resolve({
        status: 'unsupported',
        strength: 70,
        active: false,
        count: 0,
        needsInteraction: true,
        error: 'AudioContext suspended, needs interaction',
      });
    const { window, dom } = createPopupEnv(sendMessage);
    await new Promise((r) => setTimeout(r, 50));
    const peaksStatus = window.document.getElementById('peaks-status');
    const text = peaksStatus.textContent;
    assert.notEqual(text, 'Off', 'popup must not show Off when peaks is pending activation');
    assert.ok(
      /activate|video|click/i.test(text),
      `popup must show actionable message, got: "${text}"`,
    );
    assert.equal(
      window.document.getElementById('peaks-slider').value,
      '70',
      'slider must retain requested strength',
    );
    dom.window.close();
  });

  test('RESET (SET 0) cancels pending — GET reports idle after reset', async () => {
    const env = createEnv({ html: '<video></video>', audioState: 'suspended' });
    await env.send({ type: 'VC_NIGHT_SET', strength: 70 });
    await env.send({ type: 'VC_NIGHT_SET', strength: 0 });
    const getResp = await env.send({ type: 'VC_NIGHT_GET' });
    assert.equal(getResp.needsInteraction, undefined, 'no needsInteraction after reset');
    assert.equal(getResp.strength, 0);
    assert.equal(getResp.active, false);
    env.dom.window.close();
  });

  test('latest intent wins: SET 70 suspended → SET 35 before interaction → GET shows 35 pending', async () => {
    const env = createEnv({ html: '<video></video>', audioState: 'suspended' });
    await env.send({ type: 'VC_NIGHT_SET', strength: 70 });
    await env.send({ type: 'VC_NIGHT_SET', strength: 35 });
    const getResp = await env.send({ type: 'VC_NIGHT_GET' });
    assert.equal(getResp.strength, 35, 'latest SET must win');
    assert.equal(getResp.needsInteraction, true);
    env.dom.window.close();
  });

  test('interaction listener applies pending synchronously when AudioContext running', async () => {
    const env = createEnv({ html: '<video></video>', audioState: 'suspended' });
    await env.send({ type: 'VC_NIGHT_SET', strength: 70 });
    env.mockAudioCtx.state = 'running';
    env.dispatchEvent('click');
    await new Promise((r) => setTimeout(r, 10));
    const getResp = await env.send({ type: 'VC_NIGHT_GET' });
    assert.notEqual(getResp.status, 'idle', 'after interaction GET should not be idle');
    assert.equal(getResp.strength, 70);
    assert.equal(getResp.active, true, 'night should be active after interaction applies it');
    env.dom.window.close();
  });
});
