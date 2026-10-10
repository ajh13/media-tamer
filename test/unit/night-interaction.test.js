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
const EXT_ID = 'media-tamer@example.invalid';

function createMockAudioContext(state = 'suspended', opts = {}) {
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
    resumeWorks: false,
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
    async resume() {
      ctx.resumeCount++;
      if (opts.resumeLag) await new Promise((r) => setTimeout(r, opts.resumeLag));
      if (ctx.resumeWorks) ctx.state = 'running';
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return ctx;
}

function loadNightMode() {
  const ctx = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(NIGHT_MODE_JS, 'utf8'), ctx);
  return vm.runInContext('VC_NIGHT_MODE', ctx);
}

function createEnv(opts = {}) {
  const audioState = opts.audioState || 'suspended';
  const dom = new JSDOM('<!DOCTYPE html><html><body><video></video></body></html>', {
    url: 'https://example.com/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  let messageListener = null;
  const mockAudioCtx = createMockAudioContext(audioState, opts);
  const runtime = {
    id: EXT_ID,
    onMessage: {
      addListener(fn) {
        messageListener = fn;
      },
    },
    sendMessage() {
      return Promise.resolve();
    },
  };
  const eventListeners = new Map();
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
    VC_NIGHT_MODE: loadNightMode(),
  };
  context.window = context;
  context.globalThis = context;
  context.global = context;

  context.addEventListener = function (type, listener, options) {
    if (!eventListeners.has(type)) eventListeners.set(type, []);
    eventListeners.get(type).push({ listener, options });
  };
  context.dispatchEvent = function (event) {
    const listeners = eventListeners.get(event.type) || [];
    const promises = [];
    for (const { listener } of listeners) {
      try {
        const result = listener(event);
        if (result && typeof result.then === 'function') promises.push(result);
      } catch (_) {}
    }
    if (promises.length) return Promise.all(promises);
    return Promise.resolve();
  };

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(VOLUME_JS, 'utf8'), context, { filename: 'volume.js' });
  if (document.readyState === 'loading')
    document.dispatchEvent(new window.Event('DOMContentLoaded'));

  function send(msg) {
    return new Promise((resolve) => {
      if (!messageListener) return resolve(undefined);
      let responded = false;
      const sendResponse = (resp) => {
        if (responded) return;
        responded = true;
        resolve(resp);
      };
      const sender = { id: EXT_ID, tab: { id: 1 }, frameId: 0, url: 'https://example.com/' };
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

  function dispatchEvent(type) {
    return context.dispatchEvent({
      type,
      target: context,
      preventDefault() {},
      stopPropagation() {},
    });
  }

  return { send, window, document, context, mockAudioCtx, dom, dispatchEvent };
}

describe('TDD: interaction handler resumes AudioContext and applies pending', () => {
  test('interaction handler resumes AudioContext on click and applies night', async () => {
    const env = createEnv({ audioState: 'suspended' });
    await env.send({ type: 'VC_NIGHT_SET', strength: 70 });
    assert.equal(env.mockAudioCtx.state, 'suspended');

    env.mockAudioCtx.resumeWorks = true; // Simulate gesture context
    await env.dispatchEvent('click');

    assert.equal(env.mockAudioCtx.state, 'running', 'resumed after click');
    assert.ok(env.mockAudioCtx.resumeCount >= 1, 'resume called');

    const getResp = await env.send({ type: 'VC_NIGHT_GET' });
    assert.equal(getResp.active, true, 'night active');
    assert.equal(getResp.strength, 70);
    assert.equal(getResp.status, 'ok');
    assert.ok(!getResp.needsInteraction, 'pending cleared');
    env.dom.window.close();
  });

  test('interaction handler resumes both volume and night when both pending', async () => {
    const env = createEnv({ audioState: 'suspended' });
    await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    await env.send({ type: 'VC_NIGHT_SET', strength: 50 });

    env.mockAudioCtx.resumeWorks = true;
    await env.dispatchEvent('click');

    const nightResp = await env.send({ type: 'VC_NIGHT_GET' });
    assert.equal(nightResp.active, true);
    const volResp = await env.send({ type: 'VC_VOLUME_GET' });
    assert.equal(volResp.status, 'ok');
    env.dom.window.close();
  });

  test('pending preserved if resume fails (non-gesture context)', async () => {
    const env = createEnv({ audioState: 'suspended' });
    // resumeWorks stays false — simulates non-gesture resume (Firefox ignores)
    await env.send({ type: 'VC_NIGHT_SET', strength: 70 });
    await env.dispatchEvent('click');
    // Safety-net timeout in onInteract is 1000ms
    await new Promise((r) => setTimeout(r, 1100));

    assert.equal(env.mockAudioCtx.state, 'suspended', 'still suspended');
    const getResp = await env.send({ type: 'VC_NIGHT_GET' });
    assert.equal(getResp.active, false, 'night not active when resume fails');
    assert.ok(getResp.needsInteraction === true, 'pending stays');
    env.dom.window.close();
  });
});
