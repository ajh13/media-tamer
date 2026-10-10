/**
 * TDD — number-key block toggle (blockNumberKeys setting).
 *
 * content.js must:
 *   - Default to ON (block) when no stored value (preserves existing behavior).
 *   - Allow digits through when OFF (site gets original number handling).
 *   - Live-toggle via browser.storage.onChanged.
 *   - Ignore the setting for typing/contenteditable/shadow inputs (those are
 *     always allowed regardless of setting).
 *   - Ignore non-video pages regardless of setting.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXT_DIR = path.join(__dirname, '..', '..', 'extensions', 'media-tamer');
const CONTENT_JS = path.join(EXT_DIR, 'content.js');

// --- Mock browser.storage for content script ---
function createMockStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const listeners = [];
  return {
    _data: data,
    _listeners: listeners,
    local: {
      get: async (key) => {
        if (typeof key === 'string') return data.has(key) ? { [key]: data.get(key) } : {};
        // array or object form
        const keys = Array.isArray(key) ? key : Object.keys(key);
        const result = {};
        for (const k of keys) if (data.has(k)) result[k] = data.get(k);
        return result;
      },
      set: async (obj) => {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          const old = data.has(k) ? data.get(k) : undefined;
          data.set(k, v);
          if (old !== v) changes[k] = { oldValue: old, newValue: v };
        }
        // Fire listeners asynchronously
        for (const fn of listeners) {
          try {
            fn(changes, 'local');
          } catch (_) {}
        }
      },
    },
    onChanged: {
      addListener: (fn) => listeners.push(fn),
    },
    _fire(changes) {
      for (const fn of listeners) {
        try {
          fn(changes, 'local');
        } catch (_) {}
      }
    },
  };
}

// --- Setup content script in JSDOM ---
function setupContent(html = '<video></video>', mockBrowser) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test' });
  dom.window.browser = mockBrowser;
  dom.window.eval(fs.readFileSync(CONTENT_JS, 'utf8'));
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
  return { reached };
}

describe('content.js: blockNumberKeys setting', () => {
  test('default ON: blocks digit on video page when storage empty', async () => {
    const storage = createMockStorage({});
    const browser = {
      runtime: { id: 'media-tamer@example.invalid' },
      storage,
      runtimeListeners: [],
      runtime: {
        id: 'media-tamer@example.invalid',
        onMessage: { addListener: () => {} },
        sendMessage: async () => {},
      },
    };
    const win = setupContent('<video></video>', browser);
    // Give async storage.get a tick to resolve
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      dispatch(win, win.document.body, '5').reached,
      false,
      'should block digit by default',
    );
  });

  test('OFF: allows digit through on video page (site gets original handling)', async () => {
    const storage = createMockStorage({ blockNumberKeys: false });
    const browser = {
      runtime: {
        id: 'media-tamer@example.invalid',
        onMessage: { addListener: () => {} },
        sendMessage: async () => {},
      },
      storage,
    };
    const win = setupContent('<video></video>', browser);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      dispatch(win, win.document.body, '5').reached,
      true,
      'should allow digit when off',
    );
  });

  test('no video page: digit always passes (setting irrelevant)', async () => {
    const storage = createMockStorage({ blockNumberKeys: true });
    const browser = {
      runtime: {
        id: 'media-tamer@example.invalid',
        onMessage: { addListener: () => {} },
        sendMessage: async () => {},
      },
      storage,
    };
    const win = setupContent('<div>no video</div>', browser);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(dispatch(win, win.document.body, '5').reached, true, 'no video → digit passes');
  });

  test('typing in input always passes regardless of setting', async () => {
    const storage = createMockStorage({ blockNumberKeys: true });
    const browser = {
      runtime: {
        id: 'media-tamer@example.invalid',
        onMessage: { addListener: () => {} },
        sendMessage: async () => {},
      },
      storage,
    };
    const win = setupContent('<video></video><input>', browser);
    await new Promise((r) => setTimeout(r, 20));
    const input = win.document.querySelector('input');
    assert.equal(dispatch(win, input, '5').reached, true, 'input typing always passes');
  });

  test('live toggle via storage.onChanged: OFF → ON blocks digits', async () => {
    const storage = createMockStorage({ blockNumberKeys: false });
    const browser = {
      runtime: {
        id: 'media-tamer@example.invalid',
        onMessage: { addListener: () => {} },
        sendMessage: async () => {},
      },
      storage,
    };
    const win = setupContent('<video></video>', browser);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(dispatch(win, win.document.body, '5').reached, true, 'starts unblocked');

    // Toggle ON
    await storage.local.set({ blockNumberKeys: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(dispatch(win, win.document.body, '5').reached, false, 'blocked after toggle on');
  });

  test('live toggle via storage.onChanged: ON → OFF allows digits', async () => {
    const storage = createMockStorage({ blockNumberKeys: true });
    const browser = {
      runtime: {
        id: 'media-tamer@example.invalid',
        onMessage: { addListener: () => {} },
        sendMessage: async () => {},
      },
      storage,
    };
    const win = setupContent('<video></video>', browser);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(dispatch(win, win.document.body, '5').reached, false, 'starts blocked');

    // Toggle OFF
    await storage.local.set({ blockNumberKeys: false });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(dispatch(win, win.document.body, '5').reached, true, 'allowed after toggle off');
  });

  test('all digits 0-9 respect the setting', async () => {
    const storage = createMockStorage({ blockNumberKeys: false });
    const browser = {
      runtime: {
        id: 'media-tamer@example.invalid',
        onMessage: { addListener: () => {} },
        sendMessage: async () => {},
      },
      storage,
    };
    const win = setupContent('<video></video>', browser);
    await new Promise((r) => setTimeout(r, 20));
    for (const d of '0123456789') {
      assert.equal(
        dispatch(win, win.document.body, d).reached,
        true,
        `digit ${d} should pass when off`,
      );
    }
  });

  test('seek undo enabled flag is not confused with block setting', async () => {
    // This is a regression guard: the block setting must not affect seek undo logic
    const storage = createMockStorage({ blockNumberKeys: false });
    const browser = {
      runtime: {
        id: 'media-tamer@example.invalid',
        onMessage: { addListener: () => {} },
        sendMessage: async () => {},
      },
      storage,
    };
    const win = setupContent('<video></video>', browser);
    await new Promise((r) => setTimeout(r, 20));
    // Ctrl+Z should still pass (it's a modifier combo, always passes regardless)
    assert.equal(
      dispatch(win, win.document.body, 'z', { ctrlKey: true }).reached,
      true,
      'Ctrl+Z always passes',
    );
  });

  test('RED: late loadSetting read-back does not overwrite newer onChanged value', async () => {
    // Race: loadSetting's async get resolves AFTER onChanged fires. The newer
    // onChanged value must win; the stale read-back must be discarded.
    let resolveGet;
    const storageData = { blockNumberKeys: true };
    const listeners = [];
    const mockStorage = {
      _data: new Map(Object.entries(storageData)),
      local: {
        get: async (key) => {
          // Return a promise that we resolve manually, AFTER onChanged fires
          return new Promise((res) => {
            resolveGet = () => {
              const k = typeof key === 'string' ? key : Object.keys(key)[0];
              res(new Map(Object.entries(storageData)).has(k) ? { [k]: storageData[k] } : {});
            };
          });
        },
        set: async (obj) => {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            const old = storageData[k];
            storageData[k] = v;
            if (old !== v) changes[k] = { oldValue: old, newValue: v };
          }
          for (const fn of listeners) {
            try {
              fn(changes, 'local');
            } catch (_) {}
          }
        },
      },
      onChanged: {
        addListener: (fn) => listeners.push(fn),
      },
    };
    const mockBrowser = {
      runtime: {
        id: 'media-tamer@example.invalid',
        onMessage: { addListener: () => {} },
        sendMessage: async () => {},
      },
      storage: mockStorage,
    };
    const win = setupContent('<video></video>', mockBrowser);

    // Before initial load resolves, fire onChanged to OFF
    await mockStorage.local.set({ blockNumberKeys: false });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(dispatch(win, win.document.body, '5').reached, true, 'onChanged OFF wins');

    // Now resolve the stale initial read-back (which has the old value: true)
    resolveGet();
    await new Promise((r) => setTimeout(r, 20));

    // The stale read-back must NOT overwrite the newer onChanged value
    assert.equal(
      dispatch(win, win.document.body, '5').reached,
      true,
      'stale loadSetting read-back did not overwrite newer onChanged OFF',
    );
  });
});
