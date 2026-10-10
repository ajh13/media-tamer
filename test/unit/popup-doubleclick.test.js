/**
 * Popup double-click slider reset — TDD tests.
 *
 * Verifies that double-clicking a slider surface resets that specific control
 * to its default value (volume=100, peaks=0, speed=1), that stale sequenced
 * responses cannot overwrite the reset, that sibling controls are untouched,
 * and that keyboard plusminus step buttons still work after a reset.
 *
 * Uses jsdom + VM to mock browser APIs and load actual popup.js + background.js.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
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
  };

  const sentMessages = [];
  const contentState = new Map();
  const storage = new Map();

  function getContentState(tabId) {
    if (!contentState.has(tabId)) {
      contentState.set(tabId, { volume: 100, speed: 1, night: 0 });
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
          default:
            return null;
        }
      },
      query: async () => [{ id: 1, url: 'https://example.com' }],
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
    permissions: { request: async () => true },
    menus: {
      create: () => {},
      update: () => Promise.resolve(),
      refresh: async () => {},
      onClicked: { addListener: () => {} },
      onShown: { addListener: () => {} },
    },
    pageAction: {
      setTitle: async () => {},
      show: async () => {},
      hide: async () => {},
      setIcon: async () => {},
    },
    webNavigation: {
      getAllFrames: async () => [{ frameId: 0, url: 'https://example.com' }],
    },
    theme: {
      getCurrent: async () => ({ colors: { toolbar_field: '#ffffff' } }),
      onUpdated: { addListener: () => {} },
    },
  };

  return { browser, listeners, sentMessages, getContentState };
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

describe('Popup: double-click slider reset', () => {
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

  afterEach(() => {
    if (win) win.close();
  });

  // --- Volume ---

  test('double-click volume surface resets volume to 100%', async () => {
    // Set volume to 200 first
    const slider = win.document.getElementById('volume-slider');
    slider.value = '200';
    slider.dispatchEvent(new win.Event('input'));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(win.document.getElementById('volume-value').textContent, '200%');

    // Double-click the volume surface
    const surface = win.document.getElementById('volume-surface');
    surface.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(win.document.getElementById('volume-value').textContent, '100%');
    assert.equal(slider.value, '100');
    // Verify command was sent to background
    const volMsg = mock.sentMessages.find(
      (s) => s.msg.type === 'VC_VOLUME_SET' && s.msg.percent === 100,
    );
    assert.ok(volMsg, 'should send VC_VOLUME_SET=100 to content');
  });

  // --- Peaks ---

  test('double-click peaks surface resets peaks to 0 (Off)', async () => {
    // Set peaks to 70 first
    const slider = win.document.getElementById('peaks-slider');
    slider.value = '70';
    slider.dispatchEvent(new win.Event('input'));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(win.document.getElementById('peaks-value').textContent, '70%');

    // Double-click the peaks surface
    const surface = win.document.getElementById('peaks-surface');
    surface.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(win.document.getElementById('peaks-value').textContent, 'Off');
    assert.equal(slider.value, '0');
    const nightMsg = mock.sentMessages.find(
      (s) => s.msg.type === 'VC_NIGHT_SET' && s.msg.strength === 0,
    );
    assert.ok(nightMsg, 'should send VC_NIGHT_SET=0 to content');
  });

  // --- Speed ---

  test('double-click speed surface resets speed to 1x', async () => {
    // Set speed to 2.5 first
    const slider = win.document.getElementById('speed-slider');
    slider.value = '2.5';
    slider.dispatchEvent(new win.Event('input'));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(win.document.getElementById('speed-value').textContent, '2.50x');

    // Double-click the speed surface
    const surface = win.document.getElementById('speed-surface');
    surface.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(win.document.getElementById('speed-value').textContent, '1.00x');
    assert.equal(slider.value, '1');
    const speedMsg = mock.sentMessages.find(
      (s) => s.msg.type === 'VC_SPEED_SET' && s.msg.speed === 1,
    );
    assert.ok(speedMsg, 'should send VC_SPEED_SET=1 to content');
  });

  // --- Isolation ---

  test('double-click volume does not affect peaks or speed', async () => {
    // Set all three to non-default
    const volSlider = win.document.getElementById('volume-slider');
    const peaksSlider = win.document.getElementById('peaks-slider');
    const speedSlider = win.document.getElementById('speed-slider');

    volSlider.value = '200';
    volSlider.dispatchEvent(new win.Event('input'));
    peaksSlider.value = '50';
    peaksSlider.dispatchEvent(new win.Event('input'));
    speedSlider.value = '2';
    speedSlider.dispatchEvent(new win.Event('input'));
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(win.document.getElementById('volume-value').textContent, '200%');
    assert.equal(win.document.getElementById('peaks-value').textContent, '50%');
    assert.equal(win.document.getElementById('speed-value').textContent, '2.00x');

    // Double-click volume only
    win.document
      .getElementById('volume-surface')
      .dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    // Volume reset, others unchanged
    assert.equal(win.document.getElementById('volume-value').textContent, '100%');
    assert.equal(win.document.getElementById('peaks-value').textContent, '50%');
    assert.equal(win.document.getElementById('speed-value').textContent, '2.00x');
  });

  // --- Stale input protection ---

  test('stale sequenced response does not overwrite double-click reset', async () => {
    // Make the first VC_VOLUME_SET response delayed so we can race it
    const originalSendMessage = browser.tabs.sendMessage;
    let delayFirst = true;
    browser.tabs.sendMessage = async (tabId, msg, opts) => {
      if (delayFirst && msg.type === 'VC_VOLUME_SET' && msg.percent === 200) {
        delayFirst = false;
        await new Promise((r) => setTimeout(r, 30));
      }
      return originalSendMessage(tabId, msg, opts);
    };

    // Set volume to 200 (starts async, will be delayed 30ms)
    const slider = win.document.getElementById('volume-slider');
    slider.value = '200';
    slider.dispatchEvent(new win.Event('input'));

    // Immediately double-click to reset (should not be overwritten)
    await new Promise((r) => setTimeout(r, 5));
    win.document
      .getElementById('volume-surface')
      .dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));

    // Wait for both operations to complete
    await new Promise((r) => setTimeout(r, 50));

    // The delayed 200 response must NOT overwrite the 100 reset
    assert.equal(win.document.getElementById('volume-value').textContent, '100%');
  });

  // --- Keyboard plusminus preservation ---

  test('keyboard plusminus step buttons still work after double-click reset', async () => {
    // Double-click volume to reset
    win.document
      .getElementById('volume-surface')
      .dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(win.document.getElementById('volume-value').textContent, '100%');

    // Press plus button
    const volRow = win.document.querySelector('[data-control="volume"]');
    const plusBtn = volRow.querySelector('.plus');
    plusBtn.click();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(win.document.getElementById('volume-value').textContent, '105%');

    // Press minus button
    const minusBtn = volRow.querySelector('.minus');
    minusBtn.click();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(win.document.getElementById('volume-value').textContent, '100%');
  });

  // --- UI fill percentage reflects reset ---

  test('volume surface --pct CSS var resets to 33.333% (100/300)', async () => {
    const slider = win.document.getElementById('volume-slider');
    slider.value = '200';
    slider.dispatchEvent(new win.Event('input'));
    await new Promise((r) => setTimeout(r, 50));

    const surface = win.document.getElementById('volume-surface');
    assert.match(surface.style.getPropertyValue('--pct'), /66\.6/);

    surface.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    assert.match(surface.style.getPropertyValue('--pct'), /33\.3/);
  });

  test('speed surface --pct CSS var resets to 27.273% ((1-0.25)/(3-0.25)*100)', async () => {
    const slider = win.document.getElementById('speed-slider');
    slider.value = '2';
    slider.dispatchEvent(new win.Event('input'));
    await new Promise((r) => setTimeout(r, 50));

    const surface = win.document.getElementById('speed-surface');
    assert.equal(
      surface.style.getPropertyValue('--pct').match(/27\.2/),
      null,
      'speed --pct should not be at reset position initially',
    );

    surface.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    assert.match(surface.style.getPropertyValue('--pct'), /27\.2/);
  });

  test('peaks surface --pct CSS var resets to 0%', async () => {
    const slider = win.document.getElementById('peaks-slider');
    slider.value = '50';
    slider.dispatchEvent(new win.Event('input'));
    await new Promise((r) => setTimeout(r, 50));

    const surface = win.document.getElementById('peaks-surface');
    assert.equal(surface.style.getPropertyValue('--pct'), '50%');

    surface.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(surface.style.getPropertyValue('--pct'), '0%');
  });
});
