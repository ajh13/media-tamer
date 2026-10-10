import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { firefox } from 'playwright';

/**
 * Popup drag-to-adjust (relative) — TDD tests in real Firefox.
 *
 * Verifies: single click = no jump/no command; double-click = reset with no
 * intermediate commands; drag = relative delta from start value (not absolute
 * click position); keyboard arrows still work; drag is not mistaken for
 * double-click.
 *
 * Uses a browser API mock so popup.js init() completes and runtime.sendMessage
 * is captured via window.__popupMessages.
 */

const POPUP = resolve('extensions/media-tamer/popup.html');

const BROWSER_MOCK = `
  window.__popupMessages = [];
  window.__vol = 100;
  window.__spd = 1;
  window.__night = 0;
  window.browser = {
    runtime: {
      id: 'media-tamer@example.invalid',
      getURL: (p) => 'moz-extension://media-tamer@example.invalid/' + p,
      onMessage: { addListener: () => {} },
      sendMessage: async (msg) => {
        window.__popupMessages.push(msg);
        switch (msg.type) {
          case 'VC_VOLUME_GET':
            return { status: 'ok', percent: window.__vol, appliedPercent: window.__vol, count: 1 };
          case 'VC_VOLUME_SET':
            window.__vol = msg.percent;
            return { status: 'ok', percent: msg.percent, appliedPercent: msg.percent, count: 1 };
          case 'VC_SPEED_GET':
            return { status: 'ok', speed: window.__spd, appliedSpeed: window.__spd, count: 1 };
          case 'VC_SPEED_SET':
            window.__spd = msg.speed;
            return { status: 'ok', speed: msg.speed, appliedSpeed: msg.speed, count: 1 };
          case 'VC_NIGHT_GET':
            return { status: 'ok', strength: window.__night, active: window.__night > 0, count: 1 };
          case 'VC_NIGHT_SET':
            window.__night = msg.strength;
            return { status: 'ok', strength: msg.strength, active: msg.strength > 0, count: 1 };
          case 'VC_SEEK_GET':
            return { binding: { key: 'z', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }, canUndo: false };
          default:
            return null;
        }
      },
    },
    tabs: {
      query: async () => [{ id: 1 }],
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      sendMessage: async () => ({}),
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    permissions: { request: async () => true },
  };
`;

describe('popup drag-to-adjust (relative, no click jump)', () => {
  let browser;

  before(async () => {
    browser = await firefox.launch({ headless: true });
  });
  after(async () => {
    if (browser) await browser.close();
  });

  test('single click on left/right edges does NOT jump or send commands', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 300 } });
    await page.addInitScript(BROWSER_MOCK);
    await page.goto('file://' + POPUP);

    await page.waitForFunction(
      () => document.getElementById('volume-value')?.textContent === '100%',
      null,
      { timeout: 10000 },
    );
    await page.evaluate(() => {
      window.__popupMessages = [];
    });

    const box = await page.evaluate(() => {
      const r = document.getElementById('volume-surface').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });

    // Click left edge
    await page.mouse.click(box.x + 3, box.y + box.h / 2);
    const leftVal = await page.locator('#volume-value').textContent();
    assert.equal(leftVal, '100%', 'click on left edge must not jump volume');

    // Click right edge
    await page.mouse.click(box.x + box.w - 3, box.y + box.h / 2);
    const rightVal = await page.locator('#volume-value').textContent();
    assert.equal(rightVal, '100%', 'click on right edge must not jump volume');

    const msgs = await page.evaluate(() => window.__popupMessages);
    assert.equal(msgs.length, 0, 'single click must send no commands');

    await page.close();
  });

  test('double-click resets volume to default with NO intermediate commands', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 300 } });
    await page.addInitScript(BROWSER_MOCK);
    await page.goto('file://' + POPUP);

    await page.waitForFunction(
      () => document.getElementById('volume-value')?.textContent === '100%',
      null,
      { timeout: 10000 },
    );

    // Set volume to 200 via input event
    await page.evaluate(() => {
      const s = document.getElementById('volume-slider');
      s.value = '200';
      s.dispatchEvent(new Event('input'));
    });
    await page.waitForFunction(
      () => document.getElementById('volume-value')?.textContent === '200%',
      null,
      { timeout: 5000 },
    );
    await page.evaluate(() => {
      window.__popupMessages = [];
    });

    const box = await page.evaluate(() => {
      const r = document.getElementById('volume-surface').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });

    // Double-click on the LEFT edge (position must not cause intermediate set)
    await page.mouse.click(box.x + 5, box.y + box.h / 2);
    await page.mouse.click(box.x + 5, box.y + box.h / 2);

    await page.waitForFunction(
      () => document.getElementById('volume-value')?.textContent === '100%',
      null,
      { timeout: 5000 },
    );

    const val = await page.locator('#volume-value').textContent();
    assert.equal(val, '100%', 'double-click must reset to default');

    const msgs = await page.evaluate(() => window.__popupMessages);
    const volSets = msgs.filter((m) => m.type === 'VC_VOLUME_SET');
    assert.equal(volSets.length, 1, 'exactly one VC_VOLUME_SET sent on dblclick');
    assert.equal(volSets[0].percent, 100, 'the single command must be percent=100');

    await page.close();
  });

  test('double-click on RIGHT edge also resets, no intermediate commands', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 300 } });
    await page.addInitScript(BROWSER_MOCK);
    await page.goto('file://' + POPUP);

    await page.waitForFunction(
      () => document.getElementById('volume-value')?.textContent === '100%',
      null,
      { timeout: 10000 },
    );

    await page.evaluate(() => {
      const s = document.getElementById('volume-slider');
      s.value = '50';
      s.dispatchEvent(new Event('input'));
    });
    await page.waitForFunction(
      () => document.getElementById('volume-value')?.textContent === '50%',
      null,
      { timeout: 5000 },
    );
    await page.evaluate(() => {
      window.__popupMessages = [];
    });

    const box = await page.evaluate(() => {
      const r = document.getElementById('volume-surface').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });

    // Double-click on RIGHT edge
    await page.mouse.click(box.x + box.w - 5, box.y + box.h / 2);
    await page.mouse.click(box.x + box.w - 5, box.y + box.h / 2);

    await page.waitForFunction(
      () => document.getElementById('volume-value')?.textContent === '100%',
      null,
      { timeout: 5000 },
    );

    const msgs = await page.evaluate(() => window.__popupMessages);
    const volSets = msgs.filter((m) => m.type === 'VC_VOLUME_SET');
    assert.equal(volSets.length, 1, 'one command on right-edge dblclick');
    assert.equal(volSets[0].percent, 100, 'must reset to 100');

    await page.close();
  });

  test('drag RIGHT from center increases volume relative to start (not absolute)', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 300 } });
    await page.addInitScript(BROWSER_MOCK);
    await page.goto('file://' + POPUP);

    await page.waitForFunction(
      () => document.getElementById('volume-value')?.textContent === '100%',
      null,
      { timeout: 10000 },
    );

    // Start at volume=150 so we can verify relative (not absolute) mapping
    await page.evaluate(() => {
      window.__vol = 150;
      const s = document.getElementById('volume-slider');
      s.value = '150';
      document.getElementById('volume-value').textContent = '150%';
      document.getElementById('volume-surface').style.setProperty('--pct', `${(150 / 300) * 100}%`);
    });
    await page.evaluate(() => {
      window.__popupMessages = [];
    });

    const box = await page.evaluate(() => {
      const r = document.getElementById('volume-surface').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const startX = box.x + box.w / 2;
    const startY = box.y + box.h / 2;

    // Drag right 60px
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 15, startY, { steps: 2 });
    await page.mouse.move(startX + 30, startY, { steps: 2 });
    await page.mouse.move(startX + 60, startY, { steps: 2 });
    await page.mouse.up();

    const val = await page.locator('#volume-value').textContent();
    const pct = parseInt(val, 10);
    assert.ok(pct > 150, `drag right from 150 should increase, got ${pct}`);
    assert.ok(pct <= 300, `drag should clamp at 300, got ${pct}`);
    assert.ok(
      pct < 250,
      `drag of 60px on ~${Math.round(box.w)}px surface should not jump to max, got ${pct}`,
    );

    await page.close();
  });

  test('drag LEFT from center decreases volume relative to start', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 300 } });
    await page.addInitScript(BROWSER_MOCK);
    await page.goto('file://' + POPUP);

    await page.waitForFunction(
      () => document.getElementById('volume-value')?.textContent === '100%',
      null,
      { timeout: 10000 },
    );

    await page.evaluate(() => {
      window.__vol = 200;
      const s = document.getElementById('volume-slider');
      s.value = '200';
      document.getElementById('volume-value').textContent = '200%';
      document.getElementById('volume-surface').style.setProperty('--pct', `${(200 / 300) * 100}%`);
    });
    await page.evaluate(() => {
      window.__popupMessages = [];
    });

    const box = await page.evaluate(() => {
      const r = document.getElementById('volume-surface').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const startX = box.x + box.w / 2;
    const startY = box.y + box.h / 2;

    // Drag left 60px
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 20, startY, { steps: 2 });
    await page.mouse.move(startX - 40, startY, { steps: 2 });
    await page.mouse.move(startX - 60, startY, { steps: 2 });
    await page.mouse.up();

    const val = await page.locator('#volume-value').textContent();
    const pct = parseInt(val, 10);
    assert.ok(pct < 200, `drag left from 200 should decrease, got ${pct}`);
    assert.ok(pct >= 0, `drag should clamp at 0, got ${pct}`);

    await page.close();
  });

  test('drag is NOT mistaken for double-click reset', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 300 } });
    await page.addInitScript(BROWSER_MOCK);
    await page.goto('file://' + POPUP);

    await page.waitForFunction(
      () => document.getElementById('volume-value')?.textContent === '100%',
      null,
      { timeout: 10000 },
    );

    // Start at 120
    await page.evaluate(() => {
      window.__vol = 120;
      const s = document.getElementById('volume-slider');
      s.value = '120';
      document.getElementById('volume-value').textContent = '120%';
      document.getElementById('volume-surface').style.setProperty('--pct', `${(120 / 300) * 100}%`);
    });
    await page.evaluate(() => {
      window.__popupMessages = [];
    });

    const box = await page.evaluate(() => {
      const r = document.getElementById('volume-surface').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const startX = box.x + box.w / 2;
    const startY = box.y + box.h / 2;

    // Drag right — should increase, NOT reset to 100
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 40, startY, { steps: 3 });
    await page.mouse.up();

    const val = await page.locator('#volume-value').textContent();
    const pct = parseInt(val, 10);
    assert.ok(pct > 120, `drag should increase from 120, not reset — got ${pct}`);
    assert.notEqual(pct, 100, 'drag must not be mistaken for dblclick reset');

    await page.close();
  });

  test('keyboard arrow keys still change value after drag fix', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 300 } });
    await page.addInitScript(BROWSER_MOCK);
    await page.goto('file://' + POPUP);

    await page.waitForFunction(
      () => document.getElementById('volume-value')?.textContent === '100%',
      null,
      { timeout: 10000 },
    );

    // Focus the range slider directly (independent of pointerdown focus behavior)
    await page.evaluate(() => {
      document.getElementById('volume-slider').focus();
    });

    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(
      () => document.getElementById('volume-value')?.textContent === '101%',
      null,
      { timeout: 5000 },
    );
    const val1 = await page.locator('#volume-value').textContent();
    assert.equal(val1, '101%', 'ArrowRight should increment by step');

    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(
      () => document.getElementById('volume-value')?.textContent === '100%',
      null,
      { timeout: 5000 },
    );
    const val2 = await page.locator('#volume-value').textContent();
    assert.equal(val2, '100%', 'ArrowLeft should decrement by step');

    await page.close();
  });

  test('peaks (night) drag works the same way', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 300 } });
    await page.addInitScript(BROWSER_MOCK);
    await page.goto('file://' + POPUP);

    await page.waitForFunction(
      () => document.getElementById('peaks-value')?.textContent === 'Off',
      null,
      { timeout: 10000 },
    );

    await page.evaluate(() => {
      window.__night = 30;
      const s = document.getElementById('peaks-slider');
      s.value = '30';
      document.getElementById('peaks-value').textContent = '30%';
      document.getElementById('peaks-surface').style.setProperty('--pct', '30%');
    });
    await page.evaluate(() => {
      window.__popupMessages = [];
    });

    const box = await page.evaluate(() => {
      const r = document.getElementById('peaks-surface').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const startX = box.x + box.w / 2;
    const startY = box.y + box.h / 2;

    // Drag right
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 40, startY, { steps: 3 });
    await page.mouse.up();

    const val = await page.locator('#peaks-value').textContent();
    const pct = parseInt(val, 10);
    assert.ok(pct > 30, `peaks drag right should increase from 30, got ${pct}`);

    // Double-click peaks resets to Off
    await page.evaluate(() => {
      window.__popupMessages = [];
    });
    await page.mouse.click(box.x + 5, box.y + box.h / 2);
    await page.mouse.click(box.x + 5, box.y + box.h / 2);

    await page.waitForFunction(
      () => document.getElementById('peaks-value')?.textContent === 'Off',
      null,
      { timeout: 5000 },
    );

    const msgs = await page.evaluate(() => window.__popupMessages);
    const nightSets = msgs.filter((m) => m.type === 'VC_NIGHT_SET');
    assert.equal(nightSets.length, 1, 'peaks dblclick sends one command');
    assert.equal(nightSets[0].strength, 0, 'peaks reset to 0');

    await page.close();
  });

  test('speed drag and double-click reset work too', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 300 } });
    await page.addInitScript(BROWSER_MOCK);
    await page.goto('file://' + POPUP);

    await page.waitForFunction(
      () => document.getElementById('speed-value')?.textContent === '1.00x',
      null,
      { timeout: 10000 },
    );

    // Capture geometry BEFORE setting initial value so we know real surface width
    const box = await page.evaluate(() => {
      const r = document.getElementById('speed-surface').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });

    // Start at 1.50x
    await page.evaluate(() => {
      window.__spd = 1.5;
      const s = document.getElementById('speed-slider');
      s.value = '1.5';
      document.getElementById('speed-value').textContent = '1.50x';
      document
        .getElementById('speed-surface')
        .style.setProperty('--pct', `${((1.5 - 0.25) / (3 - 0.25)) * 100}%`);
    });
    await page.evaluate(() => {
      window.__popupMessages = [];
    });

    const startX = box.x + box.w / 2;
    const startY = box.y + box.h / 2;
    const dragDx = 50;

    // Drag right increases speed — compute expected from actual geometry
    const expectedSpeed = await page.evaluate(
      ({ dragDx, startValue, min, max, width }) => {
        const range = max - min;
        const raw = startValue + (dragDx / width) * range;
        const step = 0.05;
        const stepped = Math.round(raw / step) * step;
        // Clamp
        return Math.max(min, Math.min(max, stepped));
      },
      { dragDx, startValue: 1.5, min: 0.25, max: 3, width: box.w },
    );

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + dragDx, startY, { steps: 3 });
    await page.mouse.up();

    const val = await page.locator('#speed-value').textContent();
    const actualSpeed = parseFloat(val);
    assert.ok(actualSpeed > 1.5, `speed should increase from 1.50x, got ${val}`);
    // Allow some tolerance for intermediate pointermove events, but must be >= expected
    assert.ok(
      actualSpeed >= expectedSpeed - 0.1,
      `speed ${actualSpeed} should be >= expected ~${expectedSpeed.toFixed(2)} (within tolerance)`,
    );
    assert.ok(actualSpeed <= 3, `speed should clamp at 3, got ${val}`);

    // Double-click resets speed to 1.00x
    await page.evaluate(() => {
      window.__popupMessages = [];
    });
    await page.mouse.click(box.x + box.w - 5, box.y + box.h / 2);
    await page.mouse.click(box.x + box.w - 5, box.y + box.h / 2);

    await page.waitForFunction(
      () => document.getElementById('speed-value')?.textContent === '1.00x',
      null,
      { timeout: 5000 },
    );

    const msgs = await page.evaluate(() => window.__popupMessages);
    const spdSets = msgs.filter((m) => m.type === 'VC_SPEED_SET');
    assert.equal(spdSets.length, 1, 'speed dblclick sends one command');
    assert.equal(spdSets[0].speed, 1, 'speed reset to 1');

    await page.close();
  });
});
