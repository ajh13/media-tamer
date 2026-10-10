import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve('extensions/media-tamer');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
test('combined extension loads every component in dependency order', () => {
  assert.deepEqual(manifest.content_scripts[0].js, [
    'content.js',
    'night-mode.js',
    'volume.js',
    'speed.js',
    'seek-undo.js',
  ]);
  assert.deepEqual(manifest.background.scripts, ['media-roller.js', 'background.js']);
  assert.equal(manifest.background.persistent, true);
  assert.equal(manifest.page_action.default_popup, 'popup.html');
  for (const name of [
    ...manifest.content_scripts[0].js,
    ...manifest.background.scripts,
    manifest.page_action.default_popup,
  ])
    assert.ok(existsSync(resolve(root, name)), name);
});
test('optional URL transmission and native downloads require consent', () => {
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions, {
    required: ['none'],
    optional: ['browsingActivity'],
  });
  assert.ok(manifest.optional_permissions.includes('downloads'));
  assert.ok(!manifest.permissions.includes('downloads'));
  assert.ok(!manifest.permissions.includes('<all_urls>'));
});

test('tabs permission is absent — activeTab grants tab access via genuine popup gesture', () => {
  assert.ok(
    !manifest.permissions.includes('tabs'),
    '"tabs" must not be in permissions; activeTab grants access via popup, avoiding permanent permission expansion',
  );
  assert.ok(
    manifest.permissions.includes('activeTab'),
    'activeTab must be present for genuine popup-based tab access',
  );
});
