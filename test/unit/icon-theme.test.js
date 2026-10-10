import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

const root = resolve('extensions/media-tamer');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));

function parsePNG(buffer) {
  // Verify signature
  const sig = buffer.subarray(0, 8).toString('hex');
  assert.equal(sig, '89504e470d0a1a0a', 'PNG signature');

  let pos = 8;
  let width = 0;
  let height = 0;
  let idat = Buffer.alloc(0);

  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const tag = buffer.subarray(pos + 4, pos + 8).toString('ascii');
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (tag === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (tag === 'IDAT') {
      idat = Buffer.concat([idat, data]);
    }
    pos += 12 + length;
  }

  const raw = inflateSync(idat);
  const channels = 4; // RGBA
  const stride = width * channels + 1; // filter byte per row
  const pixels = [];
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride + 1; // skip filter byte
    for (let x = 0; x < width; x++) {
      const offset = rowStart + x * channels;
      pixels.push({
        r: raw[offset],
        g: raw[offset + 1],
        b: raw[offset + 2],
        a: raw[offset + 3],
      });
    }
  }

  return { width, height, pixels };
}

test('manifest declares theme-aware page_action icons with default fallback', () => {
  const pa = manifest.page_action;

  // Default icon fallback (dark variant — safe on light themes)
  assert.deepEqual(pa.default_icon, {
    16: 'icon-16-dark.png',
    32: 'icon-32-dark.png',
    48: 'icon-48-dark.png',
    96: 'icon-96-dark.png',
  });

  // theme_icons is NOT a supported property for page_action in Firefox
  // (Bug 1409107). The extension swaps icons at runtime via
  // browser.theme.getCurrent() + pageAction.setIcon() instead.
  assert.ok(
    !pa.theme_icons,
    'page_action.theme_icons must be absent — Firefox rejects it; runtime swapping handles theme awareness',
  );
});

test('all icon PNGs exist with correct dimensions and alpha channel', () => {
  // The icon sizes we declare
  const sizes = [16, 32, 48, 96];
  const variants = ['dark', 'light'];

  for (const size of sizes) {
    for (const variant of variants) {
      const fname = `icon-${size}-${variant}.png`;
      const path = resolve(root, fname);
      assert.ok(existsSync(path), `${fname} exists`);

      const png = parsePNG(readFileSync(path));

      // Dimensions
      assert.equal(png.width, size, `${fname} width ${size}`);
      assert.equal(png.height, size, `${fname} height ${size}`);

      // Alpha channel is used (icon has transparent background)
      let hasAlpha = false;
      let hasOpaque = false;
      for (const p of png.pixels) {
        if (p.a === 0) hasAlpha = true;
        else if (p.a > 0) hasOpaque = true;
      }
      assert.ok(hasAlpha, `${fname} has transparent pixels (alpha=0)`);
      assert.ok(hasOpaque, `${fname} has visible content pixels (alpha>0)`);
    }
  }
});

test('dark and light icon variants differ in stroke color', () => {
  // Compare 32px dark vs light icons — they should have distinct average colors
  for (const size of [32, 48]) {
    const darkPath = resolve(root, `icon-${size}-dark.png`);
    const lightPath = resolve(root, `icon-${size}-light.png`);

    const dark = parsePNG(readFileSync(darkPath));
    const light = parsePNG(readFileSync(lightPath));

    // Collect average RGB of opaque pixels
    function avgRGB(png) {
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (const p of png.pixels) {
        if (p.a > 0) {
          r += p.r;
          g += p.g;
          b += p.b;
          n++;
        }
      }
      return n === 0 ? [0, 0, 0] : [r / n, g / n, b / n];
    }

    const darkAvg = avgRGB(dark);
    const lightAvg = avgRGB(light);

    // Dark variant should be darker than light variant
    const darkLum = 0.299 * darkAvg[0] + 0.587 * darkAvg[1] + 0.114 * darkAvg[2];
    const lightLum = 0.299 * lightAvg[0] + 0.587 * lightAvg[1] + 0.114 * lightAvg[2];

    assert.ok(darkLum < lightLum, `icon-${size} dark variant is darker than light variant`);
    assert.ok(darkLum < 100, `icon-${size}-dark has dark stroke (luminance < 100)`);
    assert.ok(lightLum > 180, `icon-${size}-light has light stroke (luminance > 180)`);
  }
});

test('theme permission is declared for runtime theme-awareness', () => {
  // browser.theme permission needed for getCurrent()/onUpdated
  assert.ok(
    manifest.permissions.includes('theme'),
    'manifest must declare "theme" permission for theme-aware icon swapping',
  );
});

test('all manifest icon references resolve to real files', () => {
  // page_action.default_icon
  for (const [size, path] of Object.entries(manifest.page_action.default_icon)) {
    assert.ok(existsSync(resolve(root, path)), `page_action.default_icon.${size} → ${path}`);
  }

  // top-level icons
  for (const [size, path] of Object.entries(manifest.icons)) {
    assert.ok(existsSync(resolve(root, path)), `icons.${size} → ${path}`);
  }
});
