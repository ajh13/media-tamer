import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { firefox } from 'playwright';

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

describe('popup status cleanup + settings dedup', () => {
  let browser;

  before(async () => {
    browser = await firefox.launch({ headless: true });
  });
  after(async () => {
    if (browser) await browser.close();
  });

  test('benign ok-status text is hidden via CSS while element remains in DOM', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 30 } });
    await page.addInitScript(BROWSER_MOCK);
    await page.goto('file://' + POPUP);

    await page.waitForFunction(
      () => {
        const v = document.getElementById('volume-status');
        return v && v.dataset.status === 'ok';
      },
      null,
      { timeout: 15000 },
    );

    const okHidden = await page.evaluate(() => {
      const okEls = document.querySelectorAll('.status[data-status="ok"]');
      if (okEls.length === 0) return { ok: false, reason: 'no ok elements found' };
      for (const el of okEls) {
        if (getComputedStyle(el).display !== 'none') {
          return { ok: false, visibleId: el.id };
        }
      }
      return { ok: true, count: okEls.length };
    });
    assert.ok(okHidden.ok, `ok statuses should be hidden: ${JSON.stringify(okHidden)}`);
    assert.equal(
      await page.locator('#status-area').evaluate((el) => el.hidden),
      true,
      'normal statuses must not leave an empty status strip',
    );
    assert.equal(
      await page.locator('#status-area').evaluate((el) => getComputedStyle(el).display),
      'none',
    );

    await page.close();
  });

  test('real error messages remain visible in status area', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 30 } });
    await page.addInitScript(BROWSER_MOCK);
    await page.goto('file://' + POPUP);

    await page.evaluate(() => {
      const el = document.getElementById('volume-status');
      el.textContent = 'Could not establish connection. Receiving end does not exist.';
      el.dataset.status = 'error';
      document.getElementById('status-area').hidden = false;
    });

    const visible = await page.locator('#volume-status').evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && el.offsetParent !== null;
    });
    assert.ok(visible, 'error status should be visible');

    const areaHidden = await page.locator('#status-area').evaluate((el) => el.hidden);
    assert.equal(areaHidden, false, 'status area visible when error present');

    await page.close();
  });

  test('needsInteraction / pending messages remain visible', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 30 } });
    await page.addInitScript(BROWSER_MOCK);
    await page.goto('file://' + POPUP);

    await page.evaluate(() => {
      const el = document.getElementById('peaks-status');
      el.textContent = 'Click the video to activate 75%';
      el.dataset.status = '';
      document.getElementById('status-area').hidden = false;
    });

    const visible = await page.locator('#peaks-status').evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && el.offsetParent !== null;
    });
    assert.ok(visible, 'needsInteraction status should be visible');

    const areaHidden = await page.locator('#status-area').evaluate((el) => el.hidden);
    assert.equal(areaHidden, false, 'status area visible when pending message exists');

    await page.close();
  });

  test('settings summary is hidden, button is sole focusable toggle and keyboard-operable', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 30 } });
    await page.addInitScript(BROWSER_MOCK);
    await page.goto('file://' + POPUP);

    const summaryHidden = await page.locator('.settings-summary').evaluate((el) => {
      return getComputedStyle(el).display === 'none';
    });
    assert.ok(summaryHidden, 'settings <summary> should be hidden');

    const btnVisible = await page.locator('#settings-toggle').evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && el.offsetParent !== null;
    });
    assert.ok(btnVisible, 'settings button should be visible');

    const ariaExpanded = await page.locator('#settings-toggle').getAttribute('aria-expanded');
    assert.equal(ariaExpanded, 'false', 'button starts collapsed');

    const panelOpen = await page.locator('#settings-panel').evaluate((el) => el.open);
    assert.equal(panelOpen, false, 'panel starts collapsed');

    await page.locator('#settings-toggle').click();
    await page.waitForFunction(() => {
      const p = document.getElementById('settings-panel');
      return p && p.open === true;
    });
    assert.equal(
      await page.locator('#settings-toggle').getAttribute('aria-expanded'),
      'true',
      'aria-expanded true after click',
    );

    await page.locator('#settings-toggle').focus();
    const isFocused = await page.evaluate(
      () => document.activeElement && document.activeElement.id === 'settings-toggle',
    );
    assert.equal(isFocused, true, 'button should be keyboard focusable');

    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const p = document.getElementById('settings-panel');
      return p && p.open === false;
    });
    assert.equal(
      await page.locator('#settings-toggle').getAttribute('aria-expanded'),
      'false',
      'aria-expanded false after Enter toggle',
    );

    await page.close();
  });

  test('ok statuses hidden while genuine error visible alongside them', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 30 } });
    await page.addInitScript(BROWSER_MOCK);
    await page.goto('file://' + POPUP);

    await page.waitForFunction(
      () => {
        const v = document.getElementById('volume-status');
        return v && v.dataset.status === 'ok';
      },
      null,
      { timeout: 15000 },
    );

    await page.evaluate(() => {
      const el = document.getElementById('peaks-status');
      el.textContent = 'Script injection blocked by CSP';
      el.dataset.status = 'error';
      document.getElementById('status-area').hidden = false;
    });

    const volOkHidden = await page
      .locator('#volume-status')
      .evaluate((el) => getComputedStyle(el).display === 'none');
    assert.ok(volOkHidden, 'ok volume status should remain hidden');

    const peaksVisible = await page.locator('#peaks-status').evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && el.offsetParent !== null;
    });
    assert.ok(peaksVisible, 'error peaks status should be visible');

    const areaHidden = await page.locator('#status-area').evaluate((el) => el.hidden);
    assert.equal(areaHidden, false, 'area visible when any real error present');

    await page.close();
  });
});
