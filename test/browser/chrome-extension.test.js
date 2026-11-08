import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

test(
  'installed Chrome extension blocks seeks and shares the working Media Tamer popup',
  {
    timeout: 90000,
  },
  async (t) => {
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><head><script>
      window.keys = []; window.addEventListener('keydown', e => window.keys.push(e.key));
    </script></head><body><video></video><input id="entry"><button id="focus">Focus</button>
    ${req.url === '/frame' ? '' : '<iframe src="/frame"></iframe>'}</body></html>`);
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    t.after(() => {
      server.close();
      server.closeAllConnections();
    });
    const extension = resolve('dist/chrome');
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    t.after(() => context.close());
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = context.pages()[0];
    const [mediaTab] = await worker.evaluate(() =>
      chrome.tabs.query({ active: true, currentWindow: true }),
    );
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#focus').press('5');
    await page.frameLocator('iframe').locator('#focus').press('6');
    assert.deepEqual(await page.evaluate(() => window.keys), []);
    assert.deepEqual(
      await page
        .frameLocator('iframe')
        .locator('body')
        .evaluate(() => window.keys),
      [],
    );
    await page.locator('#entry').pressSequentially('12345');
    await expect(page.locator('#entry')).toHaveValue('12345');

    // Load the installed popup document in a background tab. The media tab
    // stays active so the popup resolves the same target as the toolbar action.
    const popup = await context.newPage();
    await page.bringToFront();
    await popup.goto(new URL('popup.html', worker.url()).href);
    await expect(popup).toHaveTitle('Media Tamer');
    await expect(popup.locator('#volume-slider')).toBeEnabled();
    await popup.locator('#volume-slider').fill('50');
    await expect.poll(() => page.locator('video').evaluate((video) => video.volume)).toBe(0.5);
    await popup.locator('#speed-slider').fill('2');
    await expect
      .poll(() =>
        page
          .frameLocator('iframe')
          .locator('video')
          .evaluate((video) => video.playbackRate),
      )
      .toBe(2);

    // Restart just the worker. The same page and popup should retain the settings.
    await worker.evaluate(() => {
      self.mediaTamerTestMarker = true;
    });
    const devtools = await context.newCDPSession(page);
    await devtools.send('ServiceWorker.enable');
    await devtools.send('ServiceWorker.stopAllWorkers');
    const readVolume = () =>
      popup.evaluate(
        (tabId) => chrome.runtime.sendMessage({ type: 'VC_VOLUME_GET', tabId }),
        mediaTab.id,
      );
    const state = await readVolume();
    assert.equal(state.percent, 50);
    assert.equal(state.appliedPercent, 50);
    assert.equal(await worker.evaluate(() => self.mediaTamerTestMarker), undefined);

    await page.reload();
    assert.equal((await readVolume()).percent, 100, 'full navigation resets playback settings');
  },
);
