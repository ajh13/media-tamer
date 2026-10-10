/**
 * Video Number Guard — Speed feature tests.
 *
 * Evaluates the ACTUAL content script (speed.js) via Node vm + JSDOM,
 * stubbing browser.runtime so real message handlers, MutationObserver wiring,
 * and init paths run end-to-end — not just pure helper functions.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'vm';
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEED_JS = path.resolve(
  __dirname,
  '..',
  'extensions',
  'media-tamer',
  'speed.js'
);

/**
 * Build a sandbox backed by a JSDOM window (so document/MutationObserver/etc.
 * resolve via prototype chain), but allow explicit overrides (like `browser`).
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

  let sentMessages = [];
  let messageListeners = [];

  const runtime = {
    id: extId,
    onMessage: {
      addListener(fn) {
        messageListeners.push(fn);
      },
    },
    sendMessage(msg) {
      sentMessages.push(msg);
      return Promise.resolve();
    },
  };

  // Create a sandbox whose prototype is the window. This way:
  // - `document`, `MutationObserver`, `setTimeout`, etc. resolve via window.
  // - `browser` can be set directly on the sandbox as a global.
  const sandbox = Object.create(window);
  sandbox.browser = { runtime };
  sandbox.console = window.console;
  sandbox.setTimeout = window.setTimeout;
  sandbox.clearTimeout = window.clearTimeout;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;

  if (opts.readyState === 'loading') {
    Object.defineProperty(document, 'readyState', {
      get() { return 'loading'; },
      configurable: true,
    });
  }

  const speedSrc = fs.readFileSync(SPEED_JS, 'utf8');
  const context = vm.createContext(sandbox);
  vm.runInContext(speedSrc, context, { filename: 'speed.js' });

  function send(msg) {
    return new Promise((resolve) => {
      let responded = false;
      const sendResponse = (resp) => {
        responded = true;
        resolve(resp);
      };
      const sender = {
        id: opts.senderId !== undefined ? opts.senderId : extId,
        tab: { id: 1 },
        frameId: 0,
        url: 'https://example.com/',
      };
      let handled = false;
      for (const listener of messageListeners) {
        try {
          const result = listener(msg, sender, sendResponse);
          if (result === true) {
            handled = true;
            break;
          }
        } catch (_) {}
      }
      if (!handled) {
        resolve(undefined);
        return;
      }
      if (!responded) {
        setTimeout(() => {
          if (!responded) resolve(undefined);
        }, 50);
      }
    });
  }

  return {
    send,
    runtime,
    window,
    document,
    sandbox,
    disconnect() { messageListeners = []; },
    get sentMessages() { return sentMessages; },
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
      get() { return _rate; },
      set(v) { _rate = Math.min(v, 2.0); },
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
      get() { return 1; },
      set() { throw new Error('not allowed'); },
      configurable: true,
    });
    const r = await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    assert.equal(r.status, 'error', 'all-failed should be error, not ok');
    env.disconnect();
  });
});

// =============================================================================
// Group 4: Sender validation — browser.runtime.id
// =============================================================================

describe('Sender validation', () => {
  test('rejects messages from unknown extension ID', async () => {
    const env = createEnv({ extId: 'media-tamer@example.invalid', senderId: 'other-extension@evil' });
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
// Group 5: Init safety — no throw when documentElement missing
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
      sendMessage() { return Promise.resolve(); },
    };

    const sandbox = Object.create(window);
    sandbox.browser = { runtime };
    sandbox.console = window.console;
    sandbox.setTimeout = window.setTimeout;
    sandbox.clearTimeout = window.clearTimeout;
    sandbox.window = sandbox;

    const speedSrc = fs.readFileSync(SPEED_JS, 'utf8');
    assert.doesNotThrow(() => {
      vm.runInContext(speedSrc, vm.createContext(sandbox), { filename: 'speed.js' });
    });
  });
});

// =============================================================================
// Group 6: No debug leaks
// =============================================================================

describe('No debug leaks', () => {
  test('no __vgSpeed global on window', () => {
    const env = createEnv();
    assert.equal(env.window.__vgSpeed, undefined, '__vgSpeed should not exist');
    assert.equal(env.sandbox.__vgSpeed, undefined);
    env.disconnect();
  });

  test('no vg or __vg globals on window', () => {
    const env = createEnv();
    const keys = Object.keys(env.window).filter(
      (k) => k.startsWith('vg') || k.startsWith('__vg')
    );
    assert.equal(keys.length, 0, 'no vg or __vg globals on window');
    env.disconnect();
  });
});

// =============================================================================
// Group 7: Dynamic video handling
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
    video.playbackRate = 2.0;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(video.playbackRate, 2.0, 'site change should not be overridden');
    env.disconnect();
  });
});

// =============================================================================
// Group 8: Firefox promise response
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
// Group 9: Status response shape — exact contract
// =============================================================================

describe('Status response shape', () => {
  test('VC_SPEED_SET returns exact contract shape', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><video></video></body></html>' });
    const r = await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    assert.equal(r.speed, 1.5);
    assert.equal(typeof r.appliedSpeed, 'number');
    assert.equal(typeof r.count, 'number');
    assert.ok(['ok', 'partial', 'unsupported', 'error'].includes(r.status));
    const allowed = new Set(['speed', 'appliedSpeed', 'count', 'status', 'error', 'clamp', 'countUnsupported', 'countSkipped']);
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
// Group 10: Pitch preservation
// =============================================================================

describe('Pitch preservation', () => {
  test('sets preservesPitch on video element', async () => {
    const env = createEnv({ html: '<!DOCTYPE html><html><body><video></video></body></html>' });
    await env.send({ type: 'VC_SPEED_SET', speed: 1.5 });
    const video = env.document.querySelector('video');
    assert.equal(video.preservesPitch, true, 'preservesPitch should be true');
    env.disconnect();
  });
});
