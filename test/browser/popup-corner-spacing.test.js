import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { firefox } from 'playwright';

/**
 * Popup corner-spacing tests — rendered in real Firefox with the actual popup.html.
 * Verifies the Firefox rounded-panel popup has >= 8px clearance between the
 * popup's outer edges and the top-row controls (which also have rounded corners),
 * so neither the controls nor their focused outlines get clipped by the panel's
 * rounded corners. Mirrors the BROWSER_MOCK pattern from popup-layout.test.js.
 */

const POPUP = resolve('extensions/media-tamer/popup.html');

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

describe('popup corner spacing (Firefox rounded-panel clearance)', () => {
  let browser;
  before(async () => {
    browser = await firefox.launch({ headless: true });
  });
  after(async () => {
    if (browser) await browser.close();
  });

  async function measureDefault({ colorScheme = 'light' } = {}) {
    const page = await browser.newPage({
      viewport: { width: 360, height: 800 },
      colorScheme,
    });
    await page.addScriptTag({ content: BROWSER_MOCK });
    await page.goto('file://' + POPUP);

    const geo = await page.evaluate(() => {
      const popup = document.querySelector('.popup');
      const pr = popup.getBoundingClientRect();
      const row = popup.querySelector('.row');
      if (!row) return null;
      const rowRect = row.getBoundingClientRect();
      const minusBtn = row.querySelector('.minus');
      const plusBtn = row.querySelector('.plus');
      const minusR = minusBtn.getBoundingClientRect();
      const plusR = plusBtn.getBoundingClientRect();

      // Surface (draggable field) horizontal inset from popup edges
      const surface = row.querySelector('.surface');
      const sr = surface.getBoundingClientRect();

      return {
        topClearance: Math.round(rowRect.top - pr.top),
        leftClearance: Math.round(minusR.left - pr.left),
        rightClearance: Math.round(pr.right - plusR.right),
        surfaceLeftInset: Math.round(sr.left - pr.left),
        surfaceRightInset: Math.round(pr.right - sr.right),
        popupW: Math.round(pr.width),
        popupH: Math.round(pr.height),
      };
    });

    await page.close();
    return geo;
  }

  test('light theme: >=8px top/left/right clearance, height <= 260', async () => {
    const g = await measureDefault({ colorScheme: 'light' });
    console.log('Light corner spacing:', JSON.stringify(g));
    assert.ok(g, 'geometry measured');
    assert.ok(g.topClearance >= 8, `top clearance ${g.topClearance}px < 8`);
    assert.ok(g.leftClearance >= 8, `left clearance ${g.leftClearance}px < 8`);
    assert.ok(g.rightClearance >= 8, `right clearance ${g.rightClearance}px < 8`);
    assert.ok(g.surfaceLeftInset >= 8, `surface left inset ${g.surfaceLeftInset}px < 8`);
    assert.ok(g.surfaceRightInset >= 8, `surface right inset ${g.surfaceRightInset}px < 8`);
    assert.ok(g.popupW <= 360, `width ${g.popupW} causes horizontal overflow`);
    assert.ok(g.popupH <= 260, `height ${g.popupH} > 260 target`);
  });

  test('dark theme: >=8px top/left/right clearance, height <= 260', async () => {
    const g = await measureDefault({ colorScheme: 'dark' });
    console.log('Dark corner spacing:', JSON.stringify(g));
    assert.ok(g, 'geometry measured');
    assert.ok(g.topClearance >= 8, `top clearance ${g.topClearance}px < 8`);
    assert.ok(g.leftClearance >= 8, `left clearance ${g.leftClearance}px < 8`);
    assert.ok(g.rightClearance >= 8, `right clearance ${g.rightClearance}px < 8`);
    assert.ok(g.surfaceLeftInset >= 8, `surface left inset ${g.surfaceLeftInset}px < 8`);
    assert.ok(g.surfaceRightInset >= 8, `surface right inset ${g.surfaceRightInset}px < 8`);
    assert.ok(g.popupW <= 360, `width ${g.popupW} causes horizontal overflow`);
    assert.ok(g.popupH <= 260, `height ${g.popupH} > 260 target`);
  });

  test('focused button outline not clipped by popup edges', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 30 } });
    await page.addScriptTag({ content: BROWSER_MOCK });
    await page.goto('file://' + POPUP);

    const clip = await page.evaluate(() => {
      const popup = document.querySelector('.popup');
      const pr = popup.getBoundingClientRect();
      const minusBtn = popup.querySelector('.row .minus');
      minusBtn.focus();
      const r = minusBtn.getBoundingClientRect();
      const cs = getComputedStyle(minusBtn);
      const ow = parseFloat(cs.outlineWidth) || 0;
      const oo = parseFloat(cs.outlineOffset) || 0;
      // Outline extends outward from the border box by outlineWidth; positive
      // offset pushes it further out, negative pulls it in.
      const ext = ow + Math.max(0, oo);
      return {
        outlineLeftClearance: Math.round(r.left - ext - pr.left),
        outlineRightClearance: Math.round(pr.right - (r.right + ext)),
        outlineTopClearance: Math.round(r.top - ext - pr.top),
        outlineWidth: ow,
        outlineOffset: oo,
      };
    });
    console.log('Focus outline clip check:', JSON.stringify(clip));
    assert.ok(
      clip.outlineLeftClearance >= 0,
      `focus outline clipped on left by ${clip.outlineLeftClearance}px`,
    );
    assert.ok(
      clip.outlineRightClearance >= 0,
      `focus outline clipped on right by ${clip.outlineRightClearance}px`,
    );
    assert.ok(
      clip.outlineTopClearance >= 0,
      `focus outline clipped on top by ${clip.outlineTopClearance}px`,
    );
    await page.screenshot({ path: 'artifacts/popup-corner-focus-check.png' });
    await page.close();
  });

  test('expanded settings state fits <=580px, width unchanged', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
    await page.addScriptTag({ content: BROWSER_MOCK });
    await page.goto('file://' + POPUP);
    await page.evaluate(() => {
      const panel = document.getElementById('settings-panel');
      if (panel) panel.open = true;
    });
    const box = await page.locator('.popup').evaluate((n) => {
      const r = n.getBoundingClientRect();
      return {
        scroll: n.scrollHeight,
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });
    console.log('Expanded corner-spacing popup box:', JSON.stringify(box));
    assert.ok(box.scroll <= 580, `expanded scrollHeight ${box.scroll} > 580`);
    assert.ok(box.w <= 360, `expanded width ${box.w} overflows`);
    await page.screenshot({ path: 'artifacts/popup-corner-expanded-check.png' });
    await page.close();
  });
});
