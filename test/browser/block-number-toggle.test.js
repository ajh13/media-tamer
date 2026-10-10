import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { firefox as bundledFirefox } from 'playwright';

// Real Firefox installed addon: verify toggle OFF -> ON propagation to active
// tabs and frames WITHOUT reload, using genuine popup storage API through the
// extension context. Also verifies default ON blocking is preserved.
test(
  'installed Firefox addon: OFF -> ON live propagation to active tabs and frames',
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
      .addArguments('-headless', '--allow-system-access');
    const driver = await new Builder()
      .forBrowser('firefox')
      .setFirefoxOptions(opts)
      .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access'))
      .build();
    t.after(() => driver.quit());

    // Install addon
    const addon = await driver.installAddon(resolve('extensions/media-tamer'), true);
    assert.equal(addon, 'media-tamer@example.invalid');

    // Navigate to page (default ON active)
    await driver.get(url);
    await driver.findElement(By.id('focus')).sendKeys('5');
    assert.equal(
      await driver.executeScript('return window.keys.includes("5")'),
      false,
      'installed add-on must block digit with default ON',
    );
    await driver.findElement(By.id('entry')).sendKeys('12345');
    assert.equal(
      await driver.findElement(By.id('entry')).getAttribute('value'),
      '12345',
      'typing preserved with default ON',
    );

    // Verify iframe blocking with default ON
    await driver.switchTo().frame(await driver.findElement(By.id('frame')));
    await driver.findElement(By.id('focus')).sendKeys('6');
    assert.equal(
      await driver.executeScript('return window.keys.includes("6")'),
      false,
      'all_frames must include child frame with default ON',
    );
    await driver.switchTo().parentFrame();

    // Open the installed extension's settings document in a separate tab.
    // This validates its real checkbox/storage path, not toolbar positioning.
    const mediaHandle = await driver.getWindowHandle();
    await driver.setContext('chrome');
    const uuid = await driver.executeScript(
      `return JSON.parse(Services.prefs.getStringPref('extensions.webextensions.uuids'))['media-tamer@example.invalid'];`,
    );
    await driver.setContext('content');
    assert.ok(uuid);
    await driver.switchTo().newWindow('tab');
    const settingsHandle = await driver.getWindowHandle();
    await driver.get(`moz-extension://${uuid}/popup.html`);
    await driver.findElement(By.id('settings-toggle')).click();
    const checkbox = await driver.findElement(By.id('block-number-keys'));
    await driver.wait(async () => await checkbox.isEnabled(), 5000);
    assert.equal(await checkbox.isSelected(), true);
    await checkbox.click();
    await driver.wait(
      () =>
        driver.executeScript(
          async () =>
            (await browser.storage.local.get('blockNumberKeys')).blockNumberKeys === false,
        ),
      5000,
    );
    await driver.switchTo().window(mediaHandle);

    // Give onChanged propagation a tick
    await new Promise((r) => setTimeout(r, 100));

    // Digit should now pass on active main tab (no reload)
    await driver.findElement(By.id('focus')).sendKeys('7');
    assert.equal(
      await driver.executeScript('return window.keys.includes("7")'),
      true,
      'OFF must propagate to active main tab without reload',
    );

    // Digit should also pass in the iframe (no reload)
    await driver.switchTo().frame(await driver.findElement(By.id('frame')));
    await driver.findElement(By.id('focus')).sendKeys('8');
    assert.equal(
      await driver.executeScript('return window.keys.includes("8")'),
      true,
      'OFF must propagate to child frame without reload',
    );
    await driver.switchTo().parentFrame();

    // Toggle the actual checkbox back ON, leaving the media document intact.
    await driver.switchTo().window(settingsHandle);
    await driver.findElement(By.id('block-number-keys')).click();
    await driver.wait(
      () =>
        driver.executeScript(
          async () => (await browser.storage.local.get('blockNumberKeys')).blockNumberKeys === true,
        ),
      5000,
    );
    await driver.switchTo().window(mediaHandle);
    await new Promise((r) => setTimeout(r, 100));

    // Digit must be blocked again on active main tab
    await driver.findElement(By.id('focus')).sendKeys('9');
    assert.equal(
      await driver.executeScript('return window.keys.includes("9")'),
      false,
      'ON must propagate to active main tab without reload',
    );

    // Digit must be blocked again in iframe
    await driver.switchTo().frame(await driver.findElement(By.id('frame')));
    await driver.findElement(By.id('focus')).sendKeys('0');
    assert.equal(
      await driver.executeScript('return window.keys.includes("0")'),
      false,
      'ON must propagate to child frame without reload',
    );

    console.log(
      'Verified real Firefox temporary add-on: OFF->ON live propagation to active tabs and frames without reload.',
    );
  },
);
