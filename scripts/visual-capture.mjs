/**
 * Visual capture script — renders the production popup in real Firefox via
 * Playwright, captures light/dark × collapsed/expanded screenshots with a
 * controlled browser API fixture. Outputs PNGs + manifest.json to
 * ./artifacts/visuals/.
 *
 * Usage:
 *   node scripts/visual-capture.mjs [--base <ref>]
 *
 * With --base, captures the base ref first (before), then the current checkout
 * (after), producing side-by-side "before/after" sets for PR diff previews.
 *
 * Security: this script renders static HTML with a mocked browser API. It does
 * NOT execute any extension code paths beyond popup.js init (which only reads
 * from the mocked API). No network, no secrets, no storage writes.
 */
import { firefox } from 'playwright';
/* global document */ // browser globals used inside Playwright .evaluate() callbacks
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const POPUP_PATH = resolve(ROOT, 'extensions/media-tamer/popup.html');
const OUTPUT_DIR = resolve(ROOT, 'artifacts/visuals');

// Browser API mock — mirrors the VC protocol responses popup.js expects.
// Uses localStorage for storage.local so appearance persists across reloads.
const BROWSER_MOCK = `
  window.__BROWSER_MOCK__ = true;
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
      sendMessage: async (tabId, msg) => {
        const r = {
          VC_VOLUME_GET: { status: 'ok', percent: 100, appliedPercent: 100, count: 1 },
          VC_SPEED_GET: { status: 'ok', speed: 1, appliedSpeed: 1 },
          VC_NIGHT_GET: { status: 'ok', strength: 0, active: false },
        };
        return r[msg?.action] || { status: 'ok' };
      },
    },
    permissions: { request: async () => true },
    storage: {
      local: {
        get: async (key) => {
          if (key === 'appearance') {
            return { appearance: window.__FORCED_APPEARANCE__ || 'system' };
          }
          return {};
        },
        set: async (data) => {
          if (data?.appearance) window.localStorage.setItem('appearance', data.appearance);
        },
      },
    },
  };
`;

const CAPTURES = [
  {
    name: 'light-collapsed',
    colorScheme: 'light',
    theme: 'light',
    expandSettings: false,
    expandMr: false,
  },
  {
    name: 'light-expanded',
    colorScheme: 'light',
    theme: 'light',
    expandSettings: true,
    expandMr: true,
  },
  {
    name: 'dark-collapsed',
    colorScheme: 'dark',
    theme: 'dark',
    expandSettings: false,
    expandMr: false,
  },
  {
    name: 'dark-expanded',
    colorScheme: 'dark',
    theme: 'dark',
    expandSettings: true,
    expandMr: true,
  },
];

/**
 * Capture one set of screenshots.
 * @param {string} label  Suffix for filenames (e.g. "" or "-after").
 * @returns {Promise<Array<{name: string, path: string, width: number, height: number, scrollHeight: number}>>}
 */
async function captureSet(label) {
  const browser = await firefox.launch({ headless: true });
  const results = [];

  for (const cap of CAPTURES) {
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      colorScheme: cap.colorScheme,
    });
    const page = await context.newPage();

    // Inject mock BEFORE any page scripts run.
    await page.addInitScript(BROWSER_MOCK);
    await page.addInitScript(`window.__FORCED_APPEARANCE__ = '${cap.theme}';`);

    await page.goto('file://' + POPUP_PATH);

    // Wait for popup.js init to complete (values rendered).
    await page
      .waitForFunction(
        () => {
          const v = document.getElementById('volume-value');
          return v && v.textContent && v.textContent !== '';
        },
        { timeout: 5000 },
      )
      .catch(() => {});

    // Expand settings panel — click the real #settings-toggle button so popup.js
    // toggles details.open and aria-expanded (NOT .hidden, which is a no-op on
    // <details>; that stale path produced identical collapsed/expanded captures).
    if (cap.expandSettings) {
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
    }

    // Media Roller block lives inside settings-body (there is no separate
    // <details id="mr-settings"> — expandMr is structurally a no-op). Scroll
    // it into view so the screenshot captures it when present.
    if (cap.expandMr) {
      await page
        .locator('.mr-block')
        .scrollIntoViewIfNeeded()
        .catch(() => {});
    }

    // Let layout settle.
    await page.waitForTimeout(300);

    const filename = label ? `popup-${cap.name}${label}.png` : `popup-${cap.name}.png`;
    const screenshotPath = resolve(OUTPUT_DIR, filename);
    await page.locator('.popup').screenshot({ path: screenshotPath });

    const dims = await page.locator('.popup').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        width: Math.round(r.width),
        height: Math.round(r.height),
        scrollHeight: el.scrollHeight,
      };
    });

    results.push({ name: cap.name, path: screenshotPath, filename, ...dims });
    await context.close();
  }

  await browser.close();
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf('--base');
  const baseRef = baseIdx !== -1 ? args[baseIdx + 1] : null;

  if (!existsSync(POPUP_PATH)) {
    console.error(`Popup not found: ${POPUP_PATH}`);
    process.exit(1);
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  const captureMeta = {
    generatedAt: new Date().toISOString(),
    commitSha: process.env.GITHUB_SHA || 'local',
    ref: process.env.GITHUB_REF || 'local',
    runId: process.env.GITHUB_RUN_ID || 'local',
    baseRef: baseRef || null,
  };

  let allResults = [];

  // Capture base (before) if requested.
  if (baseRef) {
    console.log(`Capturing base ref: ${baseRef}`);
    // Note: caller must have already checked out baseRef before invoking.
    const beforeResults = await captureSet('-before');
    allResults = allResults.concat(beforeResults);
  }

  // Capture current (head/after).
  console.log('Capturing current checkout (head)');
  const afterResults = await captureSet(baseRef ? '-after' : '');
  allResults = allResults.concat(afterResults);

  captureMeta.captures = allResults;
  await writeFile(resolve(OUTPUT_DIR, 'manifest.json'), JSON.stringify(captureMeta, null, 2));

  console.log('Capture complete:');
  for (const r of allResults) {
    console.log(`  ${r.filename}: ${r.width}x${r.height} (scroll: ${r.scrollHeight})`);
  }
}

main().catch((err) => {
  console.error('Capture failed:', err);
  process.exit(1);
});
