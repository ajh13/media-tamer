import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { firefox as bundledFirefox } from 'playwright';

// A real temporarily installed add-on, not content-script injection or mocked APIs.
test(
  'installed Firefox extension blocks seeks but preserves text input and frames',
  { timeout: 120000 },
  async (t) => {
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><head><script>
      window.keys=[]; window.addEventListener('keydown',e=>window.keys.push(e.key));
    </script></head><body><video></video><input id="entry"><button id="focus">Focus</button>
    ${req.url === '/frame' ? '' : '<iframe src="/frame" id="frame"></iframe>'}</body></html>`);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => server.close(r)));
    const url = `http://127.0.0.1:${server.address().port}`;
    const opts = new firefox.Options()
      .setBinary(bundledFirefox.executablePath())
      .addArguments('-headless');
    const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();
    t.after(() => driver.quit());
    await driver.get(url);
    await driver.findElement(By.id('focus')).sendKeys('5');
    assert.equal(
      await driver.executeScript('return window.keys.includes("5")'),
      true,
      'baseline must see digit',
    );
    const addon = await driver.installAddon(resolve('extensions/media-tamer'), true);
    assert.equal(addon, 'media-tamer@example.invalid');
    await driver.get(url);
    await driver.findElement(By.id('focus')).sendKeys('5');
    assert.equal(
      await driver.executeScript('return window.keys.includes("5")'),
      false,
      'installed add-on must block early site handler',
    );
    await driver.findElement(By.id('entry')).sendKeys('12345');
    assert.equal(await driver.findElement(By.id('entry')).getAttribute('value'), '12345');
    await driver.switchTo().frame(await driver.findElement(By.id('frame')));
    await driver.findElement(By.id('focus')).sendKeys('6');
    assert.equal(
      await driver.executeScript('return window.keys.includes("6")'),
      false,
      'all_frames must include child frame',
    );
    console.log(
      'Verified real Firefox temporary add-on: baseline, early digit interception, typing, iframe.',
    );
  },
);
