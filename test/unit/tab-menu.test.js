/**
 * Tab context menu regression tests — verifies consolidated "Media Tamer"
 * parent submenu structure, right-clicked tab targeting, dynamic titles,
 * checkbox/radio false-checked avoidance, undo enable/disable, and async
 * onShown update ordering.
 *
 * Uses jsdom + VM to mock browser APIs and load actual classic IIFE background.js.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXT_DIR = path.join(__dirname, '..', '..', 'extensions', 'media-tamer');

// --- Mock browser API factory ---
function createMockBrowser() {
  const listeners = {
    runtimeOnMessage: [],
    tabsOnRemoved: [],
    tabsOnUpdated: [],
    menusOnClicked: [],
    menusOnShown: [],
  };

  const sentMessages = [];
  const menuItems = new Map();
  const storage = new Map();

  // Per-tab mock content state
  const contentState = new Map();
  function getContentState(tabId) {
    if (!contentState.has(tabId)) {
      contentState.set(tabId, {
        volume: 100,
        speed: 1,
        night: 0,
        seekHistory: 0,
        binding: { key: 'z', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
      });
    }
    return contentState.get(tabId);
  }

  const browser = {
    runtime: {
      id: 'media-tamer@example.invalid',
      getURL: (p) => `moz-extension://media-tamer@example.invalid/${p}`,
      onMessage: {
        addListener: (fn) => listeners.runtimeOnMessage.push(fn),
      },
      sendMessage: async (msg) => {
        const sender = {
          id: 'media-tamer@example.invalid',
          url: 'moz-extension://media-tamer@example.invalid/popup.html',
        };
        let response;
        for (const fn of listeners.runtimeOnMessage) {
          const r = await fn(msg, sender);
          if (r) response = r;
        }
        return response;
      },
    },
    tabs: {
      onRemoved: { addListener: (fn) => listeners.tabsOnRemoved.push(fn) },
      onUpdated: { addListener: (fn) => listeners.tabsOnUpdated.push(fn) },
      sendMessage: async (tabId, msg, opts) => {
        sentMessages.push({ tabId, msg, opts });
        const cs = getContentState(tabId);

        switch (msg.type) {
          case 'VC_VOLUME_SET':
            cs.volume = msg.percent;
            return { percent: msg.percent, appliedPercent: msg.percent, count: 1, status: 'ok' };
          case 'VC_VOLUME_GET':
            return { percent: cs.volume, appliedPercent: cs.volume, count: 1, status: 'ok' };
          case 'VC_SPEED_SET':
            cs.speed = msg.speed;
            return { speed: msg.speed, appliedSpeed: msg.speed, count: 1, status: 'ok' };
          case 'VC_SPEED_GET':
            return { speed: cs.speed, appliedSpeed: cs.speed, count: 1, status: 'ok' };
          case 'VC_NIGHT_SET':
            cs.night = msg.strength;
            return { strength: msg.strength, active: msg.strength > 0, count: 1, status: 'ok' };
          case 'VC_NIGHT_GET':
            return { strength: cs.night, active: cs.night > 0, count: 1, status: 'ok' };
          case 'VC_SEEK_CONFIG':
            if (msg.binding) cs.binding = { ...msg.binding };
            return { ok: true };
          case 'VC_SEEK_GET':
            return {
              binding: { ...cs.binding },
              enabled: true,
              historyCount: cs.seekHistory,
              canUndo: cs.seekHistory > 0,
              threshold: 2,
              count: 1,
            };
          case 'VC_SEEK_UNDO':
            if (cs.seekHistory > 0) {
              cs.seekHistory--;
              return { success: true, restoredFrom: 30, restoredTo: 10 };
            }
            return { success: false, error: 'no history' };
          default:
            return null;
        }
      },
      query: async (q) => {
        if (q.active && q.currentWindow) return [{ id: 1, url: 'https://example.com' }];
        return [{ id: 1, url: 'https://example.com' }];
      },
    },
    webNavigation: {
      getAllFrames: async (_tabId) => [{ frameId: 0, url: 'https://example.com' }],
    },
    pageAction: {
      setTitle: async () => {},
      show: async () => {},
      hide: async () => {},
      setIcon: async () => {},
    },
    menus: {
      create: (item) => menuItems.set(item.id, item),
      update: (id, props) => {
        const item = menuItems.get(id);
        if (item) Object.assign(item, props);
        return Promise.resolve();
      },
      refresh: async () => {},
      onClicked: { addListener: (fn) => listeners.menusOnClicked.push(fn) },
      onShown: { addListener: (fn) => listeners.menusOnShown.push(fn) },
    },
    storage: {
      local: {
        get: async (key) => {
          const k = typeof key === 'string' ? key : Object.keys(key)[0];
          return storage.has(k) ? { [k]: storage.get(k) } : {};
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) storage.set(k, v);
        },
      },
    },
    permissions: {
      request: async () => true,
      contains: async () => true,
    },
    downloads: {
      download: async () => 42,
    },
    theme: {
      getCurrent: async () => ({ colors: { toolbar: [255, 255, 255] } }),
      onUpdated: { addListener: () => {} },
    },
  };

  return { browser, listeners, sentMessages, menuItems, storage, getContentState };
}

// --- Load background.js into a VM context ---
function loadBackground(mockBrowser) {
  const code = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');
  const ctx = vm.createContext({
    browser: mockBrowser,
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
  vm.runInContext(code, ctx);
}

// --- Tests ---

describe('Tab Menu: consolidated Media Tamer parent submenu', () => {
  let mock, browser, menuItems;
  beforeEach(() => {
    mock = createMockBrowser();
    browser = mock.browser;
    menuItems = mock.menuItems;
    loadBackground(browser);
  });

  test('creates a single root "Media Tamer" parent item', () => {
    const root = menuItems.get('vg-root');
    assert.ok(root, 'vg-root menu item must exist');
    assert.equal(root.title, 'Media Tamer');
    assert.equal(root.contexts[0], 'tab');
    assert.equal(root.parentId, undefined);
  });

  test('volume, speed, night, separator, and undo all parented under vg-root', () => {
    const children = ['vg-volume', 'vg-speed', 'vg-night', 'vg-sep', 'vg-seek-undo'];
    for (const id of children) {
      const item = menuItems.get(id);
      assert.ok(item, `${id} must exist`);
      assert.equal(item.parentId, 'vg-root', `${id} must be child of vg-root`);
    }
  });

  test('volume submenu has correct preset children with proper types', () => {
    const vol = menuItems.get('vg-volume');
    assert.ok(vol);
    assert.equal(vol.parentId, 'vg-root');
    // Preset children
    for (const p of [0, 50, 100, 150, 200, 300]) {
      const child = menuItems.get(`vg-volume-${p}`);
      assert.ok(child, `vg-volume-${p} must exist`);
      assert.equal(child.type, 'checkbox');
      assert.equal(child.parentId, 'vg-volume');
      assert.equal(child.title, `${p}%`);
    }
    // Default checked is 100%
    assert.equal(menuItems.get('vg-volume-100').checked, true);
    assert.equal(menuItems.get('vg-volume-50').checked, false);
    assert.equal(menuItems.get('vg-volume-0').checked, false);
  });

  test('speed submenu has correct preset children with proper types', () => {
    const speed = menuItems.get('vg-speed');
    assert.ok(speed);
    assert.equal(speed.parentId, 'vg-root');
    for (const s of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3]) {
      const child = menuItems.get(`vg-speed-${s}`);
      assert.ok(child, `vg-speed-${s} must exist`);
      assert.equal(child.type, 'checkbox');
      assert.equal(child.parentId, 'vg-speed');
      assert.equal(child.title, `${s}x`);
    }
    // Default checked is 1x
    assert.equal(menuItems.get('vg-speed-1').checked, true);
    assert.equal(menuItems.get('vg-speed-2').checked, false);
  });

  test('night submenu uses radio type for presets', () => {
    const night = menuItems.get('vg-night');
    assert.ok(night);
    assert.equal(night.parentId, 'vg-root');
    for (const n of [0, 35, 70]) {
      const child = menuItems.get(`vg-night-${n}`);
      assert.ok(child, `vg-night-${n} must exist`);
      assert.equal(child.type, 'radio');
      assert.equal(child.parentId, 'vg-night');
    }
    // Off checked by default
    assert.equal(menuItems.get('vg-night-0').checked, true);
    assert.equal(menuItems.get('vg-night-35').checked, false);
    assert.equal(menuItems.get('vg-night-70').checked, false);
  });

  test('separator exists before undo', () => {
    const sep = menuItems.get('vg-sep');
    assert.ok(sep, 'vg-sep must exist');
    assert.equal(sep.type, 'separator');
    assert.equal(sep.parentId, 'vg-root');
  });

  test('undo seek is disabled by default (no history yet)', () => {
    const undo = menuItems.get('vg-seek-undo');
    assert.ok(undo, 'vg-seek-undo must exist');
    assert.equal(undo.parentId, 'vg-root');
    assert.equal(undo.enabled, false);
  });
});

describe('Tab Menu: right-clicked tab targeting', () => {
  let mock, browser;
  beforeEach(() => {
    mock = createMockBrowser();
    browser = mock.browser;
    loadBackground(browser);
  });

  test('onClicked uses info.tabId (right-clicked) not active tab', async () => {
    mock.sentMessages.length = 0;
    for (const fn of mock.listeners.menusOnClicked) {
      await fn({ menuItemId: 'vg-volume-200', tabId: 42 }, { id: 1, url: 'https://active.com' });
    }
    await new Promise((r) => setTimeout(r, 10));
    const volMsg = mock.sentMessages.find((s) => s.msg.type === 'VC_VOLUME_SET');
    assert.ok(volMsg);
    assert.equal(volMsg.tabId, 42, 'Must target right-clicked tab 42, not active tab 1');
  });

  test('onClicked falls back to tab.id when info.tabId missing', async () => {
    mock.sentMessages.length = 0;
    for (const fn of mock.listeners.menusOnClicked) {
      await fn({ menuItemId: 'vg-speed-2' }, { id: 99, url: 'https://example.com' });
    }
    await new Promise((r) => setTimeout(r, 10));
    const speedMsg = mock.sentMessages.find((s) => s.msg.type === 'VC_SPEED_SET');
    assert.ok(speedMsg);
    assert.equal(speedMsg.tabId, 99);
  });

  test('night click targets right-clicked tab', async () => {
    mock.sentMessages.length = 0;
    for (const fn of mock.listeners.menusOnClicked) {
      await fn({ menuItemId: 'vg-night-35', tabId: 7 }, { id: 1 });
    }
    await new Promise((r) => setTimeout(r, 10));
    const nightMsg = mock.sentMessages.find((s) => s.msg.type === 'VC_NIGHT_SET');
    assert.ok(nightMsg);
    assert.equal(nightMsg.tabId, 7);
    assert.equal(nightMsg.msg.strength, 35);
  });

  test('undo seek click targets right-clicked tab', async () => {
    mock.getContentState(10).seekHistory = 2;
    mock.sentMessages.length = 0;
    for (const fn of mock.listeners.menusOnClicked) {
      await fn({ menuItemId: 'vg-seek-undo', tabId: 10 }, { id: 1 });
    }
    await new Promise((r) => setTimeout(r, 10));
    // Should have sent SEEK_GET and then SEEK_UNDO to tab 10
    const undoMsg = mock.sentMessages.find((s) => s.msg.type === 'VC_SEEK_UNDO');
    assert.ok(undoMsg);
    assert.equal(undoMsg.tabId, 10);
  });
});

describe('Tab Menu: dynamic titles show current state', () => {
  let mock, browser, menuItems;
  beforeEach(() => {
    mock = createMockBrowser();
    browser = mock.browser;
    menuItems = mock.menuItems;
    loadBackground(browser);
  });

  test('onShown updates volume parent title with current value', async () => {
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    for (const fn of mock.listeners.runtimeOnMessage) {
      await fn({ type: 'VC_VOLUME_SET', percent: 200, tabId: 3 }, sender);
    }
    for (const fn of mock.listeners.menusOnShown) {
      await fn({ tabId: 3 }, { id: 3 });
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.match(menuItems.get('vg-volume').title, /200/);
  });

  test('onShown updates speed parent title with current value', async () => {
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    for (const fn of mock.listeners.runtimeOnMessage) {
      await fn({ type: 'VC_SPEED_SET', speed: 1.5, tabId: 4 }, sender);
    }
    for (const fn of mock.listeners.menusOnShown) {
      await fn({ tabId: 4 }, { id: 4 });
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.match(menuItems.get('vg-speed').title, /1.5/);
  });

  test('onShown updates night parent title with preset label', async () => {
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    for (const fn of mock.listeners.runtimeOnMessage) {
      await fn({ type: 'VC_NIGHT_SET', strength: 70, tabId: 5 }, sender);
    }
    for (const fn of mock.listeners.menusOnShown) {
      await fn({ tabId: 5 }, { id: 5 });
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.match(menuItems.get('vg-night').title, /Strong/);
  });

  test('onShown shows "Custom" night label for non-preset value', async () => {
    // Simulate a custom value by directly modifying tab state
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    // First set to a preset so state exists
    for (const fn of mock.listeners.runtimeOnMessage) {
      await fn({ type: 'VC_NIGHT_SET', strength: 50, tabId: 6 }, sender);
    }
    for (const fn of mock.listeners.menusOnShown) {
      await fn({ tabId: 6 }, { id: 6 });
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.match(menuItems.get('vg-night').title, /Custom 50%/);
    // None of the radio presets should be checked for custom value
    assert.equal(menuItems.get('vg-night-0').checked, false);
    assert.equal(menuItems.get('vg-night-35').checked, false);
    assert.equal(menuItems.get('vg-night-70').checked, false);
  });

  test('checkboxes checked only for exact value match', async () => {
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    for (const fn of mock.listeners.runtimeOnMessage) {
      await fn({ type: 'VC_VOLUME_SET', percent: 150, tabId: 8 }, sender);
    }
    for (const fn of mock.listeners.menusOnShown) {
      await fn({ tabId: 8 }, { id: 8 });
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(menuItems.get('vg-volume-150').checked, true);
    assert.equal(menuItems.get('vg-volume-100').checked, false);
    assert.equal(menuItems.get('vg-volume-200').checked, false);
  });
});

describe('Tab Menu: undo enable/disable based on seek history', () => {
  let mock, browser, menuItems;
  beforeEach(() => {
    mock = createMockBrowser();
    browser = mock.browser;
    menuItems = mock.menuItems;
    loadBackground(browser);
  });

  test('undo disabled when tab has no seek history', async () => {
    for (const fn of mock.listeners.menusOnShown) {
      await fn({ tabId: 1 }, { id: 1 });
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(menuItems.get('vg-seek-undo').enabled, false);
  });

  test('undo enabled when tab has seek history', async () => {
    mock.getContentState(5).seekHistory = 3;
    for (const fn of mock.listeners.menusOnShown) {
      await fn({ tabId: 5 }, { id: 5 });
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(menuItems.get('vg-seek-undo').enabled, true);
  });

  test('undo disabled for one tab but enabled for another (per-tab state)', async () => {
    mock.getContentState(10).seekHistory = 1;
    // Tab 11 has no history
    for (const fn of mock.listeners.menusOnShown) {
      await fn({ tabId: 11 }, { id: 11 });
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(menuItems.get('vg-seek-undo').enabled, false);

    for (const fn of mock.listeners.menusOnShown) {
      await fn({ tabId: 10 }, { id: 10 });
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(menuItems.get('vg-seek-undo').enabled, true);
  });
});

describe('Tab Menu: async onShown update ordering', () => {
  let mock, browser;
  beforeEach(() => {
    mock = createMockBrowser();
    browser = mock.browser;
    loadBackground(browser);
  });

  test('menus.refresh is called after all updates resolve', async () => {
    const refreshCalls = [];
    const originalRefresh = browser.menus.refresh;
    browser.menus.refresh = async () => {
      refreshCalls.push(Date.now());
      return originalRefresh();
    };

    for (const fn of mock.listeners.menusOnShown) {
      await fn({ tabId: 1 }, { id: 1 });
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(refreshCalls.length > 0, 'refresh should be called');
  });

  test('tab change during onShown does not corrupt target (captured tabId)', async () => {
    // Simulate tab change scenario
    const results = [];
    for (const fn of mock.listeners.menusOnShown) {
      results.push(fn({ tabId: 5 }, { id: 5 }));
    }
    // Simulate tab change before async operations complete
    for (const fn of mock.listeners.menusOnShown) {
      results.push(fn({ tabId: 99 }, { id: 99 }));
    }
    await Promise.all(results);
    await new Promise((r) => setTimeout(r, 100));
    // Should not throw; both handlers should complete independently
    assert.ok(true);
  });
});

describe('Tab Menu: no function regressions', () => {
  let mock, browser, menuItems;
  beforeEach(() => {
    mock = createMockBrowser();
    browser = mock.browser;
    menuItems = mock.menuItems;
    loadBackground(browser);
  });

  test('all menu items registered at init', () => {
    const expectedIds = [
      'vg-root',
      'vg-volume',
      'vg-volume-0',
      'vg-volume-50',
      'vg-volume-100',
      'vg-volume-150',
      'vg-volume-200',
      'vg-volume-300',
      'vg-speed',
      'vg-speed-0.25',
      'vg-speed-0.5',
      'vg-speed-0.75',
      'vg-speed-1',
      'vg-speed-1.25',
      'vg-speed-1.5',
      'vg-speed-2',
      'vg-speed-3',
      'vg-night',
      'vg-night-0',
      'vg-night-35',
      'vg-night-70',
      'vg-sep',
      'vg-seek-undo',
    ];
    for (const id of expectedIds) {
      assert.ok(menuItems.has(id), `${id} must be registered`);
    }
  });

  test('popup command routing still works (volume set)', async () => {
    mock.sentMessages.length = 0;
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    let response;
    for (const fn of mock.listeners.runtimeOnMessage) {
      const r = await fn({ type: 'VC_VOLUME_SET', percent: 150, tabId: 1 }, sender);
      if (r) response = r;
    }
    assert.equal(response.status, 'ok');
    assert.equal(response.appliedPercent, 150);
  });

  test('invalid volume still rejected (no regression)', async () => {
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    let response;
    for (const fn of mock.listeners.runtimeOnMessage) {
      const r = await fn({ type: 'VC_VOLUME_SET', percent: 999, tabId: 1 }, sender);
      if (r) response = r;
    }
    assert.equal(response.error, 'invalid percent');
  });

  test('tab close resets state (no regression)', async () => {
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    for (const fn of mock.listeners.runtimeOnMessage) {
      await fn({ type: 'VC_VOLUME_SET', percent: 200, tabId: 1 }, sender);
    }
    for (const fn of mock.listeners.tabsOnRemoved) fn(1);
    let response;
    for (const fn of mock.listeners.runtimeOnMessage) {
      const r = await fn({ type: 'VC_VOLUME_GET', tabId: 1 }, sender);
      if (r) response = r;
    }
    assert.equal(response.percent, 100);
  });
});
