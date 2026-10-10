/**
 * Controls UI runtime tests — verifies popup command routing through background
 * to tabs.sendMessage, right-clicked tab targeting, promise response rendering,
 * sender rejection, navigation reset, and seek binding persistence.
 *
 * Uses jsdom + VM to mock browser APIs and load actual classic IIFE files.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
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
          case 'VC_RESET_ALL':
            cs.volume = 100;
            cs.speed = 1;
            cs.night = 0;
            return {
              volume: { percent: 100, appliedPercent: 100, count: 1, status: 'ok' },
              speed: { speed: 1, appliedSpeed: 1, count: 1, status: 'ok' },
              night: { strength: 0, active: false, count: 1, status: 'ok' },
            };
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

// --- Load popup.js into a jsdom window ---
function loadPopup(html, mockBrowser) {
  const cleanHtml = html.replace(/<script[^>]*popup\.js[^>]*><\/script>/, '');
  const dom = new JSDOM(cleanHtml, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://example.com',
  });
  const { window } = dom;
  window.browser = mockBrowser;
  const code = fs.readFileSync(path.join(EXT_DIR, 'popup.js'), 'utf8');
  window.eval(code);
  return { dom, window };
}

// --- Tests ---

describe('Background: popup command routing', () => {
  let mock, browser, sentMessages;

  beforeEach(() => {
    mock = createMockBrowser();
    browser = mock.browser;
    sentMessages = mock.sentMessages;
    loadBackground(browser);
  });

  test('VC_VOLUME_SET routes to tabs.sendMessage with frameId', async () => {
    sentMessages.length = 0;
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
    const volMsg = sentMessages.find((s) => s.msg.type === 'VC_VOLUME_SET');
    assert.ok(volMsg, 'Should send VC_VOLUME_SET to content');
    assert.equal(volMsg.tabId, 1);
    assert.equal(volMsg.msg.percent, 150);
    assert.equal(volMsg.opts.frameId, 0);
  });

  test('VC_SPEED_SET routes to tabs.sendMessage', async () => {
    sentMessages.length = 0;
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    for (const fn of mock.listeners.runtimeOnMessage) {
      await fn({ type: 'VC_SPEED_SET', speed: 1.5, tabId: 1 }, sender);
    }
    const speedMsg = sentMessages.find((s) => s.msg.type === 'VC_SPEED_SET');
    assert.ok(speedMsg);
    assert.equal(speedMsg.msg.speed, 1.5);
  });

  test('VC_NIGHT_SET routes to tabs.sendMessage', async () => {
    sentMessages.length = 0;
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    for (const fn of mock.listeners.runtimeOnMessage) {
      await fn({ type: 'VC_NIGHT_SET', strength: 35, tabId: 1 }, sender);
    }
    const nightMsg = sentMessages.find((s) => s.msg.type === 'VC_NIGHT_SET');
    assert.ok(nightMsg);
    assert.equal(nightMsg.msg.strength, 35);
  });

  test('VC_VOLUME_GET returns aggregated response', async () => {
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    let response;
    for (const fn of mock.listeners.runtimeOnMessage) {
      const r = await fn({ type: 'VC_VOLUME_GET', tabId: 1 }, sender);
      if (r) response = r;
    }
    assert.ok(response);
    assert.equal(response.status, 'ok');
    assert.equal(response.count, 1);
  });

  test('invalid percent rejected without sending to content', async () => {
    sentMessages.length = 0;
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
    assert.ok(!sentMessages.find((s) => s.msg.type === 'VC_VOLUME_SET'));
  });

  test('invalid speed rejected', async () => {
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    let response;
    for (const fn of mock.listeners.runtimeOnMessage) {
      const r = await fn({ type: 'VC_SPEED_SET', speed: 5, tabId: 1 }, sender);
      if (r) response = r;
    }
    assert.equal(response.error, 'invalid speed');
  });

  test('invalid night strength rejected', async () => {
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    let response;
    for (const fn of mock.listeners.runtimeOnMessage) {
      const r = await fn({ type: 'VC_NIGHT_SET', strength: 200, tabId: 1 }, sender);
      if (r) response = r;
    }
    assert.equal(response.error, 'invalid night strength');
  });
});

describe('Background: sender validation', () => {
  let mock, browser;
  beforeEach(() => {
    mock = createMockBrowser();
    browser = mock.browser;
    loadBackground(browser);
  });

  test('rejects messages from unrelated extension', async () => {
    let response;
    for (const fn of mock.listeners.runtimeOnMessage) {
      const r = await fn({ type: 'VC_VOLUME_SET', percent: 150, tabId: 1 }, { id: 'other@evil' });
      if (r) response = r;
    }
    assert.equal(response, undefined);
  });

  test('rejects popup without matching URL', async () => {
    let response;
    for (const fn of mock.listeners.runtimeOnMessage) {
      const r = await fn(
        { type: 'VC_VOLUME_SET', percent: 150, tabId: 1 },
        { id: 'media-tamer@example.invalid', url: 'https://evil.com' },
      );
      if (r) response = r;
    }
    assert.equal(response, undefined);
  });

  test('rejects content script commands (no loop) — content sender has id and tab', async () => {
    let response;
    for (const fn of mock.listeners.runtimeOnMessage) {
      const r = await fn(
        { type: 'VC_VOLUME_SET', percent: 150, tabId: 1 },
        { id: 'media-tamer@example.invalid', tab: { id: 1 } },
      );
      if (r) response = r;
    }
    assert.equal(response, undefined);
  });

  test('accepts popup origin commands with correct URL', async () => {
    let response;
    for (const fn of mock.listeners.runtimeOnMessage) {
      const r = await fn(
        { type: 'VC_VOLUME_GET', tabId: 1 },
        {
          id: 'media-tamer@example.invalid',
          url: 'moz-extension://media-tamer@example.invalid/popup.html',
        },
      );
      if (r) response = r;
    }
    assert.ok(response);
  });

  test('rejects sender with tab property (content-style)', async () => {
    let response;
    for (const fn of mock.listeners.runtimeOnMessage) {
      const r = await fn(
        { type: 'VC_VOLUME_GET', tabId: 1 },
        {
          id: 'media-tamer@example.invalid',
          url: 'moz-extension://media-tamer@example.invalid/popup.html',
          tab: { id: 1 },
        },
      );
      if (r) response = r;
    }
    assert.equal(response, undefined);
  });
});

describe('Background: tab lifecycle', () => {
  let mock, browser;
  beforeEach(() => {
    mock = createMockBrowser();
    browser = mock.browser;
    loadBackground(browser);
  });

  test('tab close resets state', async () => {
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

  test('navigation resets state', async () => {
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    for (const fn of mock.listeners.runtimeOnMessage) {
      await fn({ type: 'VC_VOLUME_SET', percent: 200, tabId: 1 }, sender);
    }
    for (const fn of mock.listeners.tabsOnUpdated)
      fn(1, { status: 'loading' }, { id: 1, url: 'https://example.com' });
    let response;
    for (const fn of mock.listeners.runtimeOnMessage) {
      const r = await fn({ type: 'VC_VOLUME_GET', tabId: 1 }, sender);
      if (r) response = r;
    }
    assert.equal(response.percent, 100);
  });
});

describe('Background: context menu right-clicked tab targeting', () => {
  let mock, browser, menuItems;
  beforeEach(() => {
    mock = createMockBrowser();
    browser = mock.browser;
    menuItems = mock.menuItems;
    loadBackground(browser);
  });

  test('menu click targets right-clicked tab (info.tabId)', async () => {
    mock.sentMessages.length = 0;
    for (const fn of mock.listeners.menusOnClicked) {
      await fn({ menuItemId: 'vg-volume-150', tabId: 5 }, { id: 5, url: 'https://example.com' });
    }
    await new Promise((r) => setTimeout(r, 10));
    const volMsg = mock.sentMessages.find((s) => s.msg.type === 'VC_VOLUME_SET');
    assert.ok(volMsg, 'Should send volume message');
    assert.equal(volMsg.tabId, 5);
    assert.equal(volMsg.msg.percent, 150);
  });

  test('menu click uses tab.id when info.tabId missing', async () => {
    mock.sentMessages.length = 0;
    for (const fn of mock.listeners.menusOnClicked) {
      await fn({ menuItemId: 'vg-speed-2' }, { id: 7, url: 'https://example.com' });
    }
    await new Promise((r) => setTimeout(r, 10));
    const speedMsg = mock.sentMessages.find((s) => s.msg.type === 'VC_SPEED_SET');
    assert.ok(speedMsg);
    assert.equal(speedMsg.tabId, 7);
  });

  test('onShown updates menu titles with current state', async () => {
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    for (const fn of mock.listeners.runtimeOnMessage) {
      await fn({ type: 'VC_VOLUME_SET', percent: 200, tabId: 3 }, sender);
    }
    for (const fn of mock.listeners.menusOnShown) {
      await fn({ tabId: 3 }, { id: 3, url: 'https://example.com' });
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(menuItems.get('vg-volume-200').checked, true);
    assert.match(menuItems.get('vg-volume').title, /200/);
  });
});

describe('Background: seek binding persistence', () => {
  let mock, browser, storage;
  beforeEach(() => {
    mock = createMockBrowser();
    browser = mock.browser;
    storage = mock.storage;
    loadBackground(browser);
  });

  test('VC_SEEK_CONFIG saves binding to storage', async () => {
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    const binding = { key: 'x', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
    for (const fn of mock.listeners.runtimeOnMessage) {
      await fn({ type: 'VC_SEEK_CONFIG', binding, enabled: true, tabId: 1 }, sender);
    }
    assert.ok(storage.has('seekBinding'));
    const saved = storage.get('seekBinding');
    assert.equal(saved.key, 'x');
    assert.equal(saved.ctrlKey, true);
    assert.equal(saved.shiftKey, true);
    assert.equal(saved.metaKey, false);
  });

  test('VC_SEEK_CONFIG preserves ctrl vs meta distinction', async () => {
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    const binding = { key: 'z', ctrlKey: false, shiftKey: false, altKey: false, metaKey: true };
    for (const fn of mock.listeners.runtimeOnMessage) {
      await fn({ type: 'VC_SEEK_CONFIG', binding, enabled: true }, sender);
    }
    const saved = storage.get('seekBinding');
    assert.equal(saved.metaKey, true);
    assert.equal(saved.ctrlKey, false);
  });

  test('VC_SEEK_GET restores binding from storage when content unavailable', async () => {
    storage.set('seekBinding', {
      key: 'y',
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      metaKey: false,
    });

    browser.tabs.sendMessage = async (tabId, msg) => {
      mock.sentMessages.push({ tabId, msg });
      return null;
    };

    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    let response;
    for (const fn of mock.listeners.runtimeOnMessage) {
      const r = await fn({ type: 'VC_SEEK_GET', tabId: 1 }, sender);
      if (r) response = r;
    }
    assert.ok(response);
    assert.equal(response.binding.key, 'y');
    assert.equal(response.binding.altKey, true);
  });

  test('VC_SEEK_GET returns content binding when available', async () => {
    storage.set('seekBinding', {
      key: 'y',
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      metaKey: false,
    });
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    let response;
    for (const fn of mock.listeners.runtimeOnMessage) {
      const r = await fn({ type: 'VC_SEEK_GET', tabId: 1 }, sender);
      if (r) response = r;
    }
    assert.ok(response);
    assert.equal(response.binding.key, 'z');
    assert.equal(response.canUndo, false);
  });

  test('VC_SEEK_CONFIG sends binding to frames', async () => {
    mock.sentMessages.length = 0;
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    const binding = { key: 'z', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };
    for (const fn of mock.listeners.runtimeOnMessage) {
      await fn({ type: 'VC_SEEK_CONFIG', binding, enabled: true, tabId: 1 }, sender);
    }
    const seekMsg = mock.sentMessages.find((s) => s.msg.type === 'VC_SEEK_CONFIG');
    assert.ok(seekMsg);
    assert.equal(seekMsg.msg.binding.ctrlKey, true);
  });
});

describe('Background: seek undo targets frame with history', () => {
  let mock, browser;
  beforeEach(() => {
    mock = createMockBrowser();
    browser = mock.browser;
    loadBackground(browser);
  });

  test('VC_SEEK_UNDO sends to frame that has history', async () => {
    mock.getContentState(1).seekHistory = 1;
    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    let response;
    for (const fn of mock.listeners.runtimeOnMessage) {
      const r = await fn({ type: 'VC_SEEK_UNDO', tabId: 1 }, sender);
      if (r) response = r;
    }
    assert.ok(response);
    assert.equal(response.success, true);
    assert.equal(response.restoredTo, 10);
  });
});

describe('Popup: command rendering', () => {
  let mock, browser, win;
  beforeEach(async () => {
    mock = createMockBrowser();
    browser = mock.browser;
    loadBackground(browser);
    const html = fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8');
    const result = loadPopup(html, browser);
    win = result.window;
    await new Promise((r) => setTimeout(r, 50));
  });

  test('renders volume value from response', () => {
    assert.equal(win.document.getElementById('volume-value').textContent, '100%');
  });

  test('renders speed value from response', () => {
    assert.equal(win.document.getElementById('speed-value').textContent, '1.00x');
  });

  test('renders peaks value from response', () => {
    assert.equal(win.document.getElementById('peaks-value').textContent, 'Off');
  });

  test('volume slider input sends command', async () => {
    mock.sentMessages.length = 0;
    const slider = win.document.getElementById('volume-slider');
    slider.value = '150';
    slider.dispatchEvent(new win.Event('input'));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(
      mock.sentMessages.find((s) => s.msg.type === 'VC_VOLUME_SET' && s.msg.percent === 150),
    );
  });

  test('volume step plus sends command', async () => {
    mock.sentMessages.length = 0;
    // Find the volume row's plus button
    const volRow = win.document.querySelector('[data-control="volume"]');
    const plusBtn = volRow.querySelector('.plus');
    plusBtn.click();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(
      mock.sentMessages.find((s) => s.msg.type === 'VC_VOLUME_SET' && s.msg.percent === 105),
    );
  });

  test('reset all button resets volume, peaks, and speed', async () => {
    mock.sentMessages.length = 0;
    // First set non-default values
    const slider = win.document.getElementById('volume-slider');
    slider.value = '200';
    slider.dispatchEvent(new win.Event('input'));
    await new Promise((r) => setTimeout(r, 50));
    mock.sentMessages.length = 0;
    // Now click reset all
    win.document.getElementById('reset-all').click();
    await new Promise((r) => setTimeout(r, 50));
    // Reset all broadcasts VC_VOLUME_SET=100, VC_SPEED_SET=1, VC_NIGHT_SET=0
    const volMsg = mock.sentMessages.find((s) => s.msg.type === 'VC_VOLUME_SET');
    const speedMsg = mock.sentMessages.find((s) => s.msg.type === 'VC_SPEED_SET');
    const nightMsg = mock.sentMessages.find((s) => s.msg.type === 'VC_NIGHT_SET');
    assert.ok(volMsg, 'should send volume reset');
    assert.ok(speedMsg, 'should send speed reset');
    assert.ok(nightMsg, 'should send peaks reset');
    assert.equal(volMsg.msg.percent, 100);
    assert.equal(speedMsg.msg.speed, 1);
    assert.equal(nightMsg.msg.strength, 0);
    // UI should reflect reset
    assert.equal(win.document.getElementById('volume-value').textContent, '100%');
    assert.equal(win.document.getElementById('peaks-value').textContent, 'Off');
    assert.equal(win.document.getElementById('speed-value').textContent, '1.00x');
  });

  test('seek undo button disabled when no history', () => {
    assert.equal(win.document.getElementById('seek-undo').disabled, true);
  });

  test('seek binding display shows default Ctrl+Z', () => {
    assert.equal(win.document.getElementById('seek-binding').textContent, 'Ctrl+Z');
  });
});

describe('Popup: unsupported media state', () => {
  let mock, browser, win;
  beforeEach(async () => {
    mock = createMockBrowser();
    browser = mock.browser;
    browser.tabs.sendMessage = async (tabId, msg) => {
      mock.sentMessages.push({ tabId, msg });
      if (['VC_VOLUME_GET', 'VC_SPEED_GET', 'VC_NIGHT_GET'].includes(msg.type)) {
        return { count: 0, status: 'unsupported' };
      }
      if (msg.type === 'VC_SEEK_GET') {
        return {
          binding: { key: 'z', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
          enabled: true,
          historyCount: 0,
          canUndo: false,
          threshold: 2,
          count: 0,
        };
      }
      return { count: 0, status: 'unsupported' };
    };
    loadBackground(browser);
    const html = fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8');
    const result = loadPopup(html, browser);
    win = result.window;
    await new Promise((r) => setTimeout(r, 50));
  });

  test('shows "No media" status when unsupported', () => {
    assert.equal(win.document.getElementById('volume-status').textContent, 'No media');
  });

  test('shows "Off" for peaks when unsupported', () => {
    assert.equal(win.document.getElementById('peaks-status').textContent, 'Off');
  });
});

describe('Popup: reopening renders promise responses', () => {
  let mock, browser;
  beforeEach(() => {
    mock = createMockBrowser();
    browser = mock.browser;
    loadBackground(browser);
  });

  test('reopening popup re-queries and renders fresh state', async () => {
    const html = fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8');

    loadPopup(html, browser);
    await new Promise((r) => setTimeout(r, 50));

    const sender = {
      id: 'media-tamer@example.invalid',
      url: 'moz-extension://media-tamer@example.invalid/popup.html',
    };
    for (const fn of mock.listeners.runtimeOnMessage) {
      await fn({ type: 'VC_VOLUME_SET', percent: 250, tabId: 1 }, sender);
    }

    const { window: win2 } = loadPopup(html, browser);
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(win2.document.getElementById('volume-value').textContent, '250%');
  });
});

describe('Popup: controls disabled until ready', () => {
  let mock, browser, win;
  beforeEach(async () => {
    mock = createMockBrowser();
    browser = mock.browser;
    browser.tabs.sendMessage = async (tabId, msg) => {
      await new Promise((r) => setTimeout(r, 30));
      mock.sentMessages.push({ tabId, msg });
      if (msg.type === 'VC_VOLUME_GET')
        return { percent: 100, appliedPercent: 100, count: 1, status: 'ok' };
      if (msg.type === 'VC_SPEED_GET') return { speed: 1, appliedSpeed: 1, count: 1, status: 'ok' };
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
    };
    loadBackground(browser);
    const html = fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8');
    const result = loadPopup(html, browser);
    win = result.window;
  });

  test('controls disabled initially', () => {
    assert.equal(win.document.getElementById('volume-slider').disabled, true);
  });

  test('controls enabled after responses arrive', async () => {
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(win.document.getElementById('volume-slider').disabled, false);
  });
});

describe('Popup: key capture validation', () => {
  let mock, browser, win;
  beforeEach(async () => {
    mock = createMockBrowser();
    browser = mock.browser;
    loadBackground(browser);
    const html = fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8');
    const result = loadPopup(html, browser);
    win = result.window;
    await new Promise((r) => setTimeout(r, 50));
  });

  function pressKey(target, key, mods = {}) {
    const ev = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
    target.dispatchEvent(ev);
    return ev;
  }

  test('Escape cancels capture without changing binding', () => {
    win.document.getElementById('seek-capture').click();
    pressKey(win.document, 'Escape');
    assert.equal(win.document.getElementById('seek-binding').textContent, 'Ctrl+Z');
  });

  test('modifier-only key is ignored during capture', () => {
    win.document.getElementById('seek-capture').click();
    pressKey(win.document, 'Control', { ctrlKey: true });
    // Should still be in capture mode — binding unchanged
    assert.equal(win.document.getElementById('seek-binding').textContent, 'Ctrl+Z');
  });

  test('unmodified digit is rejected during capture', () => {
    win.document.getElementById('seek-capture').click();
    pressKey(win.document, '5');
    assert.equal(win.document.getElementById('seek-binding').textContent, 'Ctrl+Z');
  });

  test('valid Ctrl+Shift+X binding is accepted', () => {
    win.document.getElementById('seek-capture').click();
    pressKey(win.document, 'x', { ctrlKey: true, shiftKey: true });
    assert.equal(win.document.getElementById('seek-binding').textContent, 'Ctrl+Shift+X');
  });
});

describe('Popup: Media Roller download button', () => {
  let mock, browser, win;
  beforeEach(async () => {
    mock = createMockBrowser();
    browser = mock.browser;
    loadBackground(browser);
    const html = fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8');
    const result = loadPopup(html, browser);
    win = result.window;
    await new Promise((r) => setTimeout(r, 50));
  });

  test('download button exists and is wired', () => {
    const btn = win.document.getElementById('mr-download');
    assert.ok(btn, 'Download button should exist');
    assert.match(btn.textContent, /Download/);
  });

  test('settings toggle shows settings panel', () => {
    const toggle = win.document.getElementById('settings-toggle');
    const panel = win.document.getElementById('settings-panel');
    assert.ok(toggle);
    assert.ok(panel);
    assert.equal(panel.open, false);
    toggle.click();
    assert.equal(panel.open, true);
    toggle.click();
    assert.equal(panel.open, false);
  });

  test('appearance select exists with system/light/dark', () => {
    const select = win.document.getElementById('appearance-select');
    assert.ok(select);
    const values = Array.from(select.options).map((o) => o.value);
    assert.deepEqual(values, ['system', 'light', 'dark']);
  });

  test('Seek shortcut + Media Roller are inside settings disclosure', () => {
    const panel = win.document.getElementById('settings-panel');
    assert.ok(panel);
    assert.ok(panel.querySelector('#seek-binding'), 'seek shortcut inside settings');
    assert.ok(panel.querySelector('#mr-baseurl'), 'mr url inside settings');
    assert.ok(panel.querySelector('#mr-save'), 'mr save inside settings');
  });

  test('URL input and save button exist', () => {
    assert.ok(win.document.getElementById('mr-baseurl'));
    assert.ok(win.document.getElementById('mr-save'));
  });

  test('settings disclosure is collapsed by default', () => {
    const panel = win.document.getElementById('settings-panel');
    assert.ok(panel);
    assert.equal(panel.open, false);
  });
});
