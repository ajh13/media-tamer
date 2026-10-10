/**
 * Regression tests for v1.1.2 bug fixes:
 *   1. Night mode "AudioContext suspended" interaction-driven retry
 *   2. Address-bar page action missing on new tabs
 *   3. "Could not establish connection" frame aggregation
 *   4. Popup error double-prefix
 *
 * Runs actual volume.js and background.js in vm + jsdom context.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import vm from 'vm';
import fs from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..', '..', 'extensions', 'media-tamer');
const VOLUME_JS = path.join(EXT_DIR, 'volume.js');
const BACKGROUND_JS = path.join(EXT_DIR, 'background.js');
const NIGHT_MODE_JS = path.join(EXT_DIR, 'night-mode.js');
const EXT_ID = 'media-tamer@example.invalid';

// --- Mock AudioContext ---
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
      if (opts.resumeLag) {
        return new Promise((r) =>
          setTimeout(() => {
            state = 'running';
            ctx.state = 'running';
            r();
          }, opts.resumeLag),
        );
      }
      if (state === 'suspended') {
        state = 'running';
        ctx.state = 'running';
      }
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

function createVolumeEnv(opts = {}) {
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
    VC_NIGHT_MODE: opts.nightApi !== undefined ? opts.nightApi : loadNightMode(),
    window: null,
  };
  context.window = context;
  context.globalThis = context;
  context.global = context;

  if (opts.readyState === 'loading') {
    Object.defineProperty(document, 'readyState', {
      get() {
        return 'loading';
      },
      configurable: true,
    });
  }

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(VOLUME_JS, 'utf8'), context, { filename: 'volume.js' });

  if (document.readyState === 'loading') {
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
  }

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
        if (handled === true) {
          setTimeout(() => {
            if (!responded) resolve(undefined);
          }, 100);
        } else {
          resolve(undefined);
        }
      } catch (e) {
        resolve({ __error: String(e) });
      }
    });
  }

  return { send, window, document, context, mockAudioCtx, dom };
}

// ============================================================================
// Fix 1: AudioContext suspended — interaction-driven retry
// ============================================================================
describe('Fix 1: AudioContext suspended interaction retry', () => {
  test('suspended AudioContext returns needsInteraction and calls resume', async () => {
    const env = createVolumeEnv({ html: '<video></video>', audioState: 'suspended' });
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    assert.equal(r.needsInteraction, true);
    assert.equal(r.status, 'unsupported');
    assert.ok(env.mockAudioCtx.resumeCount >= 1, 'resume() should have been called');
    env.dom.window.close();
  });

  test('night mode suspended also returns needsInteraction', async () => {
    const env = createVolumeEnv({ html: '<video></video>', audioState: 'suspended' });
    const r = await env.send({ type: 'VC_NIGHT_SET', strength: 70 });
    assert.equal(r.needsInteraction, true);
    assert.equal(r.status, 'unsupported');
    env.dom.window.close();
  });

  test('suspended context does not create source', async () => {
    const env = createVolumeEnv({ html: '<video></video>', audioState: 'suspended' });
    await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    const sources = env.mockAudioCtx.nodes.filter((n) => n.type === 'source');
    assert.equal(sources.length, 0, 'no source created while suspended');
    env.dom.window.close();
  });
});

// ============================================================================
// Fix 3: Frame aggregation ignores unreachable frames
// ============================================================================
describe('Fix 3: broadcast ignores unreachable frames', () => {
  test('tabs.sendMessage throwing "Receiving end does not exist" is unsupported not error', async () => {
    const listeners = { runtimeOnMessage: [] };
    const browser = {
      runtime: {
        id: EXT_ID,
        getURL: (p) => `moz-extension://${EXT_ID}/${p}`,
        onMessage: { addListener: (fn) => listeners.runtimeOnMessage.push(fn) },
        sendMessage: async (msg) => {
          const sender = { id: EXT_ID, url: `moz-extension://${EXT_ID}/popup.html` };
          let response;
          for (const fn of listeners.runtimeOnMessage) {
            const r = await fn(msg, sender);
            if (r) response = r;
          }
          return response;
        },
      },
      tabs: {
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        sendMessage: async (tabId, msg, opts) => {
          if (opts && opts.frameId === 1) {
            throw new Error('Could not establish connection. Receiving end does not exist.');
          }
          if (msg.type === 'VC_VOLUME_SET') {
            return { percent: msg.percent, appliedPercent: msg.percent, count: 1, status: 'ok' };
          }
          if (msg.type === 'VC_VOLUME_GET') {
            return { percent: 100, appliedPercent: 100, count: 1, status: 'ok' };
          }
          return { count: 0, status: 'unsupported' };
        },
        query: async () => [{ id: 1, url: 'https://example.com' }],
      },
      webNavigation: {
        getAllFrames: async () => [
          { frameId: 0, url: 'https://example.com' },
          { frameId: 1, url: 'https://example.com/iframe' },
        ],
      },
      pageAction: { setTitle: async () => {}, show: async () => {}, hide: async () => {} },
      menus: {
        create: () => {},
        update: () => Promise.resolve(),
        refresh: async () => {},
        onClicked: { addListener: () => {} },
        onShown: { addListener: () => {} },
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      permissions: { request: async () => true, contains: async () => true },
    };

    const ctx = vm.createContext({
      browser,
      console,
      Promise,
      Map,
      Set,
      Object,
      Array,
      JSON,
      Math,
      Number,
      String,
      Boolean,
      Date,
      Error,
      TypeError,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
    });
    vm.runInContext(fs.readFileSync(BACKGROUND_JS, 'utf8'), ctx);

    const sender = { id: EXT_ID, url: `moz-extension://${EXT_ID}/popup.html` };
    let response;
    for (const fn of listeners.runtimeOnMessage) {
      const r = await fn({ type: 'VC_VOLUME_SET', percent: 150, tabId: 1 }, sender);
      if (r) response = r;
    }
    assert.equal(response.status, 'ok', 'unreachable frame should not cause error');
    assert.equal(response.count, 1, 'only reachable frame counted');
  });

  test('"Receiving end does not exist" on all frames yields unsupported with no connection error', async () => {
    const listeners = { runtimeOnMessage: [] };
    const browser = {
      runtime: {
        id: EXT_ID,
        getURL: (p) => `moz-extension://${EXT_ID}/${p}`,
        onMessage: { addListener: (fn) => listeners.runtimeOnMessage.push(fn) },
        sendMessage: async (msg) => {
          const sender = { id: EXT_ID, url: `moz-extension://${EXT_ID}/popup.html` };
          let response;
          for (const fn of listeners.runtimeOnMessage) {
            const r = await fn(msg, sender);
            if (r) response = r;
          }
          return response;
        },
      },
      tabs: {
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        sendMessage: async () => {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        },
        query: async () => [{ id: 1, url: 'https://example.com' }],
      },
      webNavigation: {
        getAllFrames: async () => [
          { frameId: 0, url: 'https://example.com' },
          { frameId: 1, url: 'https://evil.com' },
        ],
      },
      pageAction: { setTitle: async () => {}, show: async () => {}, hide: async () => {} },
      menus: {
        create: () => {},
        update: () => Promise.resolve(),
        refresh: async () => {},
        onClicked: { addListener: () => {} },
        onShown: { addListener: () => {} },
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      permissions: { request: async () => true, contains: async () => true },
    };

    const ctx = vm.createContext({
      browser,
      console,
      Promise,
      Map,
      Set,
      Object,
      Array,
      JSON,
      Math,
      Number,
      String,
      Boolean,
      Date,
      Error,
      TypeError,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
    });
    vm.runInContext(fs.readFileSync(BACKGROUND_JS, 'utf8'), ctx);

    const sender = { id: EXT_ID, url: `moz-extension://${EXT_ID}/popup.html` };
    let response;
    for (const fn of listeners.runtimeOnMessage) {
      const r = await fn({ type: 'VC_VOLUME_GET', tabId: 1 }, sender);
      if (r) response = r;
    }
    assert.equal(response.status, 'unsupported', 'all unreachable → unsupported');
    assert.ok(!response.error, 'no error string when frames are merely unreachable');
  });
});

// ============================================================================
// Fix 2: Page action hide/loading lifecycle
// ============================================================================
describe('Fix 2: page action loading lifecycle', () => {
  test('background.js does not call pageAction.hide on loading event', async () => {
    const bgSrc = fs.readFileSync(BACKGROUND_JS, 'utf8');
    const loadingMatch = bgSrc.match(/if \(changeInfo\.status === 'loading'\) \{[\s\S]*?\n    \}/);
    assert.ok(loadingMatch, 'should have loading handler');
    const loadingBlock = loadingMatch[0];
    assert.ok(
      !loadingBlock.includes('pageAction.hide'),
      'loading handler must NOT call pageAction.hide — show_matches handles it',
    );
  });

  test('background.js calls showPageAction on complete', async () => {
    const bgSrc = fs.readFileSync(BACKGROUND_JS, 'utf8');
    assert.ok(
      bgSrc.includes('showPageAction(tabId, tab.url)'),
      'should call showPageAction on complete',
    );
  });
});

// ============================================================================
// Fix 4: Popup error double-prefix removed
// ============================================================================
describe('Fix 4: popup error rendering', () => {
  test('popup.js renderVolume does not double-prefix error', () => {
    const popupSrc = fs.readFileSync(path.join(EXT_DIR, 'popup.js'), 'utf8');
    assert.ok(
      !popupSrc.includes('`Error: ${resp.error}`'),
      'popup.js should not prefix errors with "Error:" — background errors are self-describing',
    );
  });

  test('popup.js renders error from response.error directly', () => {
    const popupSrc = fs.readFileSync(path.join(EXT_DIR, 'popup.js'), 'utf8');
    assert.ok(
      popupSrc.includes('`${resp.error}`'),
      'popup.js should render resp.error without "Error:" prefix',
    );
  });
});

// ============================================================================
// Fix 5: Night mode needsInteraction propagates through background aggregation
// ============================================================================
describe('Fix 5: aggNight propagates needsInteraction from frames', () => {
  test('background.aggNight surfaces needsInteraction when frame reports pending night', async () => {
    const listeners = { runtimeOnMessage: [] };
    const browser = {
      runtime: {
        id: EXT_ID,
        getURL: (p) => `moz-extension://${EXT_ID}/${p}`,
        onMessage: { addListener: (fn) => listeners.runtimeOnMessage.push(fn) },
        sendMessage: async (msg) => {
          const sender = { id: EXT_ID, url: `moz-extension://${EXT_ID}/popup.html` };
          let response;
          for (const fn of listeners.runtimeOnMessage) {
            const r = await fn(msg, sender);
            if (r) response = r;
          }
          return response;
        },
      },
      tabs: {
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        sendMessage: async (tabId, msg) => {
          if (msg.type === 'VC_NIGHT_SET') {
            return {
              strength: msg.strength,
              active: false,
              count: 0,
              status: 'unsupported',
              needsInteraction: true,
              error: 'AudioContext suspended, needs interaction',
            };
          }
          if (msg.type === 'VC_NIGHT_GET') {
            return {
              strength: 70,
              active: false,
              count: 0,
              status: 'unsupported',
              needsInteraction: true,
            };
          }
          return { count: 0, status: 'unsupported' };
        },
        query: async () => [{ id: 1, url: 'https://example.com' }],
      },
      webNavigation: {
        getAllFrames: async () => [{ frameId: 0, url: 'https://example.com' }],
      },
      pageAction: { setTitle: async () => {}, show: async () => {}, hide: async () => {} },
      menus: {
        create: () => {},
        update: () => Promise.resolve(),
        refresh: async () => {},
        onClicked: { addListener: () => {} },
        onShown: { addListener: () => {} },
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      permissions: { request: async () => true, contains: async () => true },
    };

    const ctx = vm.createContext({
      browser,
      console,
      Promise,
      Map,
      Set,
      Object,
      Array,
      JSON,
      Math,
      Number,
      String,
      Boolean,
      Date,
      Error,
      TypeError,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
    });
    vm.runInContext(fs.readFileSync(BACKGROUND_JS, 'utf8'), ctx);

    const sender = { id: EXT_ID, url: `moz-extension://${EXT_ID}/popup.html` };

    let setResponse;
    for (const fn of listeners.runtimeOnMessage) {
      const r = await fn({ type: 'VC_NIGHT_SET', strength: 70, tabId: 1 }, sender);
      if (r) setResponse = r;
    }
    assert.equal(
      setResponse.needsInteraction,
      true,
      'background must propagate needsInteraction from content for VC_NIGHT_SET',
    );
    assert.equal(setResponse.strength, 70);

    let getResponse;
    for (const fn of listeners.runtimeOnMessage) {
      const r = await fn({ type: 'VC_NIGHT_GET', tabId: 1 }, sender);
      if (r) getResponse = r;
    }
    assert.equal(
      getResponse.needsInteraction,
      true,
      'background must propagate needsInteraction from content for VC_NIGHT_GET',
    );
    assert.equal(getResponse.strength, 70);
  });
});
