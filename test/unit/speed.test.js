/**
 * Video Number Guard — Speed feature runtime tests.
 *
 * Evaluates the ACTUAL content script (speed.js) by running it in a
 * Node vm context whose globals are wired to a real JSDOM window
 * (document, MutationObserver, setTimeout) plus a mocked browser.runtime.
 * This exercises the real onMessage handler, MutationObserver wiring,
 * init safety, and the SET/GET/RESET protocol end-to-end — not just
 * pure helper functions.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEED_JS = path.resolve(__dirname, '..', '..', 'extensions', 'media-tamer', 'speed.js');

/**
 * Build a runtime environment:
 *  - Real JSDOM document/MutationObserver/setTimeout
 *  - Mocked browser.runtime with onMessage/sendMessage
 *  - speed.js evaluated in a vm context with those globals
 */
function createEnv(opts = {}) {
  const extId = opts.extId || 'media-tamer@example.invalid';
  const html = opts.html || '<!DOCTYPE html><html><body></body></html>';

  const dom = new JSDOM(html, {
    url: 'https://example.com/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });

  const { window } = dom;
  const { document } = window;

  let messageListener = null;
  const sentMessages = [];

  const runtime = {
    id: extId,
    onMessage: {
      addListener(fn) {
        messageListener = fn;
      },
    },
    sendMessage(msg) {
      sentMessages.push(msg);
      return Promise.resolve();
    },
  };

  // Wire explicit vm globals to the JSDOM window instances so the
  // eval'd code sees `document`, `MutationObserver`, `setTimeout`, etc.
  // exactly as it would in a browser, plus the browser mock.
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

  if (opts.readyState === 'loading') {
    Object.defineProperty(document, 'readyState', {
      get() {
        return 'loading';
      },
      configurable: true,
    });
  }

  vm.createContext(context);
  const speedSrc = fs.readFileSync(SPEED_JS, 'utf8');
  vm.runInContext(speedSrc, context, { filename: 'speed.js' });

  function send(msg) {
    return new Promise((resolve) => {
      if (!messageListener) {
        resolve(undefined);
        return;
      }
      let responded = false;
      let timer = null;
      const sendResponse = (resp) => {
        if (responded) return;
        responded = true;
        if (timer) clearTimeout(timer);
        resolve(resp);
      };
      const sender = {
        id: opts.senderId !== undefined ? opts.senderId : extId,
        tab: { id: 1 },
        frameId: 0,
        url: 'https://example.com/',
      };
      try {
        const handled = messageListener(msg, sender, sendResponse);
        if (handled === true) {
          timer = setTimeout(() => {
            if (!responded) resolve(undefined);
          }, 50);
        } else {
          resolve(undefined);
        }
      } catch (e) {
        resolve({ __error: String(e) });
      }
    });
  }

  return {
    send,
    window,
    document: window.document,
    context,
    disconnect() {
      messageListener = null;
    },
    get sentMessages() {
      return sentMessages;
    },
  };
}

// =============================================================================
// Group 1: SET — strict validation, no coercion/clamp of invalid
// =============================================================================

describe('VC_SPEED_SET — strict validation', () => {
  test('rejects NaN with status=error', async () => {
    const env = createEnv();
    const r = await env.send({ type: 'VC_SPEED_SET', speed: NaN });
    assert.equal(r.status, 'error');
    assert.equal(r.error, 'invalid speed value');
    assert.equal(r.count, 0);
    assert.equal(r.appliedSpeed, null);
    env.disconnect();
  });

  test('rejects Infinity with status=error', async () => {
    const env = createEnv();
    const r = await env.send({ type: 'VC_SPEED_SET', speed: Infinity });
    assert.equal(r.status, 'error');
    assert.equal(r.count, 0);
    env.disconnect();
  });

  test('rejects string even if numeric-like', async () => {
    const env = createEnv();
    const r = await env.send({ type: 'VC_SPEED_SET', speed: '1.5' });
    assert.equal(r.status, 'error');
    assert.equal(r.count, 0);
    env.disconnect();
  });

  test('rejects null/undefined', async () => {
    const env = createEnv();
    const r1 = await env.send({ type: 'VC_SPEED_SET', speed: null });
    assert.equal(r1.status, 'error');
    const r2 = await env.send({ type: 'VC_SPEED_SET', speed: undefined });
    assert.equal(r2.status, 'error');
    env.disconnect();
  });

  test('rejects out-of-range values (no clamp)', async () => {
    const env = createEnv();
    const r1 = await env.send({ type: 'VC_SPEED_SET', speed: 0.1 });
    assert.equal(r1.status, 'error');
    const r2 = await env.send({ type: 'VC_SPEED_SET', speed: 5 });
    assert.equal(r2.status, 'error');
    const r3 = await env.send({ type: 'VC_SPEED_SET', speed: -1 });
    assert.equal(r3.status, 'error');
    env.disconnect();
  });

  test('accepts valid 0.25–3.0 range with step rounding', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><video></video></body></html>' });
    const r = await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    assert.equal(r.status, 'ok');
    assert.equal(r.speed, 1.5);
    assert.equal(r.count, 1);
    env.disconnect();
  });

  test('rounds to nearest 0.05 step', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><video></video></body></html>' });
    const r = await env.send({ type: 'VC_SPEED_SET', speed: 1.025 });
    assert.equal(r.speed, 1.05);
    env.disconnect();
  });
});

// =============================================================================
// Group 2: GET — reports live playbackRate, not stale requested
// =============================================================================

describe('VC_SPEED_GET — honest reporting', () => {
  test('GET before any SET reports default and unsupported', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body></body></html>' });
    const r = await env.send({ type: 'VC_SPEED_GET' });
    assert.equal(r.status, 'unsupported');
    assert.equal(r.appliedSpeed, null);
    assert.equal(r.speed, 1);
    assert.equal(r.count, 0);
    env.disconnect();
  });

  test('GET after SET reports actual live playbackRate', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><video></video></body></html>' });
    await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    const video = env.document.querySelector('video');
    video.playbackRate = 2.0;
    const r = await env.send({ type: 'VC_SPEED_GET' });
    assert.equal(r.appliedSpeed, 2.0, 'GET should report actual live playbackRate');
    env.disconnect();
  });

  test('GET reports null when mixed actual rates', async () => {
    const env = createEnv({
      html: '<!DOCTYPE html><html><body><video></video><video></video></body></html>',
    });
    await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    const videos = env.document.querySelectorAll('video');
    videos[0].playbackRate = 1.5;
    videos[1].playbackRate = 2.0;
    const r = await env.send({ type: 'VC_SPEED_GET' });
    assert.equal(r.appliedSpeed, null, 'mixed rates should not invent a mean');
    env.disconnect();
  });
});

// =============================================================================
// Group 3: SET — clamp detection and error status
// =============================================================================

describe('VC_SPEED_SET — clamp and error', () => {
  test('reports clamp when site overrides playbackRate', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><video></video></body></html>' });
    const video = env.document.querySelector('video');
    let _rate = 1;
    Object.defineProperty(video, 'playbackRate', {
      get() {
        return _rate;
      },
      set(v) {
        _rate = Math.min(v, 2.0);
      },
      configurable: true,
    });
    const r = await env.send({ type: 'VC_SPEED_SET', speed: 3.0 });
    assert.equal(r.appliedSpeed, 2.0, 'should report actual clamped rate');
    assert.equal(r.clamp, true, 'clamp flag should be true');
    env.disconnect();
  });

  test('all-failed updates return status=error', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><video></video></body></html>' });
    const video = env.document.querySelector('video');
    Object.defineProperty(video, 'playbackRate', {
      get() {
        return 1;
      },
      set() {
        throw new Error('not allowed');
      },
      configurable: true,
    });
    const r = await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    assert.equal(r.status, 'error', 'all-failed should be error, not ok');
    env.disconnect();
  });
});

// =============================================================================
// Group 4: RESET — returns to default 1x
// =============================================================================

describe('VC_SPEED_RESET', () => {
  test('resets speed to default 1x', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><video></video></body></html>' });
    await env.send({ type: 'VC_SPEED_SET', speed: 2.0 });
    const r = await env.send({ type: 'VC_SPEED_RESET' });
    assert.equal(r.speed, 1);
    assert.equal(r.status, 'ok');
    assert.equal(r.count, 1);
    const video = env.document.querySelector('video');
    assert.equal(video.playbackRate, 1, 'video should be back to 1x');
    env.disconnect();
  });
});

// =============================================================================
// Group 5: Sender validation — browser.runtime.id
// =============================================================================

describe('Sender validation', () => {
  test('rejects messages from unknown extension ID', async () => {
    const env = createEnv({
      extId: 'media-tamer@example.invalid',
      senderId: 'other-extension@evil',
    });
    const r = await env.send({ type: 'VC_SPEED_SET', speed: NaN });
    assert.equal(r, undefined, 'unknown sender should be ignored');
    env.disconnect();
  });

  test('works when sender.id matches browser.runtime.id', async () => {
    const env = createEnv({ extId: 'media-tamer@example.invalid' });
    const r = await env.send({ type: 'VC_SPEED_SET', speed: NaN });
    assert.equal(r.status, 'error');
    env.disconnect();
  });
});

// =============================================================================
// Group 6: Init safety — no throw when documentElement missing
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
      id: 'media-tamer@example.invalid',
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

    const speedSrc = fs.readFileSync(SPEED_JS, 'utf8');
    assert.doesNotThrow(() => {
      vm.createContext(context);
      vm.runInContext(speedSrc, context, { filename: 'speed.js' });
    });
  });
});

// =============================================================================
// Group 7: No debug leaks
// =============================================================================

describe('No debug leaks', () => {
  test('no __vgSpeed global on window', () => {
    const env = createEnv();
    assert.equal(env.window.__vgSpeed, undefined, '__vgSpeed should not exist');
    env.disconnect();
  });

  test('no vg or __vg globals on window', () => {
    const env = createEnv();
    const keys = Object.keys(env.window).filter((k) => k.startsWith('vg') || k.startsWith('__vg'));
    assert.equal(keys.length, 0, 'no vg or __vg globals on window');
    env.disconnect();
  });
});

// =============================================================================
// Group 8: Dynamic video handling
// =============================================================================

describe('Dynamic video handling', () => {
  test('newly inserted video gets speed applied once', async () => {
    const env = createEnv();
    await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    const video = env.document.createElement('video');
    env.document.body.appendChild(video);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(video.playbackRate, 1.5, 'new video should have target speed');
    env.disconnect();
  });

  test('does not repeatedly fight site rate changes', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><video></video></body></html>' });
    await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    const video = env.document.querySelector('video');
    // Simulate site changing speed after extension applied it
    video.playbackRate = 2.0;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(video.playbackRate, 2.0, 'site change should not be overridden');
    env.disconnect();
  });
});

// =============================================================================
// Group 9: Firefox promise response
// =============================================================================

describe('Firefox promise response', () => {
  test('VC_SPEED_SET returns a response', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><video></video></body></html>' });
    const r = await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    assert.ok(r !== undefined, 'response should not be undefined');
    assert.equal(r.status, 'ok');
    env.disconnect();
  });
});

// =============================================================================
// Group 10: Status response shape — exact contract
// =============================================================================

describe('Status response shape', () => {
  test('VC_SPEED_SET returns exact contract shape', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><video></video></body></html>' });
    const r = await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    assert.equal(r.speed, 1.5);
    assert.equal(typeof r.appliedSpeed, 'number');
    assert.equal(typeof r.count, 'number');
    assert.ok(['ok', 'partial', 'unsupported', 'error'].includes(r.status));
    const allowed = new Set([
      'speed',
      'appliedSpeed',
      'count',
      'status',
      'error',
      'clamp',
      'countUnsupported',
      'countSkipped',
    ]);
    for (const key of Object.keys(r)) {
      assert.ok(allowed.has(key), `unexpected key: ${key}`);
    }
    env.disconnect();
  });

  test('VC_SPEED_GET returns exact contract shape', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><video></video></body></html>' });
    await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    const r = await env.send({ type: 'VC_SPEED_GET' });
    assert.equal(typeof r.speed, 'number');
    assert.equal(typeof r.count, 'number');
    assert.ok(['ok', 'unsupported', 'error'].includes(r.status));
    env.disconnect();
  });
});

// =============================================================================
// Group 11: Pitch preservation
// =============================================================================

describe('Pitch preservation', () => {
  test('sets preservesPitch on video element when supported', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><video></video></body></html>' });
    const video = env.document.querySelector('video');
    // Simulate a real browser that exposes preservesPitch
    Object.defineProperty(video, 'preservesPitch', {
      value: false,
      writable: true,
      configurable: true,
    });
    await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    assert.equal(video.preservesPitch, true, 'preservesPitch should be set true');
    env.disconnect();
  });
});

// =============================================================================
// Group 12: Shadow root best-effort
// =============================================================================

describe('Shadow root handling', () => {
  test('finds video inside an open shadow root', async () => {
    const env = createEnv({
      html: '<!DOCTYPE html><html><body><div id="host"></div></body></html>',
    });
    const host = env.document.getElementById('host');
    const shadow = host.attachShadow({ mode: 'open' });
    const video = env.document.createElement('video');
    shadow.appendChild(video);
    const r = await env.send({ type: 'VC_SPEED_SET', speed: 2.0 });
    assert.equal(r.count, 1, 'should find video in shadow root');
    assert.equal(video.playbackRate, 2.0);
    env.disconnect();
  });
});

// =============================================================================
// Group 13: Audio-only fallback
// =============================================================================

describe('Audio-only fallback', () => {
  test('applies speed to audio when no video present', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><audio></audio></body></html>' });
    const r = await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    assert.equal(r.count, 1);
    assert.equal(r.appliedSpeed, 1.5);
    env.disconnect();
  });

  test('ignores audio when video is present in same root', async () => {
    const env = createEnv({
      html: '<!DOCTYPE html><html><body><video></video><audio></audio></body></html>',
    });
    const r = await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    assert.equal(r.count, 1, 'only video should be matched, not audio');
    env.disconnect();
  });
});

// =============================================================================
// Group 14: Default untouched before SET
// =============================================================================

describe('Default untouched before SET', () => {
  test('video playbackRate remains at default before any SET', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><video></video></body></html>' });
    const video = env.document.querySelector('video');
    const r = await env.send({ type: 'VC_SPEED_GET' });
    assert.equal(video.playbackRate, 1, 'untouched video stays at 1x');
    assert.equal(r.appliedSpeed, null, 'no applied speed before SET');
    env.disconnect();
  });
});

// =============================================================================
// Group 15: Explicit setting re-applies to new but not unrelated mutations
// =============================================================================

describe('Re-application scope', () => {
  test('existing video keeps site-changed rate after unrelated DOM mutation', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><video></video></body></html>' });
    await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    const video = env.document.querySelector('video');
    // Site changes speed
    video.playbackRate = 0.5;
    // Unrelated DOM mutation
    const div = env.document.createElement('div');
    env.document.body.appendChild(div);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(video.playbackRate, 0.5, 'site-changed rate preserved after unrelated mutation');
    env.disconnect();
  });
});
