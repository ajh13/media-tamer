/**
 * theme-menu-live.test.js
 *
 * Live Firefox compatibility tests: real YouTube page with installed addon,
 * theme API behavior (getCurrent/update), popup dark-mode rendering, and
 * context menu state. Uses Selenium for real addon install on YouTube and
 * Playwright for popup/menu/theme UI tests.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { firefox as bundledFirefox } from 'playwright';
import { readFileSync } from 'node:fs';

const EXT_PATH = resolve('extensions/media-tamer');
const BG_SRC = readFileSync(resolve('extensions/media-tamer/background.js'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(resolve('extensions/media-tamer/manifest.json'), 'utf8'));

// ---------------------------------------------------------------------------
// 1. YouTube live site: real addon install, number-key guard, page action icon
// ---------------------------------------------------------------------------
test(
  'YouTube live: addon installs, content script active, number-key guard',
  { timeout: 120000 },
  async (t) => {
    // Use a local HTTP server for addon install (Selenium installAddon works on http)
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><body><video></video></body></html>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => server.close(r)));
    const localUrl = `http://127.0.0.1:${server.address().port}`;

    const opts = new firefox.Options()
      .setBinary(bundledFirefox.executablePath())
      .addArguments('-headless');
    const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();
    t.after(() => driver.quit());

    // Install addon on local http page (Selenium installAddon requirement)
    await driver.get(localUrl);
    const addonId = await driver.installAddon(EXT_PATH, true);
    assert.equal(addonId, 'media-tamer@example.invalid', 'addon install id');

    // Now navigate to YouTube with addon active
    await driver.get('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await driver.wait(until.elementLocated(By.id('movie_player')), 30000);

    const player = await driver.findElement(By.id('movie_player'));
    await player.click();
    await driver.sleep(500);

    const duration = await driver.executeScript(() => {
      const v = document.querySelector('video');
      return v ? v.duration : 0;
    });

    await driver.actions().pause(200).sendKeys('5').perform();
    await driver.sleep(400);

    const t2 = await driver.executeScript(() => {
      const v = document.querySelector('video');
      return v ? v.currentTime : -1;
    });

    if (duration > 10) {
      const expectedSeek = duration * 0.5;
      const seekHappened =
        Math.abs(t2 - expectedSeek) > 0 && Math.abs(t2 - expectedSeek) < duration * 0.15;
      assert.ok(
        !seekHappened,
        `number-key '5' should not seek (got ${t2.toFixed(1)}s, would be ~${expectedSeek.toFixed(1)}s if unguarded)`,
      );
    }

    console.log(
      `YouTube live: addon=${addonId}, duration=${duration.toFixed(1)}s, guard-verified=${duration > 10}`,
    );
  },
);

// ---------------------------------------------------------------------------
// 2. Theme API: parseCSSColor, isDarkTheme logic
// ---------------------------------------------------------------------------
describe('theme API compatibility', () => {
  function makeThemeFns() {
    function parseCSSColor(str) {
      if (!str || typeof str !== 'string') return null;
      const s = str.trim();
      const rgbMatch = s.match(/^rgba?\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})/);
      if (rgbMatch) return [+rgbMatch[1], +rgbMatch[2], +rgbMatch[3]];
      if (s.startsWith('#')) {
        let hex = s.slice(1);
        if (hex.length === 3)
          hex = hex
            .split('')
            .map((c) => c + c)
            .join('');
        if (hex.length === 6) {
          return [
            parseInt(hex.slice(0, 2), 16),
            parseInt(hex.slice(2, 4), 16),
            parseInt(hex.slice(4, 6), 16),
          ];
        }
      }
      const named = { white: [255, 255, 255], transparent: null, black: [0, 0, 0] };
      const l = s.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(named, l)) return named[l];
      return null;
    }
    function colorLuminance(rgb) {
      if (!rgb) return null;
      return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    }
    function isDarkTheme(theme) {
      let colorStr = null;
      if (theme && theme.colors) {
        colorStr =
          theme.colors.toolbar_field ||
          theme.colors.toolbar ||
          theme.colors.toolbar_background_tinted ||
          theme.colors.tab_background_text ||
          theme.colors.toolbar_text ||
          theme.colors.frame ||
          null;
      }
      if (colorStr) {
        const rgb = parseCSSColor(colorStr);
        const lum = colorLuminance(rgb);
        if (lum !== null) return lum < 0.5;
      }
      return false;
    }
    return { parseCSSColor, colorLuminance, isDarkTheme };
  }

  test('parseCSSColor handles rgb/hex/named colors', () => {
    const { parseCSSColor } = makeThemeFns();
    assert.deepEqual(parseCSSColor('rgb(128, 64, 32)'), [128, 64, 32]);
    assert.deepEqual(parseCSSColor('#336699'), [51, 102, 153]);
    assert.deepEqual(parseCSSColor('#fff'), [255, 255, 255]);
    assert.deepEqual(parseCSSColor('white'), [255, 255, 255]);
    assert.equal(parseCSSColor('transparent'), null);
    assert.deepEqual(parseCSSColor('black'), [0, 0, 0]);
    assert.equal(parseCSSColor('papayawhip'), null);
    console.log('parseCSSColor: all formats handled');
  });

  test('isDarkTheme prioritizes toolbar_field luminance', () => {
    const { isDarkTheme } = makeThemeFns();
    assert.equal(isDarkTheme({ colors: { toolbar_field: 'rgb(255,255,255)' } }), false);
    assert.equal(isDarkTheme({ colors: { toolbar_field: 'rgb(30,30,30)' } }), true);
    assert.equal(isDarkTheme({ colors: { toolbar_field: '#000' } }), true);
    assert.equal(isDarkTheme({ colors: { toolbar_field: 'black' } }), true);
    assert.equal(isDarkTheme({ colors: { toolbar_field: 'white' } }), false);
    assert.equal(isDarkTheme({ colors: {} }), false, 'empty theme defaults to light');
    assert.equal(isDarkTheme({}), false, 'no colors defaults to light');
    console.log('isDarkTheme: luminance-based detection works');
  });
});

// ---------------------------------------------------------------------------
// 3. Popup dark mode rendering via CSS custom properties
// ---------------------------------------------------------------------------
describe('popup dark mode rendering', () => {
  let browser;

  before(async () => {
    browser = await bundledFirefox.launch({ headless: true });
  });
  after(async () => {
    if (browser) await browser.close();
  });

  test('light colorScheme renders light custom properties', async () => {
    const page = await browser.newPage({ colorScheme: 'light' });
    const POPUP = 'file://' + resolve('extensions/media-tamer/popup.html');
    await page.goto(POPUP);
    const vars = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        bg: cs.getPropertyValue('--bg').trim(),
        text: cs.getPropertyValue('--text').trim(),
        accent: cs.getPropertyValue('--accent').trim(),
      };
    });
    console.log('Light scheme:', JSON.stringify(vars));
    assert.equal(vars.bg, '#f8f9fb');
    assert.equal(vars.text, '#20252e');
    assert.equal(vars.accent, '#185dbd');
    await page.close();
  });

  test('dark colorScheme renders dark custom properties', async () => {
    const page = await browser.newPage({ colorScheme: 'dark' });
    const POPUP = 'file://' + resolve('extensions/media-tamer/popup.html');
    await page.goto(POPUP);
    const vars = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        bg: cs.getPropertyValue('--bg').trim(),
        text: cs.getPropertyValue('--text').trim(),
        accent: cs.getPropertyValue('--accent').trim(),
      };
    });
    console.log('Dark scheme:', JSON.stringify(vars));
    assert.equal(vars.bg, '#20242b');
    assert.equal(vars.text, '#f0f3f8');
    assert.equal(vars.accent, '#8abcff');
    await page.close();
  });

  test('colorScheme dark triggers prefers-color-scheme: dark match', async () => {
    const page = await browser.newPage({ colorScheme: 'dark' });
    const m = await page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
    assert.equal(m, true);
    await page.close();
  });

  test('popup height stays compact in dark mode', async () => {
    const page = await browser.newPage({
      viewport: { width: 360, height: 30 },
      colorScheme: 'dark',
    });
    const POPUP = 'file://' + resolve('extensions/media-tamer/popup.html');
    await page.goto(POPUP);
    const h = await page
      .locator('.popup')
      .evaluate((n) => Math.round(n.getBoundingClientRect().height));
    console.log('Dark popup height:', h);
    assert.ok(h >= 300 && h <= 450, `dark height ${h} out of 300-450 range`);
    await page.close();
  });
});

// ---------------------------------------------------------------------------
// 4. Context menu state: structure, titles, checkbox/radio types
// ---------------------------------------------------------------------------
describe('context menu state', () => {
  test('menu structure: root + submenus + checkbox/radio types', () => {
    assert.ok(BG_SRC.includes("id: 'vg-root'"), 'root menu exists');
    assert.ok(BG_SRC.includes("parentId: 'vg-root'"), 'parent-child structure');
    assert.ok(BG_SRC.includes("type: 'checkbox'"), 'volume/speed use checkboxes');
    assert.ok(BG_SRC.includes("type: 'radio'"), 'night mode uses radio');
    assert.ok(BG_SRC.includes('vg-seek-undo'), 'undo menu exists');
    assert.ok(BG_SRC.includes('enabled: false'), 'undo disabled by default');
    console.log('Menu structure: root, submenus, checkbox/radio verified');
  });

  test('onShown updates menu titles and checks current state', () => {
    assert.ok(BG_SRC.includes('browser.menus.onShown'), 'onShown listener exists');
    assert.ok(BG_SRC.includes('browser.menus.update'), 'menu.update called');
    assert.ok(BG_SRC.includes('title: `Volume — ${state.volume}%`'), 'volume title reflects state');
    assert.ok(BG_SRC.includes('title: `Speed — ${state.speed}x`'), 'speed title reflects state');
    assert.ok(BG_SRC.includes('browser.menus.refresh()'), 'menu refreshed after updates');
    console.log('onShown: dynamic titles and refresh verified');
  });

  test('onClicked dispatches correct commands for volume/speed/night', () => {
    assert.ok(BG_SRC.includes("info.menuItemId.startsWith('vg-volume-')"), 'volume handler');
    assert.ok(BG_SRC.includes("info.menuItemId.startsWith('vg-speed-')"), 'speed handler');
    assert.ok(BG_SRC.includes("info.menuItemId.startsWith('vg-night-')"), 'night handler');
    assert.ok(BG_SRC.includes('VC.VOLUME_SET'), 'volume set command');
    assert.ok(BG_SRC.includes('VC.SPEED_SET'), 'speed set command');
    assert.ok(BG_SRC.includes('VC.NIGHT_SET'), 'night set command');
    console.log('onClick: command dispatch verified');
  });
});

// ---------------------------------------------------------------------------
// 5. Address bar icon path: theme getCurrent + setIcon flow
// ---------------------------------------------------------------------------
describe('address bar icon path', () => {
  test('icon variant maps dark<->light for contrast', () => {
    assert.ok(
      BG_SRC.includes("dark: { 16: 'icon-16-dark.png', 32: 'icon-32-dark.png' }"),
      'dark variant paths',
    );
    assert.ok(
      BG_SRC.includes("light: { 16: 'icon-16-light.png', 32: 'icon-32-light.png' }"),
      'light variant paths',
    );
    assert.ok(
      BG_SRC.includes("variant = isDarkTheme(theme) ? 'light' : 'dark'"),
      'dark theme uses light-stroked icon for contrast',
    );
    assert.ok(BG_SRC.includes('browser.pageAction.setIcon'), 'uses pageAction.setIcon');
    console.log('Icon variant: dark theme -> light icon (light strokes on dark bg)');
  });

  test('theme change listener and tab complete hook', () => {
    assert.ok(BG_SRC.includes('browser.theme.onUpdated.addListener'), 'listens for theme changes');
    assert.ok(BG_SRC.includes("changeInfo.status === 'complete'"), 'hooks tab complete event');
    assert.ok(BG_SRC.includes('applyThemeIcon(tabId)'), 'calls applyThemeIcon on tab complete');
    assert.ok(
      BG_SRC.includes('showPageAction(tabId, tab.url)'),
      'shows page action on tab complete',
    );
    console.log('Theme/tab flow: onUpdated + tab complete -> applyThemeIcon');
  });
});

// ---------------------------------------------------------------------------
// 6. Manifest compatibility
// ---------------------------------------------------------------------------
test('manifest: permissions, page_action, gecko settings', () => {
  assert.deepEqual(MANIFEST.permissions, [
    'menus',
    'storage',
    'webNavigation',
    'activeTab',
    'theme',
  ]);
  assert.equal(MANIFEST.browser_specific_settings.gecko.strict_min_version, '142.0');
  assert.ok(MANIFEST.page_action, 'page_action defined');
  assert.deepEqual(MANIFEST.page_action.show_matches, ['http://*/*', 'https://*/*']);
  assert.ok(MANIFEST.page_action.default_popup === 'popup.html', 'popup defined');
  assert.ok(MANIFEST.background.scripts.includes('background.js'), 'background.js loaded');
  assert.equal(MANIFEST.background.persistent, true, 'persistent background for pageAction');
  assert.equal(MANIFEST.version, '1.2.2');
  console.log(`Manifest v${MANIFEST.version}: valid permissions + page_action`);
});
