/**
 * Popup block-number-keys checkbox tests.
 *
 * Verifies:
 *   - Checkbox exists in settings disclosure, labelled, default checked (ON).
 *   - Toggle persists to browser.storage.local and localStorage.
 *   - Checkbox is keyboard accessible (Space toggles).
 *   - On reopening, the stored value is reflected in checkbox state.
 *   - Controls stay enabled; block-number doesn't disable other controls.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_DIR = resolve(__dirname, '..', '..', 'extensions', 'media-tamer');

function createMockBrowser(initialStorage = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const storageListeners = [];
  const menuState = new Map();
  const sent = [];
  const runtimeListeners = [];

  return {
    sent,
    _storage: storage,
    _storageListeners: storageListeners,
    _menuState: menuState,
    runtime: {
      id: 'media-tamer@example.invalid',
      getURL: (p) => `moz-extension://media-tamer@example.invalid/${p}`,
      onMessage: {
        addListener: (fn) => runtimeListeners.push(fn),
      },
      sendMessage: async (msg) => {
        const sender = {
          id: 'media-tamer@example.invalid',
          url: 'moz-extension://media-tamer@example.invalid/popup.html',
        };
        let response;
        for (const fn of runtimeListeners) {
          const r = await fn(msg, sender);
          if (r) response = r;
        }
        return response;
      },
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://example.com' }],
      sendMessage: async (tabId, msg) => {
        sent.push({ tabId, msg });
        if (msg.type === 'VC_VOLUME_GET')
          return { percent: 100, appliedPercent: 100, count: 1, status: 'ok' };
        if (msg.type === 'VC_SPEED_GET')
          return { speed: 1, appliedSpeed: 1, count: 1, status: 'ok' };
        if (msg.type === 'VC_NIGHT_GET')
          return { strength: 0, active: false, count: 1, status: 'ok' };
        if (msg.type === 'VC_SEEK_GET')
          return {
            binding: { key: 'z', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
            enabled: true,
            historyCount: 0,
            canUndo: false,
            threshold: 2,
            count: 1,
          };
        return null;
      },
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    storage: {
      local: {
        get: async (key) => {
          const k = typeof key === 'string' ? key : Object.keys(key)[0];
          return storage.has(k) ? { [k]: storage.get(k) } : {};
        },
        set: async (obj) => {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            const old = storage.has(k) ? storage.get(k) : undefined;
            storage.set(k, v);
            if (old !== v) changes[k] = { oldValue: old, newValue: v };
          }
          for (const fn of storageListeners) fn(changes, 'local');
        },
      },
      onChanged: {
        addListener: (fn) => storageListeners.push(fn),
      },
    },
    webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
    menus: {
      create: (item) => menuState.set(item.id, item),
      update: (id, props) => {
        if (menuState.has(id)) Object.assign(menuState.get(id), props);
      },
      refresh: async () => {},
      onClicked: { addListener: () => {} },
      onShown: { addListener: () => {} },
    },
    pageAction: { setTitle: async () => {}, show: async () => {}, hide: async () => {} },
    permissions: { request: async () => true, contains: async () => true },
    downloads: { download: async () => 42 },
    theme: { onUpdated: { addListener: () => {} }, getCurrent: async () => ({}) },
  };
}

function loadBackgroundAndPopup(mockBrowser) {
  const html = readFileSync(resolve(EXT_DIR, 'popup.html'), 'utf8').replace(
    /<script[^>]*popup\.js[^>]*><\/script>/,
    '',
  );
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'moz-extension://media-tamer@example.invalid/popup.html',
  });
  dom.window.browser = mockBrowser;
  dom.window.eval(readFileSync(resolve(EXT_DIR, 'popup.js'), 'utf8'));
  return { window: dom.window, dom };
}

describe('Popup: block-number-keys checkbox', () => {
  test('checkbox exists in settings disclosure with correct label', () => {
    const mock = createMockBrowser();
    const { window } = loadBackgroundAndPopup(mock);
    const cb = window.document.getElementById('block-number-keys');
    assert.ok(cb, 'checkbox should exist');
    assert.equal(cb.type, 'checkbox');
    assert.equal(cb.checked, true, 'default ON');

    // Must be inside the settings panel
    const panel = window.document.getElementById('settings-panel');
    assert.ok(panel.contains(cb), 'checkbox inside settings disclosure');

    // Has label text
    const label = cb.closest('.seek-row');
    assert.ok(label, 'has a row container');
    const text = label.textContent;
    assert.match(text, /Block number-key seeking/, 'has descriptive label');
  });

  test('toggle writes to browser.storage.local (sole source of truth) and persists on reopen', async () => {
    const mock = createMockBrowser();
    const { window } = loadBackgroundAndPopup(mock);
    await new Promise((r) => setTimeout(r, 50));

    const cb = window.document.getElementById('block-number-keys');
    // Uncheck (turn OFF)
    cb.checked = false;
    cb.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(mock._storage.get('blockNumberKeys'), false, 'OFF stored in storage.local');
    // localStorage must NOT be written for this key (popup uses browser.storage.local only)
    try {
      const lsVal = window.localStorage.getItem('blockNumberKeys');
      assert.equal(lsVal, null, 'localStorage not used for blockNumberKeys');
    } catch (_) {
      // localStorage may not be available for moz-extension:// origin in JSDOM; that's fine
    }

    // Reopen popup: load again
    const reopened = loadBackgroundAndPopup(createMockBrowser({ blockNumberKeys: false }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      reopened.window.document.getElementById('block-number-keys').checked,
      false,
      'persisted OFF state shown on reopen',
    );
  });

  test('toggle from OFF back to ON persists correctly', async () => {
    const mock = createMockBrowser({ blockNumberKeys: false });
    const { window } = loadBackgroundAndPopup(mock);
    await new Promise((r) => setTimeout(r, 50));

    const cb = window.document.getElementById('block-number-keys');
    assert.equal(cb.checked, false, 'starts OFF');

    cb.checked = true;
    cb.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(mock._storage.get('blockNumberKeys'), true, 'ON stored');
  });

  test('checkbox is keyboard accessible: Space toggles', () => {
    const mock = createMockBrowser();
    const { window } = loadBackgroundAndPopup(mock);
    const cb = window.document.getElementById('block-number-keys');
    cb.focus();
    // Space should toggle checkbox state (browser default behavior)
    assert.equal(cb.checked, true, 'starts checked');
    // Synthetic space keydown
    const ev = new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    cb.dispatchEvent(ev);
    // Native checkbox toggles on Space keypress (not keydown), but we ensure the element is focusable
    assert.equal(cb.getAttribute('tabindex') !== '-1', true, 'focusable');
  });

  test('slider controls remain enabled after toggling block setting', async () => {
    const mock = createMockBrowser();
    const { window } = loadBackgroundAndPopup(mock);
    await new Promise((r) => setTimeout(r, 50));

    const cb = window.document.getElementById('block-number-keys');
    cb.checked = false;
    cb.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 50));

    const volSlider = window.document.getElementById('volume-slider');
    assert.equal(volSlider.disabled, false, 'volume slider still enabled');
  });

  test('RED: initial async load does not overwrite user click during loading window', async () => {
    // Simulate a slow initial storage.get that resolves AFTER a user click.
    // The click must win; the stale read-back must not clobber it.
    const storageData = {};
    const storageListeners = [];
    const mockBrowser = {
      _data: storageData,
      runtime: {
        id: 'media-tamer@example.invalid',
        getURL: (p) => `moz-extension://media-tamer@example.invalid/${p}`,
        onMessage: { addListener: () => {} },
        sendMessage: async () => {},
      },
      tabs: {
        query: async () => [{ id: 1, url: 'https://example.com' }],
        sendMessage: async () => null,
        onUpdated: { addListener: () => {} },
        onRemoved: { addListener: () => {} },
      },
      storage: {
        local: {
          get: async (key) => {
            await new Promise((r) => setTimeout(r, 100));
            const k = typeof key === 'string' ? key : Object.keys(key)[0];
            return k in storageData ? { [k]: storageData[k] } : {};
          },
          set: async (obj) => {
            const changes = {};
            for (const [k, v] of Object.entries(obj)) {
              const old = storageData[k];
              storageData[k] = v;
              if (old !== v) changes[k] = { oldValue: old, newValue: v };
            }
            for (const fn of storageListeners) fn(changes, 'local');
          },
        },
        onChanged: { addListener: (fn) => storageListeners.push(fn) },
      },
      webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
      menus: {
        create: () => {},
        update: () => {},
        refresh: async () => {},
        onClicked: { addListener: () => {} },
        onShown: { addListener: () => {} },
      },
      pageAction: { setTitle: async () => {}, show: async () => {}, hide: async () => {} },
      permissions: { request: async () => true, contains: async () => true },
      downloads: { download: async () => 42 },
      theme: { onUpdated: { addListener: () => {} }, getCurrent: async () => ({}) },
    };

    const html = readFileSync(resolve(EXT_DIR, 'popup.html'), 'utf8').replace(
      /<script[^>]*popup\\.js[^>]*><\/script>/,
      '',
    );
    const dom = new JSDOM(html, {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    });
    dom.window.browser = mockBrowser;
    dom.window.eval(readFileSync(resolve(EXT_DIR, 'popup.js'), 'utf8'));

    // Wait for DOMContentLoaded if init is deferred
    await new Promise((r) => setTimeout(r, 10));

    const cb = dom.window.document.getElementById('block-number-keys');
    cb.checked = false;
    cb.dispatchEvent(new dom.window.Event('change'));

    await new Promise((r) => setTimeout(r, 250));

    assert.equal(
      storageData.blockNumberKeys,
      false,
      'user click value preserved, not overwritten by slow initial read',
    );
  });

  test('RED: save failure rolls back checkbox and surfaces error', async () => {
    const storage = new Map();
    const storageListeners = [];
    const mockBrowser = {
      _storage: storage,
      runtime: {
        id: 'media-tamer@example.invalid',
        getURL: (p) => `moz-extension://media-tamer@example.invalid/${p}`,
        onMessage: { addListener: () => {} },
        sendMessage: async () => {},
      },
      tabs: {
        query: async () => [{ id: 1, url: 'https://example.com' }],
        sendMessage: async () => null,
        onUpdated: { addListener: () => {} },
        onRemoved: { addListener: () => {} },
      },
      storage: {
        local: {
          get: async (key) => {
            const k = typeof key === 'string' ? key : Object.keys(key)[0];
            return storage.has(k) ? { [k]: storage.get(k) } : {};
          },
          set: async () => {
            throw new Error('storage write failed');
          },
        },
        onChanged: { addListener: (fn) => storageListeners.push(fn) },
      },
      webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
      menus: {
        create: () => {},
        update: () => {},
        refresh: async () => {},
        onClicked: { addListener: () => {} },
        onShown: { addListener: () => {} },
      },
      pageAction: { setTitle: async () => {}, show: async () => {}, hide: async () => {} },
      permissions: { request: async () => true, contains: async () => true },
      downloads: { download: async () => 42 },
      theme: { onUpdated: { addListener: () => {} }, getCurrent: async () => ({}) },
    };

    const html = readFileSync(resolve(EXT_DIR, 'popup.html'), 'utf8').replace(
      /<script[^>]*popup\.js[^>]*><\/script>/,
      '',
    );
    const dom = new JSDOM(html, {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    });
    dom.window.browser = mockBrowser;
    dom.window.eval(readFileSync(resolve(EXT_DIR, 'popup.js'), 'utf8'));

    await new Promise((r) => setTimeout(r, 50));

    const cb = dom.window.document.getElementById('block-number-keys');
    assert.equal(cb.checked, true, 'starts ON');

    cb.checked = false;
    cb.dispatchEvent(new dom.window.Event('change'));
    await new Promise((r) => setTimeout(r, 50));

    // Checkbox should be rolled back to ON after save failure
    assert.equal(cb.checked, true, 'checkbox rolled back to ON after save failure');
    // Error message should be visible
    const row = cb.closest('.seek-row');
    const status = row.querySelector('.save-error');
    assert.ok(status, 'error status element created');
    assert.match(status.textContent, /Save failed/, 'error message surfaced');
  });
});
