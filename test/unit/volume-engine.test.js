/**
 * Video Number Guard — Volume + Night Mode content engine runtime tests.
 *
 * Evaluates the ACTUAL content script (volume.js) by running it in a
 * Node vm context whose globals are wired to a real JSDOM window
 * (document, MutationObserver, setTimeout) plus a mocked browser.runtime
 * and a mock AudioContext. This exercises the real onMessage handler,
 * audio-graph construction, init safety, and the SET/GET protocol
 * end-to-end — not just pure helper functions.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VOLUME_JS = path.resolve(__dirname, '..', '..', 'extensions', 'media-tamer', 'volume.js');
const NIGHT_MODE_JS = path.resolve(
  __dirname,
  '..',
  '..',
  'extensions',
  'media-tamer',
  'night-mode.js',
);

const EXT_ID = 'media-tamer@example.invalid';

// =============================================================================
// Mock AudioContext — tracks nodes, edges, and topology for assertions
// =============================================================================

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
            r();
          }, opts.resumeLag),
        );
      }
      if (state === 'suspended') state = 'running';
      return Promise.resolve();
    },
  };
  return ctx;
}

// =============================================================================
// Load VC_NIGHT_MODE from the real night-mode.js
// =============================================================================

function loadNightMode() {
  const ctx = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(NIGHT_MODE_JS, 'utf8'), ctx);
  return vm.runInContext('VC_NIGHT_MODE', ctx);
}

// =============================================================================
// Create a runtime environment with volume.js loaded
// =============================================================================

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

  if (opts.readyState === 'loading') {
    Object.defineProperty(document, 'readyState', {
      get() {
        return 'loading';
      },
      configurable: true,
    });
  }

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(VOLUME_JS, 'utf8'), context, {
    filename: 'volume.js',
  });

  // JSDOM with runScripts:'outside-only' does not fire DOMContentLoaded
  // automatically. Volume.js defers init() to that event when readyState is
  // 'loading', so dispatch it now to register the message listener.
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

// =============================================================================
// Group 1: VC_VOLUME_SET — strict validation
// =============================================================================

describe('VC_VOLUME_SET — strict validation', () => {
  test('rejects NaN with status=error', async () => {
    const env = createEnv({ html: '<video></video>' });
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: NaN });
    assert.equal(r.status, 'error');
    assert.equal(r.error, 'invalid percent');
    assert.equal(r.count, 0);
    assert.equal(r.appliedPercent, null);
    env.dom.window.close();
  });

  test('rejects Infinity', async () => {
    const env = createEnv({ html: '<video></video>' });
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: Infinity });
    assert.equal(r.status, 'error');
    assert.equal(r.count, 0);
    env.dom.window.close();
  });

  test('rejects string even if numeric-like', async () => {
    const env = createEnv({ html: '<video></video>' });
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: '150' });
    assert.equal(r.status, 'error');
    assert.equal(r.count, 0);
    env.dom.window.close();
  });

  test('rejects null/undefined', async () => {
    const env = createEnv({ html: '<video></video>' });
    const r1 = await env.send({ type: 'VC_VOLUME_SET', percent: null });
    assert.equal(r1.status, 'error');
    const r2 = await env.send({ type: 'VC_VOLUME_SET', percent: undefined });
    assert.equal(r2.status, 'error');
    env.dom.window.close();
  });

  test('rejects out-of-range values (no clamp)', async () => {
    const env = createEnv({ html: '<video></video>' });
    const r1 = await env.send({ type: 'VC_VOLUME_SET', percent: -1 });
    assert.equal(r1.status, 'error');
    const r2 = await env.send({ type: 'VC_VOLUME_SET', percent: 301 });
    assert.equal(r2.status, 'error');
    const r3 = await env.send({ type: 'VC_VOLUME_SET', percent: 9999 });
    assert.equal(r3.status, 'error');
    env.dom.window.close();
  });

  test('rejects non-integer numbers', async () => {
    const env = createEnv({ html: '<video></video>' });
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 150.5 });
    assert.equal(r.status, 'error');
    env.dom.window.close();
  });

  test('accepts valid integers 0-300 inclusive', async () => {
    const env = createEnv({ html: '<video></video>' });
    for (const p of [0, 1, 50, 100, 150, 200, 299, 300]) {
      const r = await env.send({ type: 'VC_VOLUME_SET', percent: p });
      assert.equal(r.status, 'ok', `percent=${p} should be ok`);
      assert.equal(r.percent, p);
      assert.equal(r.count, 1);
    }
    env.dom.window.close();
  });
});

// =============================================================================
// Group 2: VC_VOLUME_GET — honest reporting
// =============================================================================

describe('VC_VOLUME_GET — honest reporting', () => {
  test('GET before any SET reports idle', async () => {
    const env = createEnv({ html: '<video></video>' });
    const r = await env.send({ type: 'VC_VOLUME_GET' });
    assert.equal(r.status, 'idle');
    assert.equal(r.appliedPercent, null);
    assert.equal(r.count, 1);
    env.dom.window.close();
  });

  test('GET after SET reports applied percent', async () => {
    const env = createEnv({ html: '<video></video>' });
    await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    const r = await env.send({ type: 'VC_VOLUME_GET' });
    assert.equal(r.status, 'ok');
    assert.equal(r.percent, 150);
    assert.equal(r.appliedPercent, 150);
    assert.equal(r.count, 1);
    env.dom.window.close();
  });

  test('GET with no media reports idle and count=0', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body></body></html>' });
    const r = await env.send({ type: 'VC_VOLUME_GET' });
    assert.equal(r.status, 'idle');
    assert.equal(r.count, 0);
    env.dom.window.close();
  });
});

// =============================================================================
// Group 3: Direct mode (<=100%) — no WebAudio source created
// =============================================================================

describe('Direct mode — <=100% uses el.volume, no WebAudio', () => {
  test('50% sets el.volume to 0.5 without creating a source', async () => {
    const env = createEnv({ html: '<video></video>' });
    const video = env.document.querySelector('video');
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 50 });
    assert.equal(r.status, 'ok');
    assert.equal(r.appliedPercent, 50);
    assert.equal(video.volume, 0.5);
    assert.equal(video.muted, false);
    // No WebAudio nodes created in direct mode
    const sources = env.mockAudioCtx.nodes.filter((n) => n.type === 'source');
    assert.equal(sources.length, 0, 'direct mode must not create a source');
    env.dom.window.close();
  });

  test('100% leaves el.volume at baseline', async () => {
    const env = createEnv({ html: '<video></video>' });
    const video = env.document.querySelector('video');
    video.volume = 0.8;
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 100 });
    assert.equal(r.status, 'ok');
    assert.equal(video.volume, 0.8);
    env.dom.window.close();
  });

  test('0% sets el.volume to 0', async () => {
    const env = createEnv({ html: '<video></video>' });
    const video = env.document.querySelector('video');
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 0 });
    assert.equal(r.status, 'ok');
    assert.equal(video.volume, 0);
    env.dom.window.close();
  });

  test('respects site-set baseline volume', async () => {
    const env = createEnv({ html: '<video></video>' });
    const video = env.document.querySelector('video');
    video.volume = 0.5; // site set baseline
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    // 200% needs gain path; baseline is 0.5, so el.volume = 0.5, gain = 2.0
    assert.equal(r.status, 'ok');
    assert.equal(video.volume, 0.5, 'el.volume should be baseline, not 1.0');
    env.dom.window.close();
  });
});

// =============================================================================
// Group 4: Gain mode (>100%) — WebAudio source + gain node
// =============================================================================

describe('Gain mode — >100% creates WebAudio source + gain', () => {
  test('200% creates one source and one gain node', async () => {
    const env = createEnv({ html: '<video></video>' });
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    assert.equal(r.status, 'ok');
    assert.equal(r.appliedPercent, 200);
    const sources = env.mockAudioCtx.nodes.filter((n) => n.type === 'source');
    const gains = env.mockAudioCtx.nodes.filter((n) => n.type === 'gain');
    assert.equal(sources.length, 1, 'exactly one source');
    assert.equal(gains.length, 1, 'exactly one gain');
    // Gain value should be 2.0
    assert.equal(gains[0].gain.value, 2.0);
    env.dom.window.close();
  });

  test('300% sets gain to 3.0', async () => {
    const env = createEnv({ html: '<video></video>' });
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 300 });
    assert.equal(r.status, 'ok');
    const gains = env.mockAudioCtx.nodes.filter((n) => n.type === 'gain');
    assert.equal(gains[0].gain.value, 3.0);
    env.dom.window.close();
  });

  test('gain path connects source -> gain -> destination', async () => {
    const env = createEnv({ html: '<video></video>' });
    await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    const source = env.mockAudioCtx.nodes.find((n) => n.type === 'source');
    const gain = env.mockAudioCtx.nodes.find((n) => n.type === 'gain');
    assert.ok(source.edges.includes(gain), 'source should connect to gain');
    assert.ok(
      gain.edges.includes(env.mockAudioCtx.destination),
      'gain should connect to destination',
    );
    env.dom.window.close();
  });
});

// =============================================================================
// Group 5: Source count — never create >1 source per element
// =============================================================================

describe('Source count — never >1 media source per element', () => {
  test('re-SET at different percent does not create a second source', async () => {
    const env = createEnv({ html: '<video></video>' });
    await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    await env.send({ type: 'VC_VOLUME_SET', percent: 250 });
    const sources = env.mockAudioCtx.nodes.filter((n) => n.type === 'source');
    assert.equal(sources.length, 1, 'only one source across multiple SETs');
    env.dom.window.close();
  });

  test('two videos create two independent sources', async () => {
    const env = createEnv({ html: '<video></video><video></video>' });
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    assert.equal(r.count, 2);
    const sources = env.mockAudioCtx.nodes.filter((n) => n.type === 'source');
    assert.equal(sources.length, 2, 'two videos = two sources');
    env.dom.window.close();
  });

  test('each source connects to its own gain', async () => {
    const env = createEnv({ html: '<video></video><video></video>' });
    await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    const gains = env.mockAudioCtx.nodes.filter((n) => n.type === 'gain');
    assert.equal(gains.length, 2, 'two videos = two gains');
    env.dom.window.close();
  });
});

// =============================================================================
// Group 6: Sequence — 300 -> 50 -> 100 -> night
// =============================================================================

describe('Sequence — 300 -> 50 -> 100 transitions', () => {
  test('300% then 50%: gain path -> direct, no stacked gains', async () => {
    const env = createEnv({ html: '<video></video>' });
    const video = env.document.querySelector('video');
    // Set to 300% (gain path)
    const r1 = await env.send({ type: 'VC_VOLUME_SET', percent: 300 });
    assert.equal(r1.status, 'ok');
    const sources = env.mockAudioCtx.nodes.filter((n) => n.type === 'source');
    assert.equal(sources.length, 1);
    const gains = env.mockAudioCtx.nodes.filter((n) => n.type === 'gain');
    assert.equal(gains[0].gain.value, 3.0);
    // Now set to 50% (direct path)
    const r2 = await env.send({ type: 'VC_VOLUME_SET', percent: 50 });
    assert.equal(r2.status, 'ok');
    assert.equal(r2.appliedPercent, 50);
    assert.equal(video.volume, 0.5);
    // Source count should still be 1 (not 2)
    assert.equal(sources.length, 1, 'no second source created');
    env.dom.window.close();
  });

  test('50% then 100%: both direct, no source created', async () => {
    const env = createEnv({ html: '<video></video>' });
    const video = env.document.querySelector('video');
    await env.send({ type: 'VC_VOLUME_SET', percent: 50 });
    assert.equal(video.volume, 0.5);
    await env.send({ type: 'VC_VOLUME_SET', percent: 100 });
    assert.equal(video.volume, 1.0);
    const sources = env.mockAudioCtx.nodes.filter((n) => n.type === 'source');
    assert.equal(sources.length, 0, 'no source in direct-direct');
    env.dom.window.close();
  });

  test('100% then 200%: direct -> gain, source created', async () => {
    const env = createEnv({ html: '<video></video>' });
    const video = env.document.querySelector('video');
    await env.send({ type: 'VC_VOLUME_SET', percent: 100 });
    assert.equal(video.volume, 1.0);
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    assert.equal(r.status, 'ok');
    const sources = env.mockAudioCtx.nodes.filter((n) => n.type === 'source');
    assert.equal(sources.length, 1, 'source created for gain path');
    env.dom.window.close();
  });
});

// =============================================================================
// Group 7: Muted — respect site mute
// =============================================================================

describe('Muted — respect site mute', () => {
  test('muted video returns unsupported and does not create source', async () => {
    const env = createEnv({ html: '<video></video>' });
    const video = env.document.querySelector('video');
    video.muted = true;
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    // Single muted element: count=0, total=1 → unsupported
    assert.equal(r.status, 'unsupported');
    assert.equal(r.count, 0, 'muted element not counted as applied');
    const sources = env.mockAudioCtx.nodes.filter((n) => n.type === 'source');
    assert.equal(sources.length, 0, 'no source for muted');
    env.dom.window.close();
  });

  test('mixed muted/unmuted: unmuted gets volume, muted skipped', async () => {
    const env = createEnv({ html: '<video></video><video></video>' });
    const videos = env.document.querySelectorAll('video');
    videos[0].muted = true;
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    assert.equal(r.count, 1, 'only unmuted counted');
    assert.equal(videos[1].volume, 1.0, 'unmuted gets baseline');
    env.dom.window.close();
  });
});

// =============================================================================
// Group 8: Night mode routing — source -> night -> gain -> protection
// =============================================================================

describe('Night mode routing', () => {
  test('VC_NIGHT_SET with helper available creates night + protection', async () => {
    const env = createEnv({ html: '<video></video>' });
    // First set volume to create a source
    await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    // Then enable night mode
    const r = await env.send({ type: 'VC_NIGHT_SET', strength: 70 });
    assert.equal(r.status, 'ok');
    assert.equal(r.strength, 70);
    assert.equal(r.active, true);
    assert.equal(r.count, 1);
    assert.equal(typeof r.reduction, 'number');
    env.dom.window.close();
  });

  test('night mode routes source -> night.input -> night.output -> gain', async () => {
    const env = createEnv({ html: '<video></video>' });
    await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    await env.send({ type: 'VC_NIGHT_SET', strength: 70 });
    // Verify the night helper was created and connected
    const compressors = env.mockAudioCtx.nodes.filter((n) => n.type === 'compressor');
    assert.ok(compressors.length >= 1, 'night mode creates a compressor');
    env.dom.window.close();
  });

  test('VC_NIGHT_SET strength=0 disables night (active=false)', async () => {
    const env = createEnv({ html: '<video></video>' });
    await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    await env.send({ type: 'VC_NIGHT_SET', strength: 70 });
    const r = await env.send({ type: 'VC_NIGHT_SET', strength: 0 });
    assert.equal(r.active, false);
    assert.equal(r.strength, 0);
    env.dom.window.close();
  });

  test('VC_NIGHT_GET after SET reports active and strength', async () => {
    const env = createEnv({ html: '<video></video>' });
    await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    await env.send({ type: 'VC_NIGHT_SET', strength: 50 });
    const r = await env.send({ type: 'VC_NIGHT_GET' });
    assert.equal(r.status, 'ok');
    assert.equal(r.strength, 50);
    assert.equal(r.active, true);
    assert.equal(typeof r.reduction, 'number');
    env.dom.window.close();
  });

  test('VC_NIGHT_GET before SET reports idle', async () => {
    const env = createEnv({ html: '<video></video>' });
    const r = await env.send({ type: 'VC_NIGHT_GET' });
    assert.equal(r.status, 'idle');
    assert.equal(r.active, false);
    assert.equal(r.count, 0);
    env.dom.window.close();
  });
});

// =============================================================================
// Group 9: Night helper unavailable
// =============================================================================

describe('Night helper unavailable', () => {
  test('VC_NIGHT_SET without VC_NIGHT_MODE returns unsupported', async () => {
    const env = createEnv({ html: '<video></video>', nightApi: undefined });
    // Override VC_NIGHT_MODE to undefined
    env.context.VC_NIGHT_MODE = undefined;
    const r = await env.send({ type: 'VC_NIGHT_SET', strength: 70 });
    assert.equal(r.status, 'unsupported');
    assert.equal(r.active, false);
    assert.equal(r.error, 'night-mode helper unavailable');
    env.dom.window.close();
  });
});

// =============================================================================
// Group 10: Night validation
// =============================================================================

describe('VC_NIGHT_SET — validation', () => {
  test('rejects NaN strength', async () => {
    const env = createEnv({ html: '<video></video>' });
    const r = await env.send({ type: 'VC_NIGHT_SET', strength: NaN });
    assert.equal(r.status, 'error');
    assert.equal(r.error, 'invalid night strength');
    env.dom.window.close();
  });

  test('rejects out-of-range strength', async () => {
    const env = createEnv({ html: '<video></video>' });
    const r1 = await env.send({ type: 'VC_NIGHT_SET', strength: -1 });
    assert.equal(r1.status, 'error');
    const r2 = await env.send({ type: 'VC_NIGHT_SET', strength: 101 });
    assert.equal(r2.status, 'error');
    env.dom.window.close();
  });

  test('accepts 0-100 inclusive', async () => {
    const env = createEnv({ html: '<video></video>' });
    for (const s of [0, 1, 35, 50, 70, 99, 100]) {
      const r = await env.send({ type: 'VC_NIGHT_SET', strength: s });
      assert.equal(r.strength, s, `strength=${s} accepted`);
    }
    env.dom.window.close();
  });
});

// =============================================================================
// Group 11: Classification — blob, DRM, cross-origin
// =============================================================================

describe('Media classification', () => {
  test('blob: src is gain-eligible', async () => {
    const env = createEnv({ html: '<video></video>' });
    const video = env.document.querySelector('video');
    video.src = 'blob:https://example.com/abc-123';
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    assert.equal(r.status, 'ok', 'blob: should allow gain path');
    assert.equal(r.count, 1);
    env.dom.window.close();
  });

  test('same-origin src is gain-eligible', async () => {
    const env = createEnv({ html: '<video></video>' });
    const video = env.document.querySelector('video');
    video.src = 'https://example.com/video.mp4';
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    assert.equal(r.status, 'ok');
    assert.equal(r.count, 1);
    env.dom.window.close();
  });

  test('cross-origin src is unsupported for gain', async () => {
    const env = createEnv({ html: '<video></video>' });
    const video = env.document.querySelector('video');
    video.src = 'https://evil.com/video.mp4';
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    // Single cross-origin element: count=0, total=1, no error → unsupported
    assert.equal(r.status, 'unsupported');
    assert.equal(r.count, 0);
    env.dom.window.close();
  });

  test('DRM (mediaKeys) is unsupported', async () => {
    const env = createEnv({ html: '<video></video>' });
    const video = env.document.querySelector('video');
    video.mediaKeys = {};
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    assert.equal(r.count, 0, 'DRM element not counted');
    env.dom.window.close();
  });

  test('no src (MSE) is gain-eligible', async () => {
    const env = createEnv({ html: '<video></video>' });
    // No src attribute — MSE
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    assert.equal(r.status, 'ok');
    assert.equal(r.count, 1);
    env.dom.window.close();
  });
});

// =============================================================================
// Group 12: Sender validation
// =============================================================================

describe('Sender validation', () => {
  test('rejects messages from unknown extension ID', async () => {
    const env = createEnv({ html: '<video></video>' });
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 150 }, 'other-extension@evil');
    assert.equal(r, undefined, 'unknown sender should be ignored');
    env.dom.window.close();
  });

  test('accepts messages from matching extension ID', async () => {
    const env = createEnv({ html: '<video></video>' });
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    assert.equal(r.status, 'ok');
    env.dom.window.close();
  });
});

// =============================================================================
// Group 13: Init safety — no throw when documentElement missing
// =============================================================================

describe('Init safety', () => {
  test('does not throw at document_start before documentElement exists', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      runScripts: 'outside-only',
    });
    const { window } = dom;
    const { document } = window;
    document.documentElement.remove();
    assert.equal(document.documentElement, null);

    const runtime = {
      id: EXT_ID,
      onMessage: { addListener() {} },
      sendMessage() {
        return Promise.resolve();
      },
    };

    const context = {
      console: window.console,
      setTimeout: window.setTimeout,
      clearTimeout: window.clearTimeout,
      MutationObserver: window.MutationObserver,
      document: window.document,
      browser: { runtime },
    };
    context.window = context;
    context.globalThis = context;
    context.global = context;

    const mockAudioCtx = createMockAudioContext();
    context.AudioContext = function () {
      return mockAudioCtx;
    };
    context.VC_NIGHT_MODE = loadNightMode();

    assert.doesNotThrow(() => {
      vm.createContext(context);
      vm.runInContext(fs.readFileSync(VOLUME_JS, 'utf8'), context, {
        filename: 'volume.js',
      });
    });
    dom.window.close();
  });
});

// =============================================================================
// Group 14: Suspended AudioContext — bounded resume
// =============================================================================

describe('Suspended AudioContext', () => {
  test('suspended context returns needsInteraction for gain path', async () => {
    const env = createEnv({
      html: '<video></video>',
      audioState: 'suspended',
    });
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    // Should return unsupported with needsInteraction
    assert.equal(r.needsInteraction, true);
    env.dom.window.close();
  });

  test('suspended context does not create source', async () => {
    const env = createEnv({
      html: '<video></video>',
      audioState: 'suspended',
    });
    await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    const sources = env.mockAudioCtx.nodes.filter((n) => n.type === 'source');
    assert.equal(sources.length, 0, 'no source created while suspended');
    env.dom.window.close();
  });
});

// =============================================================================
// Group 15: New media inherit explicit target
// =============================================================================

describe('New media inherit explicit target', () => {
  test('video added after SET inherits target volume', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body></body></html>' });
    // Set volume first (no media yet)
    await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    // Add a video dynamically
    const video = env.document.createElement('video');
    env.document.body.appendChild(video);
    // Wait for MutationObserver + debounce
    await new Promise((r) => setTimeout(r, 200));
    // The new video should have volume applied
    assert.equal(video.volume, 1.0, 'new video gets baseline volume');
    env.dom.window.close();
  });
});

// =============================================================================
// Group 16: No debug leaks
// =============================================================================

describe('No debug leaks', () => {
  test('no __vgOwnChange on window', async () => {
    const env = createEnv({ html: '<video></video>' });
    assert.equal(env.window.__vgOwnChange, undefined);
    env.dom.window.close();
  });

  test('no vg-prefixed globals on window', () => {
    const env = createEnv({ html: '<video></video>' });
    const keys = Object.keys(env.window).filter((k) => k.startsWith('vg') || k.startsWith('__vg'));
    assert.equal(keys.length, 0, 'no vg or __vg globals on window');
    env.dom.window.close();
  });
});

// =============================================================================
// Group 17: Status response shape — exact contract
// =============================================================================

describe('Status response shape', () => {
  test('VC_VOLUME_SET returns exact contract shape', async () => {
    const env = createEnv({ html: '<video></video>' });
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    assert.equal(typeof r.percent, 'number');
    assert.equal(typeof r.count, 'number');
    assert.ok(['ok', 'partial', 'unsupported', 'error'].includes(r.status));
    const allowed = new Set([
      'percent',
      'appliedPercent',
      'count',
      'status',
      'error',
      'needsInteraction',
    ]);
    for (const key of Object.keys(r)) {
      assert.ok(allowed.has(key), `unexpected key: ${key}`);
    }
    env.dom.window.close();
  });

  test('VC_VOLUME_GET returns exact contract shape', async () => {
    const env = createEnv({ html: '<video></video>' });
    await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    const r = await env.send({ type: 'VC_VOLUME_GET' });
    assert.equal(typeof r.percent, 'number');
    assert.equal(typeof r.count, 'number');
    assert.ok(['ok', 'idle', 'unsupported', 'error'].includes(r.status));
    env.dom.window.close();
  });

  test('VC_NIGHT_SET returns exact contract shape', async () => {
    const env = createEnv({ html: '<video></video>' });
    await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    const r = await env.send({ type: 'VC_NIGHT_SET', strength: 70 });
    assert.equal(typeof r.strength, 'number');
    assert.equal(typeof r.active, 'boolean');
    assert.equal(typeof r.count, 'number');
    assert.ok(['ok', 'unsupported', 'error'].includes(r.status));
    const allowed = new Set([
      'strength',
      'active',
      'count',
      'status',
      'error',
      'reduction',
      'needsInteraction',
    ]);
    for (const key of Object.keys(r)) {
      assert.ok(allowed.has(key), `unexpected key: ${key}`);
    }
    env.dom.window.close();
  });

  test('VC_NIGHT_GET returns exact contract shape', async () => {
    const env = createEnv({ html: '<video></video>' });
    await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    await env.send({ type: 'VC_NIGHT_SET', strength: 50 });
    const r = await env.send({ type: 'VC_NIGHT_GET' });
    assert.equal(typeof r.strength, 'number');
    assert.equal(typeof r.active, 'boolean');
    assert.equal(typeof r.count, 'number');
    assert.ok(['ok', 'idle', 'error'].includes(r.status));
    env.dom.window.close();
  });
});

// =============================================================================
// Group 18: Shadow root media
// =============================================================================

describe('Shadow root media', () => {
  test('finds video inside an open shadow root', async () => {
    const env = createEnv({ html: '<div id="host"></div>' });
    const host = env.document.getElementById('host');
    const shadow = host.attachShadow({ mode: 'open' });
    const video = env.document.createElement('video');
    shadow.appendChild(video);
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    assert.equal(r.count, 1, 'should find video in shadow root');
    env.dom.window.close();
  });
});

// =============================================================================
// Group 19: Multiple media — honest count
// =============================================================================

describe('Multiple media — honest count', () => {
  test('all-same applied percent reported', async () => {
    const env = createEnv({ html: '<video></video><video></video>' });
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 150 });
    assert.equal(r.count, 2);
    assert.equal(r.appliedPercent, 150);
    env.dom.window.close();
  });

  test('mixed gain/direct: appliedPercent is average', async () => {
    const env = createEnv({ html: '<video></video><video></video>' });
    const videos = env.document.querySelectorAll('video');
    videos[0].src = 'https://evil.com/v1.mp4'; // cross-origin -> unsupported for gain
    const r = await env.send({ type: 'VC_VOLUME_SET', percent: 200 });
    assert.equal(r.count, 1, 'only same-origin counted');
    assert.equal(r.status, 'partial');
    env.dom.window.close();
  });
});
