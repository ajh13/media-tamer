import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { firefox } from 'playwright';

test('sliders cannot jump before popup initialization attaches drag handlers', async () => {
  const browser = await firefox.launch();
  try {
    const page = await browser.newPage();
    // Deliberately pause initialization: exercise shipped markup and CSS,
    // before popup.js can cancel native range-input pointer behavior.
    const root = resolve('extensions/media-tamer');
    const html = (await readFile(resolve(root, 'popup.html'), 'utf8'))
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
      .replace(/<link[^>]*href="popup.css"[^>]*>/g, '');
    await page.setContent(html);
    await page.addStyleTag({ content: await readFile(resolve(root, 'popup.css'), 'utf8') });
    for (const [id, value] of [
      ['volume-slider', '100'],
      ['peaks-slider', '0'],
      ['speed-slider', '1'],
    ]) {
      const slider = page.locator(`#${id}`);
      const box = await slider.boundingBox();
      assert.ok(box);
      await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
      assert.equal(await slider.inputValue(), value, `${id} must not jump before initialization`);
      assert.equal(await slider.isDisabled(), true, `${id} must start disabled`);
    }
  } finally {
    await browser.close();
  }
});
