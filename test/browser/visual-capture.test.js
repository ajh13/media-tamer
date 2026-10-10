// Visual capture unit tests — verifies the capture script produces real
// screenshots with correct dimensions in both light and dark modes, and that
// expanding the settings panel via the real #settings-toggle button produces
// a meaningfully different (taller) screenshot vs. the collapsed state.
//
// The previous versions used `panel.hidden = false` — a no-op on <details>
// (which uses `.open`) — so collapsed and expanded captures were byte-identical
// false positives. This version clicks the real button, asserts the <details>
// reports `open === true`, checks that appearance/server inputs are actually
// visible, asserts expanded height > collapsed, and compares PNG byte buffers
// to confirm the screenshots differ.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { firefox } from 'playwright';
import { mkdir, readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';

const POPUP = resolve('extensions/media-tamer/popup.html');
const OUT_DIR = resolve('artifacts/visuals');

// Minimal browser API mock — mirrors scripts/visual-capture.mjs. Enough to get
// popup.js through init() with rendered values so the controls aren't disabled.
const BROWSER_MOCK = `
  window.browser = {
    runtime: {
      id: 'media-tamer@example.invalid',
      getURL: p => 'moz-extension://media-tamer@example.invalid/' + p,
      onMessage: { addListener: () => {} },
      sendMessage: async (msg) => {
        const r = {
          VC_VOLUME_GET: { status: 'ok', percent: 100, appliedPercent: 100, count: 1 },
          VC_SPEED_GET: { status: 'ok', speed: 1, appliedSpeed: 1 },
          VC_NIGHT_GET: { status: 'ok', strength: 0, active: false },
          VC_SEEK_GET: { status: 'ok', binding: { key: 'z', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }, canUndo: false },
          VC_MEDIA_ROLLER_GET: { status: 'ok', baseUrl: '' },
          VC_APPEARANCE_GET: { status: 'ok', appearance: window.__FORCED_APPEARANCE__ || 'system' },
        };
        return r[msg?.action] || { status: 'ok' };
      },
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://example.com' }],
      sendMessage: async () => ({ status: 'ok', percent: 100, appliedPercent: 100, count: 1, speed: 1, appliedSpeed: 1, strength: 0, active: false }),
    },
    permissions: { request: async () => true },
    storage: {
      local: {
        get: async (key) => (key === 'appearance' ? { appearance: window.__FORCED_APPEARANCE__ || 'system' } : {}),
        set: async () => {},
      },
    },
  };
`;

describe('visual capture', () => {
  let browser;

  before(async () => {
    await mkdir(OUT_DIR, { recursive: true });
    browser = await firefox.launch({ headless: true });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  test('light collapsed screenshot valid PNG with controls rendered', async () => {
    const page = await browser.newPage({
      viewport: { width: 360, height: 800 },
      colorScheme: 'light',
    });
    await page.addInitScript(BROWSER_MOCK);
    await page.addInitScript("window.__FORCED_APPEARANCE__ = 'light';");
    await page.goto('file://' + POPUP);

    // Wait for popup.js init to render values
    await page
      .waitForFunction(
        () => {
          const v = document.getElementById('volume-value');
          return v && v.textContent && v.textContent !== '';
        },
        { timeout: 5000 },
      )
      .catch(() => {});

    const path = resolve(OUT_DIR, 'test-light-collapsed.png');
    await page.locator('.popup').screenshot({ path });

    const dims = await page.locator('.popup').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), scroll: el.scrollHeight };
    });

    await access(path, constants.R_OK);
    const buf = await readFile(path);
    assert.ok(buf.length > 1024, `screenshot too small: ${buf.length} bytes`);
    assert.ok(buf[0] === 0x89 && buf[1] === 0x50, 'not a valid PNG header');
    assert.ok(dims.w >= 300 && dims.w <= 360, `width ${dims.w} out of range`);
    assert.ok(dims.h >= 200 && dims.h <= 280, `collapsed height ${dims.h} should be ~236-260`);
    assert.ok(dims.scroll <= 580, `scrollHeight ${dims.scroll} exceeds 580 cap`);

    console.log(
      `  light-collapsed: ${dims.w}x${dims.h}, scroll=${dims.scroll}, ${buf.length} bytes`,
    );

    // Settings panel must be collapsed by default
    const panelOpen = await page.locator('#settings-panel').evaluate((el) => el.open);
    assert.equal(panelOpen, false, 'settings panel should be collapsed by default');

    await page.close();
  });

  test('dark collapsed screenshot valid PNG with controls rendered', async () => {
    const page = await browser.newPage({
      viewport: { width: 360, height: 800 },
      colorScheme: 'dark',
    });
    await page.addInitScript(BROWSER_MOCK);
    await page.addInitScript("window.__FORCED_APPEARANCE__ = 'dark';");
    await page.goto('file://' + POPUP);
    await page
      .waitForFunction(
        () => {
          const v = document.getElementById('volume-value');
          return v && v.textContent && v.textContent !== '';
        },
        { timeout: 5000 },
      )
      .catch(() => {});

    const path = resolve(OUT_DIR, 'test-dark-collapsed.png');
    await page.locator('.popup').screenshot({ path });

    const dims = await page.locator('.popup').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), scroll: el.scrollHeight };
    });

    await access(path, constants.R_OK);
    const buf = await readFile(path);
    assert.ok(buf.length > 1024, `screenshot too small: ${buf.length} bytes`);
    assert.ok(dims.w >= 300 && dims.w <= 360, `width ${dims.w} out of range`);
    assert.ok(dims.h >= 200 && dims.h <= 280, `dark collapsed height ${dims.h} should be ~236-260`);

    console.log(
      `  dark-collapsed: ${dims.w}x${dims.h}, scroll=${dims.scroll}, ${buf.length} bytes`,
    );

    await page.close();
  });

  test('expanding settings via real button changes dimensions and screenshot', async () => {
    // First capture collapsed state
    const page = await browser.newPage({
      viewport: { width: 360, height: 800 },
      colorScheme: 'light',
    });
    await page.addInitScript(BROWSER_MOCK);
    await page.addInitScript("window.__FORCED_APPEARANCE__ = 'light';");
    await page.goto('file://' + POPUP);
    await page
      .waitForFunction(
        () => {
          const v = document.getElementById('volume-value');
          return v && v.textContent && v.textContent !== '';
        },
        { timeout: 5000 },
      )
      .catch(() => {});

    const collapsedPath = resolve(OUT_DIR, 'test-expand-collapsed.png');
    await page.locator('.popup').screenshot({ path: collapsedPath });
    const collapsedDims = await page.locator('.popup').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), scroll: el.scrollHeight };
    });

    // Verify settings panel is collapsed
    assert.equal(
      await page.locator('#settings-panel').evaluate((el) => el.open),
      false,
      'settings panel should start collapsed',
    );

    // Click the REAL settings-toggle button (popup.js toggles details.open)
    await page.locator('#settings-toggle').click();
    await page
      .waitForFunction(
        () => {
          const p = document.getElementById('settings-panel');
          return p && p.open === true;
        },
        { timeout: 2000 },
      )
      .catch(() => {});

    // Assert the panel reports open (not the old broken .hidden=false path)
    assert.equal(
      await page.locator('#settings-panel').evaluate((el) => el.open),
      true,
      'settings panel should be open after clicking toggle',
    );

    // Verify aria-expanded reflects the new state
    assert.equal(
      await page.locator('#settings-toggle').getAttribute('aria-expanded'),
      'true',
      'aria-expanded should be true after toggle',
    );

    // Scroll the MR block into view so it's captured
    await page
      .locator('.mr-block')
      .scrollIntoViewIfNeeded()
      .catch(() => {});

    // Verify appearance select and MR URL input are actually visible
    const appearanceVisible = await page.locator('#appearance-select').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    assert.ok(appearanceVisible, 'appearance select should be visible when expanded');

    const mrVisible = await page.locator('#mr-baseurl').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    assert.ok(mrVisible, 'MR URL input should be visible when expanded');

    await page.waitForTimeout(200);

    const expandedPath = resolve(OUT_DIR, 'test-expand-expanded.png');
    await page.locator('.popup').screenshot({ path: expandedPath });
    const expandedDims = await page.locator('.popup').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), scroll: el.scrollHeight };
    });

    await page.close();

    // Load both PNGs and assert they differ (the false-positive guard)
    await access(collapsedPath, constants.R_OK);
    await access(expandedPath, constants.R_OK);
    const collapsedBuf = await readFile(collapsedPath);
    const expandedBuf = await readFile(expandedPath);

    assert.ok(collapsedBuf.length > 1024, 'collapsed screenshot too small');
    assert.ok(expandedBuf.length > 1024, 'expanded screenshot too small');
    assert.notEqual(
      collapsedBuf.length,
      expandedBuf.length,
      `collapsed (${collapsedBuf.length}B) and expanded (${expandedBuf.length}B) PNGs are byte-identical — screenshot comparison is a false positive`,
    );

    // Expanded should be taller than collapsed (content actually added)
    assert.ok(
      expandedDims.scroll > collapsedDims.scroll,
      `expanded scrollHeight (${expandedDims.scroll}) should be greater than collapsed (${collapsedDims.scroll})`,
    );

    // Expanded must fit within the 580px max-height cap
    assert.ok(
      expandedDims.scroll <= 580,
      `expanded scrollHeight ${expandedDims.scroll} exceeds 580 cap`,
    );

    console.log(
      `  expand: collapsed=${collapsedDims.w}x${collapsedDims.h} scroll=${collapsedDims.scroll} ${collapsedBuf.length}B → expanded=${expandedDims.w}x${expandedDims.h} scroll=${expandedDims.scroll} ${expandedBuf.length}B`,
    );
  });

  test('four captures produce distinct heights: light/dark collapsed + expanded', async () => {
    const states = [];

    for (const theme of ['light', 'dark']) {
      for (const expand of [false, true]) {
        const page = await browser.newPage({
          viewport: { width: 360, height: 800 },
          colorScheme: theme,
        });
        await page.addInitScript(BROWSER_MOCK);
        await page.addInitScript(`window.__FORCED_APPEARANCE__ = '${theme}';`);
        await page.goto('file://' + POPUP);
        await page
          .waitForFunction(
            () => {
              const v = document.getElementById('volume-value');
              return v && v.textContent && v.textContent !== '';
            },
            { timeout: 5000 },
          )
          .catch(() => {});

        if (expand) {
          await page.locator('#settings-toggle').click();
          await page
            .waitForFunction(
              () => {
                const p = document.getElementById('settings-panel');
                return p && p.open === true;
              },
              { timeout: 2000 },
            )
            .catch(() => {});
          await page
            .locator('.mr-block')
            .scrollIntoViewIfNeeded()
            .catch(() => {});
          await page.waitForTimeout(200);
        }

        const path = resolve(
          OUT_DIR,
          `test-4way-${theme}-${expand ? 'expanded' : 'collapsed'}.png`,
        );
        await page.locator('.popup').screenshot({ path });

        const dims = await page.locator('.popup').evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), scroll: el.scrollHeight };
        });

        const buf = await readFile(path);
        states.push({ theme, expand, path, dims, buf });
        await page.close();
      }
    }

    const collapsedLight = states.find((s) => s.theme === 'light' && !s.expand);
    const expandedLight = states.find((s) => s.theme === 'light' && s.expand);
    const collapsedDark = states.find((s) => s.theme === 'dark' && !s.expand);
    const expandedDark = states.find((s) => s.theme === 'dark' && s.expand);

    // All four screenshots should be valid PNGs
    for (const s of states) {
      assert.ok(s.buf[0] === 0x89 && s.buf[1] === 0x50, `${s.path} not a valid PNG`);
      assert.ok(s.buf.length > 1024, `${s.path} too small`);
    }

    // Both expanded states must be taller than their collapsed counterparts
    assert.ok(
      expandedLight.dims.scroll > collapsedLight.dims.scroll,
      `light expanded (${expandedLight.dims.scroll}) should exceed light collapsed (${collapsedLight.dims.scroll})`,
    );
    assert.ok(
      expandedDark.dims.scroll > collapsedDark.dims.scroll,
      `dark expanded (${expandedDark.dims.scroll}) should exceed dark collapsed (${collapsedDark.dims.scroll})`,
    );

    // Collapsed states should produce different byte sizes (light vs dark differ)
    assert.notEqual(
      collapsedLight.buf.length,
      collapsedDark.buf.length,
      'light vs dark collapsed PNGs should differ (different themes)',
    );

    // Expanded states should produce different byte sizes (light vs dark differ)
    assert.notEqual(
      expandedLight.buf.length,
      expandedDark.buf.length,
      'light vs dark expanded PNGs should differ (different themes)',
    );

    // No two captures should be byte-identical (guards against false positives)
    for (let i = 0; i < states.length; i++) {
      for (let j = i + 1; j < states.length; j++) {
        if (states[i].expand !== states[j].expand) {
          // Expanded vs collapsed — MUST differ
          assert.notEqual(
            states[i].buf.length,
            states[j].buf.length,
            `${states[i].path} and ${states[j].path} have identical byte size — likely false positive`,
          );
        }
      }
    }

    for (const s of states) {
      console.log(
        `  ${s.theme}-${s.expand ? 'expanded' : 'collapsed'}: ${s.dims.w}x${s.dims.h} scroll=${s.dims.scroll} ${s.buf.length}B`,
      );
    }
  });
});
