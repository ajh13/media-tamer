import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { firefox } from 'playwright';

/**
 * Popup layout tests — rendered in real Firefox with the actual popup.html
 * (Playwright-driven content load, mocked browser API via script injection for
 * interactive state). Verifies compact minimal UI dimensions:
 *   - default collapsed: ~236-260px (was 320-316 / mockup 320x236)
 *   - expanded (settings + mr-settings open): <= 580px, no horizontal overflow
 *   - width ~340px, no vh-based height constraints
 *   - error text wraps (not ellipsis)
 */

const POPUP = resolve('extensions/media-tamer/popup.html');

// Minimal browser.runtime mock so popup.js init() completes and renders values
const BROWSER_MOCK = `
  window.browser = {
    runtime: { id: 'media-tamer@example.invalid',
      getURL: p => 'moz-extension://media-tamer@example.invalid/' + p,
      onMessage: { addListener: () => {} },
      sendMessage: async () => ({ status: 'ok', percent: 100, appliedPercent: 100, count: 1,
        speed: 1, appliedSpeed: 1, strength: 0, active: false,
        binding: { key:'z',ctrlKey:true,altKey:false,shiftKey:false,metaKey:false },
        canUndo:false }) },
    tabs: { query: async () => [{ id: 1 }],
      sendMessage: async () => ({ status:'ok',percent:100,appliedPercent:100,count:1,
        speed:1,appliedSpeed:1,strength:0,active:false,
        binding:{key:'z',ctrlKey:true,altKey:false,shiftKey:false,metaKey:false},canUndo:false }) },
    permissions: { request: async () => true },
  };
`;

describe('popup compact layout', () => {
  let browser;

  before(async () => {
    browser = await firefox.launch({ headless: true });
  });
  after(async () => {
    if (browser) await browser.close();
  });

  test('default collapsed height ~236-260px, width 320-360px', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 30 } });
    await page.addScriptTag({ content: BROWSER_MOCK });
    await page.goto('file://' + POPUP);
    const box = await page.locator('.popup').evaluate((n) => {
      const r = n.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), scroll: n.scrollHeight };
    });
    console.log('Default popup box:', JSON.stringify(box));
    assert.ok(box.h >= 220 && box.h <= 270, `default height ${box.h} out of 220-270 range`);
    assert.ok(box.w >= 320 && box.w <= 360, `width ${box.w} out of 320-360 range`);
    assert.ok(box.scroll <= 580, `scrollHeight ${box.scroll} would exceed 580 cap`);
    await page.screenshot({ path: 'artifacts/popup-default-light.png' });
    await page.close();
  });

  test('expanded state fits <=580px, no horizontal overflow', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
    await page.addScriptTag({ content: BROWSER_MOCK });
    await page.goto('file://' + POPUP);
    await page.evaluate(() => {
      const panel = document.getElementById('settings-panel');
      if (panel) panel.open = true;
    });
    const box = await page.locator('.popup').evaluate((n) => {
      const r = n.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), scroll: n.scrollHeight };
    });
    console.log('Expanded popup box:', JSON.stringify(box));
    assert.ok(box.scroll <= 580, `expanded scrollHeight ${box.scroll} exceeds 580`);
    assert.ok(box.w <= 360, `expanded width ${box.w} causes horizontal overflow`);
    await page.screenshot({ path: 'artifacts/popup-expanded-light.png' });
    await page.close();
  });

  test('dark mode renders compact', async () => {
    const page = await browser.newPage({
      viewport: { width: 360, height: 30 },
      colorScheme: 'dark',
    });
    await page.addScriptTag({ content: BROWSER_MOCK });
    await page.goto('file://' + POPUP);
    const h = await page
      .locator('.popup')
      .evaluate((n) => Math.round(n.getBoundingClientRect().height));
    console.log('Dark mode height:', h);
    assert.ok(h >= 220 && h <= 270, `dark height ${h} out of range`);
    await page.screenshot({ path: 'artifacts/popup-default-dark.png' });
    await page.close();
  });

  test('long error text wraps (not ellipsis)', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 30 } });
    await page.addScriptTag({ content: BROWSER_MOCK });
    await page.goto('file://' + POPUP);
    const wraps = await page.locator('#volume-status').evaluate((el) => {
      el.textContent =
        'Could not establish connection. Receiving end does not exist. Frame unreachable after navigation event.';
      el.dataset.status = 'error';
      document.getElementById('status-area').hidden = false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        h: Math.round(r.height),
        w: Math.round(r.width),
        overflow: cs.overflow,
        textOverflow: cs.textOverflow,
        whiteSpace: cs.whiteSpace,
      };
    });
    console.log('Error text box:', JSON.stringify(wraps));
    assert.ok(errorWraps(wraps), 'error text should wrap, not clip');
    await page.screenshot({ path: 'artifacts/popup-long-error.png' });
    await page.close();
  });

  test('settings disclosure is collapsed by default and contains seek + mr', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 30 } });
    await page.addScriptTag({ content: BROWSER_MOCK });
    await page.goto('file://' + POPUP);
    const result = await page.evaluate(() => {
      const panel = document.getElementById('settings-panel');
      return {
        open: panel ? panel.open : null,
        hasSeek: !!panel?.querySelector('#seek-binding'),
        hasMr: !!panel?.querySelector('#mr-baseurl'),
      };
    });
    console.log('Settings disclosure:', JSON.stringify(result));
    assert.equal(result.open, false, 'settings panel should be collapsed');
    assert.equal(result.hasSeek, true, 'seek shortcut should be inside settings');
    assert.equal(result.hasMr, true, 'media roller should be inside settings');
    await page.close();
  });

  test('idle status area is hidden by default', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 30 } });
    await page.addScriptTag({ content: BROWSER_MOCK });
    await page.goto('file://' + POPUP);
    const hidden = await page.locator('#status-area').evaluate((el) => el.hidden);
    console.log('Status area hidden:', hidden);
    assert.equal(hidden, true, 'idle status area should be hidden');
    await page.close();
  });
});

function errorWraps(box) {
  // If the text wraps, the element height will be > single line (~16px for 11px font)
  return box.h > 20;
}
