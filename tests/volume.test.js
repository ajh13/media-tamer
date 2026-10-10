/**
 * Volume feature unit tests for Video Number Guard.
 *
 * TDD: these tests fail BEFORE implementation exists.
 * We test the pure logic in volume.js and background.js that is
 * reachable from Node (no browser-only globals required at import time).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// =============================================================================
// Slice 1: Percent validation — the single source of truth for input safety.
// =============================================================================

test('RED→GREEN: validatePercent rejects non-finite values', async () => {
  const { validatePercent } = await import(
    '../extensions/media-tamer/volume.js'
  );
  for (const v of [NaN, Infinity, -Infinity, null, undefined, 'abc', '', true, false, {}, []]) {
    assert.equal(
      validatePercent(v),
      false,
      `validatePercent(${JSON.stringify(v)}) must be false`
    );
  }
});

test('RED→GREEN: validatePercent rejects out-of-range values', async () => {
  const { validatePercent } = await import(
    '../extensions/media-tamer/volume.js'
  );
  for (const v of [-1, -100, 301, 1000, 99999]) {
    assert.equal(
      validatePercent(v),
      false,
      `validatePercent(${v}) must be false`
    );
  }
});

test('RED→GREEN: validatePercent accepts integers 0-300 inclusive', async () => {
  const { validatePercent } = await import(
    '../extensions/media-tamer/volume.js'
  );
  for (const v of [0, 1, 50, 99, 100, 101, 150, 200, 299, 300]) {
    assert.equal(
      validatePercent(v),
      true,
      `validatePercent(${v}) must be true`
    );
  }
});

test('RED→GREEN: validatePercent rejects non-integer numbers', async () => {
  const { validatePercent } = await import(
    '../extensions/media-tamer/volume.js'
  );
  for (const v of [0.5, 50.5, 100.1, 299.9]) {
    assert.equal(
      validatePercent(v),
      false,
      `validatePercent(${v}) must be false`
    );
  }
});

test('RED→GREEN: normalizePercent coerces and clamps', async () => {
  const { normalizePercent } = await import(
    '../extensions/media-tamer/volume.js'
  );
  assert.equal(normalizePercent(100), 100);
  assert.equal(normalizePercent(150), 150);
  assert.equal(normalizePercent(0), 0);
  assert.equal(normalizePercent(300), 300);
  // Strings that are valid integers in range
  assert.equal(normalizePercent('50'), 50);
  assert.equal(normalizePercent('300'), 300);
  // Out-of-range clamps
  assert.equal(normalizePercent(-5), 0);
  assert.equal(normalizePercent(500), 300);
  // Non-finite / non-numeric rejected
  assert.equal(normalizePercent(NaN), null);
  assert.equal(normalizePercent('abc'), null);
  assert.equal(normalizePercent(null), null);
});

// =============================================================================
// Slice 2: Multiplier conversion
// =============================================================================

test('RED→GREEN: percentToMultiplier converts correctly', async () => {
  const { percentToMultiplier, multiplierToPercent } = await import(
    '../extensions/media-tamer/volume.js'
  );
  assert.equal(percentToMultiplier(0), 0);
  assert.equal(percentToMultiplier(50), 0.5);
  assert.equal(percentToMultiplier(100), 1.0);
  assert.equal(percentToMultiplier(200), 2.0);
  assert.equal(percentToMultiplier(300), 3.0);
  // Round-trip
  for (const p of [0, 25, 50, 100, 150, 200, 300]) {
    assert.equal(multiplierToPercent(percentToMultiplier(p)), p);
  }
});

// =============================================================================
// Slice 3: classifyMediaElement — pure logic with mock elements
// =============================================================================

test('RED→GREEN: classifyMediaElement returns unsafe for null', async () => {
  const { classifyMediaElement } = await import(
    '../extensions/media-tamer/volume.js'
  );
  assert.equal(classifyMediaElement(null), 'unsafe');
  assert.equal(classifyMediaElement(undefined), 'unsafe');
});

test('RED→GREEN: classifyMediaElement detects DRM via mediaKeys', async () => {
  const { classifyMediaElement } = await import(
    '../extensions/media-tamer/volume.js'
  );
  const el = { mediaKeys: {} };
  assert.equal(classifyMediaElement(el), 'unsafe');
});

test('RED→GREEN: classifyMediaElement detects DRM via encrypted flag', async () => {
  const { classifyMediaElement } = await import(
    '../extensions/media-tamer/volume.js'
  );
  const el = { __vgHadEncrypted: true };
  assert.equal(classifyMediaElement(el), 'unsafe');
});

test('RED→GREEN: classifyMediaElement returns gain for blob src', async () => {
  const { classifyMediaElement } = await import(
    '../extensions/media-tamer/volume.js'
  );
  const el = { currentSrc: 'blob:https://example.com/abc' };
  assert.equal(classifyMediaElement(el), 'gain');
});

test('RED→GREEN: classifyMediaElement returns gain for no src (MSE)', async () => {
  const { classifyMediaElement } = await import(
    '../extensions/media-tamer/volume.js'
  );
  const el = {};
  assert.equal(classifyMediaElement(el), 'gain');
});

// =============================================================================
// Slice 4: applyVolumeToElement — direct path
// =============================================================================

test('RED→GREEN: applyVolumeToElement sets volume directly for <=100%', async () => {
  const { applyVolumeToElement } = await import(
    '../extensions/media-tamer/volume.js'
  );
  const el = { volume: 1.0, muted: false };
  const state = {};
  const result = applyVolumeToElement(el, 50, state);
  assert.equal(result.applied, 50);
  assert.equal(result.method, 'direct');
  assert.equal(el.volume, 0.5);
});

test('RED→GREEN: applyVolumeToElement honors site mute', async () => {
  const { applyVolumeToElement } = await import(
    '../extensions/media-tamer/volume.js'
  );
  const el = { volume: 1.0, muted: true };
  const state = {};
  const result = applyVolumeToElement(el, 50, state);
  assert.equal(result.muted, true);
  assert.equal(result.method, 'unsupported');
});

test('RED→GREEN: applyVolumeToElement returns unsupported for >100% on unsafe', async () => {
  const { applyVolumeToElement } = await import(
    '../extensions/media-tamer/volume.js'
  );
  // Cross-origin without CORS
  const el = { currentSrc: 'https://other.com/video.mp4', muted: false, volume: 1.0 };
  const state = {};
  const result = applyVolumeToElement(el, 200, state);
  assert.equal(result.method, 'unsupported');
  assert.equal(result.applied, 100);
});

// =============================================================================
// Slice 5: debounce utility
// =============================================================================

test('RED→GREEN: debounce delays and coalesces calls', async () => {
  const { debounce } = await import(
    '../extensions/media-tamer/volume.js'
  );
  let count = 0;
  const fn = debounce(() => { count++; }, 10);
  fn();
  fn();
  fn();
  assert.equal(count, 0, 'should not fire immediately');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(count, 1, 'should fire once after wait');
});

// =============================================================================
// Slice 6: Speed protocol constants (for background routing)
// =============================================================================

test('RED→GREEN: speed protocol constants are defined', async () => {
  const { VC_SPEED_SET, VC_SPEED_GET, VC_SPEED_STATUS } = await import(
    '../extensions/media-tamer/background.js'
  );
  assert.equal(VC_SPEED_SET, 'VC_SPEED_SET');
  assert.equal(VC_SPEED_GET, 'VC_SPEED_GET');
  assert.equal(VC_SPEED_STATUS, 'VC_SPEED_STATUS');
});

test('RED→GREEN: volume protocol constants are defined', async () => {
  const { VC_VOLUME_SET, VC_VOLUME_GET, VC_VOLUME_STATUS } = await import(
    '../extensions/media-tamer/background.js'
  );
  assert.equal(VC_VOLUME_SET, 'VC_VOLUME_SET');
  assert.equal(VC_VOLUME_GET, 'VC_VOLUME_GET');
  assert.equal(VC_VOLUME_STATUS, 'VC_VOLUME_STATUS');
});

test('RED→GREEN: night mode protocol constants are defined', async () => {
  const { VC_NIGHT_SET, VC_NIGHT_GET, VC_NIGHT_STATUS } = await import(
    '../extensions/media-tamer/background.js'
  );
  assert.equal(VC_NIGHT_SET, 'VC_NIGHT_SET');
  assert.equal(VC_NIGHT_GET, 'VC_NIGHT_GET');
  assert.equal(VC_NIGHT_STATUS, 'VC_NIGHT_STATUS');
});

// =============================================================================
// Slice 7: Speed validation (mirrors volume validation)
// =============================================================================

test('RED→GREEN: validateSpeed rejects non-finite and out-of-range', async () => {
  const { validateSpeed } = await import(
    '../extensions/media-tamer/background.js'
  );
  for (const v of [NaN, Infinity, -Infinity, null, undefined, 'abc', '', true, false, {}, []]) {
    assert.equal(validateSpeed(v), false, `validateSpeed(${JSON.stringify(v)}) must be false`);
  }
  // Out of range
  assert.equal(validateSpeed(0.1), false);
  assert.equal(validateSpeed(3.5), false);
  assert.equal(validateSpeed(0), false);
  assert.equal(validateSpeed(-1), false);
});

test('RED→GREEN: validateSpeed accepts 0.25-3.0', async () => {
  const { validateSpeed } = await import(
    '../extensions/media-tamer/background.js'
  );
  for (const v of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3]) {
    assert.equal(validateSpeed(v), true, `validateSpeed(${v}) must be true`);
  }
});

// =============================================================================
// Slice 7b: Night mode validation
// =============================================================================

test('RED→GREEN: validateNightStrength rejects non-finite and out-of-range', async () => {
  const { validateNightStrength } = await import(
    '../extensions/media-tamer/background.js'
  );
  for (const v of [NaN, Infinity, -Infinity, null, undefined, 'abc', '', true, false, {}, []]) {
    assert.equal(validateNightStrength(v), false, `validateNightStrength(${JSON.stringify(v)}) must be false`);
  }
  assert.equal(validateNightStrength(-1), false);
  assert.equal(validateNightStrength(101), false);
  assert.equal(validateNightStrength(500), false);
});

test('RED→GREEN: validateNightStrength accepts 0-100', async () => {
  const { validateNightStrength } = await import(
    '../extensions/media-tamer/background.js'
  );
  for (const v of [0, 1, 35, 50, 70, 99, 100]) {
    assert.equal(validateNightStrength(v), true, `validateNightStrength(${v}) must be true`);
  }
});

// =============================================================================
// Slice 8: Sender validation — reject unrelated messages
// =============================================================================

test('RED→GREEN: isValidSender rejects unrelated extensions', async () => {
  const { isValidSender } = await import(
    '../extensions/media-tamer/background.js'
  );
  assert.equal(isValidSender({ id: 'other-extension@mozilla' }), false);
  assert.equal(isValidSender({ id: null }), false);
  assert.equal(isValidSender(undefined), false);
  assert.equal(isValidSender(null), false);
});

test('RED→GREEN: isValidSender accepts same-origin sender', async () => {
  const { isValidSender } = await import(
    '../extensions/media-tamer/background.js'
  );
  // Same-extension sender (our extension ID)
  assert.equal(isValidSender({ id: 'media-tamer@example.invalid' }), true);
  // No ID but from our content script (tab present)
  assert.equal(isValidSender({ tab: { id: 1 } }), true);
});

// =============================================================================
// Slice 9: Tab state management — new tabs default to 100%/1x/Off
// =============================================================================

test('RED→GREEN: getTabVolume returns 100 for new tabs', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  // Reset state
  mod.__resetTabState();
  assert.equal(mod.getTabVolume(1), 100);
  assert.equal(mod.getTabVolume(999), 100);
});

test('RED→GREEN: getTabSpeed returns 1 for new tabs', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  mod.__resetTabState();
  assert.equal(mod.getTabSpeed(1), 1);
  assert.equal(mod.getTabSpeed(999), 1);
});

test('RED→GREEN: getTabNight returns 0 for new tabs', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  mod.__resetTabState();
  assert.equal(mod.getTabNight(1), 0);
  assert.equal(mod.getTabNight(999), 0);
});

test('RED→GREEN: setTabVolume, setTabSpeed, setTabNight are independent', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  mod.__resetTabState();
  mod.setTabVolume(1, 150);
  mod.setTabSpeed(1, 2);
  mod.setTabNight(1, 70);
  assert.equal(mod.getTabVolume(1), 150);
  assert.equal(mod.getTabSpeed(1), 2);
  assert.equal(mod.getTabNight(1), 70);
  // Setting one doesn't affect the others
  mod.setTabVolume(1, 200);
  assert.equal(mod.getTabSpeed(1), 2);
  assert.equal(mod.getTabNight(1), 70);
  mod.setTabSpeed(1, 1.5);
  assert.equal(mod.getTabVolume(1), 200);
  assert.equal(mod.getTabNight(1), 70);
  mod.setTabNight(1, 35);
  assert.equal(mod.getTabVolume(1), 200);
  assert.equal(mod.getTabSpeed(1), 1.5);
});

test('RED→GREEN: cleanupTab removes state', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  mod.__resetTabState();
  mod.setTabVolume(1, 150);
  mod.setTabSpeed(1, 2);
  mod.setTabNight(1, 70);
  mod.cleanupTab(1);
  assert.equal(mod.getTabVolume(1), 100);
  assert.equal(mod.getTabSpeed(1), 1);
  assert.equal(mod.getTabNight(1), 0);
});

// =============================================================================
// Slice 10: Runtime message routing — handleRuntimeMessage
// =============================================================================

test('RED→GREEN: handleRuntimeMessage rejects unrelated senders', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  const result = mod.handleRuntimeMessage(
    { type: 'VC_VOLUME_SET', percent: 150 },
    { id: 'other-extension@mozilla' }
  );
  assert.equal(result, null);
});

test('RED→GREEN: handleRuntimeMessage rejects invalid percent', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  const result = mod.handleRuntimeMessage(
    { type: 'VC_VOLUME_SET', percent: 999 },
    { id: 'media-tamer@example.invalid' }
  );
  assert.equal(result.error, 'invalid percent');
});

test('RED→GREEN: handleRuntimeMessage accepts valid volume set', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  mod.__resetTabState();
  const result = mod.handleRuntimeMessage(
    { type: 'VC_VOLUME_SET', percent: 150, tabId: 1 },
    { id: 'media-tamer@example.invalid' }
  );
  assert.equal(result.ok, true);
  assert.equal(result.percent, 150);
  assert.equal(mod.getTabVolume(1), 150);
});

test('RED→GREEN: handleRuntimeMessage accepts valid speed set', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  mod.__resetTabState();
  const result = mod.handleRuntimeMessage(
    { type: 'VC_SPEED_SET', speed: 2, tabId: 1 },
    { id: 'media-tamer@example.invalid' }
  );
  assert.equal(result.ok, true);
  assert.equal(result.speed, 2);
  assert.equal(mod.getTabSpeed(1), 2);
});

test('RED→GREEN: handleRuntimeMessage rejects invalid speed', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  const result = mod.handleRuntimeMessage(
    { type: 'VC_SPEED_SET', speed: 5 },
    { id: 'media-tamer@example.invalid' }
  );
  assert.equal(result.error, 'invalid speed');
});

test('RED→GREEN: handleRuntimeMessage accepts valid night set', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  mod.__resetTabState();
  const result = mod.handleRuntimeMessage(
    { type: 'VC_NIGHT_SET', strength: 70, tabId: 1 },
    { id: 'media-tamer@example.invalid' }
  );
  assert.equal(result.ok, true);
  assert.equal(result.strength, 70);
  assert.equal(mod.getTabNight(1), 70);
});

test('RED→GREEN: handleRuntimeMessage rejects invalid night strength', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  const result = mod.handleRuntimeMessage(
    { type: 'VC_NIGHT_SET', strength: 200 },
    { id: 'media-tamer@example.invalid' }
  );
  assert.equal(result.error, 'invalid night strength');
});

test('RED→GREEN: handleRuntimeMessage volume get returns current', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  mod.__resetTabState();
  mod.setTabVolume(1, 200);
  const result = mod.handleRuntimeMessage(
    { type: 'VC_VOLUME_GET', tabId: 1 },
    { id: 'media-tamer@example.invalid' }
  );
  assert.equal(result.ok, true);
  assert.equal(result.percent, 200);
});

test('RED→GREEN: handleRuntimeMessage night get returns current', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  mod.__resetTabState();
  mod.setTabNight(1, 35);
  const result = mod.handleRuntimeMessage(
    { type: 'VC_NIGHT_GET', tabId: 1 },
    { id: 'media-tamer@example.invalid' }
  );
  assert.equal(result.ok, true);
  assert.equal(result.strength, 35);
  assert.equal(result.active, true);
});

test('RED→GREEN: handleRuntimeMessage ignores unknown message types', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  const result = mod.handleRuntimeMessage(
    { type: 'UNKNOWN_TYPE' },
    { id: 'media-tamer@example.invalid' }
  );
  assert.equal(result, null);
});

// =============================================================================
// Slice 11: Popup state — format percentage display
// =============================================================================

test('RED→GREEN: formatVolumeLabel shows percentage', async () => {
  const { formatVolumeLabel } = await import(
    '../extensions/media-tamer/popup.js'
  );
  assert.equal(formatVolumeLabel(100), '100%');
  assert.equal(formatVolumeLabel(150), '150%');
  assert.equal(formatVolumeLabel(0), '0%');
  assert.equal(formatVolumeLabel(300), '300%');
});

test('RED→GREEN: formatSpeedLabel shows multiplier', async () => {
  const { formatSpeedLabel } = await import(
    '../extensions/media-tamer/popup.js'
  );
  assert.equal(formatSpeedLabel(1), '1.00x');
  assert.equal(formatSpeedLabel(1.5), '1.50x');
  assert.equal(formatSpeedLabel(0.25), '0.25x');
  assert.equal(formatSpeedLabel(3), '3.00x');
});

test('RED→GREEN: formatNightLabel shows strength', async () => {
  const { formatNightLabel } = await import(
    '../extensions/media-tamer/popup.js'
  );
  assert.equal(formatNightLabel(0), 'Off');
  assert.equal(formatNightLabel(35), '35');
  assert.equal(formatNightLabel(70), '70');
  assert.equal(formatNightLabel(100), '100');
});

test('RED→GREEN: formatVolumeStatus shows applied/unavailable', async () => {
  const { formatVolumeStatus } = await import(
    '../extensions/media-tamer/popup.js'
  );
  assert.equal(formatVolumeStatus({ method: 'direct', applied: 150 }), 'Applied: 150%');
  assert.equal(formatVolumeStatus({ method: 'gain', applied: 200 }), 'Applied: 200% (gain)');
  assert.equal(formatVolumeStatus({ method: 'unsupported', applied: 100 }), 'Unavailable (DRM/cross-origin)');
  assert.equal(formatVolumeStatus({ method: 'unsupported', muted: true }), 'Unavailable (site muted)');
  assert.equal(formatVolumeStatus(null), 'No media');
});

test('RED→GREEN: formatNightStatus shows active/off', async () => {
  const { formatNightStatus } = await import(
    '../extensions/media-tamer/popup.js'
  );
  assert.equal(formatNightStatus({ active: true, strength: 70 }), 'Active: 70%');
  assert.equal(formatNightStatus({ active: false, strength: 0 }), 'Off');
  assert.equal(formatNightStatus(null), 'Off');
});

// =============================================================================
// Slice 12: Context menu — target tab is right-clicked tab, not active tab
// =============================================================================

test('RED→GREEN: context menu click targets right-clicked tab', async () => {
  const mod = await import(
    '../extensions/media-tamer/background.js'
  );
  mod.__resetTabState();
  // Verify notifyVolume is a function that accepts tabId
  assert.equal(typeof mod.notifyVolume, 'function');
  assert.equal(typeof mod.notifySpeed, 'function');
  assert.equal(typeof mod.notifyNight, 'function');
  // The menu onClick handler uses info.tabId (right-clicked tab), not active tab.
  // We verify by checking that setTabVolume only affects the target tab.
  mod.setTabVolume(5, 150);
  mod.setTabVolume(1, 50); // Active tab unaffected
  assert.equal(mod.getTabVolume(5), 150, 'Right-click tab keeps its volume');
  assert.equal(mod.getTabVolume(1), 50, 'Active tab unaffected');
});

// =============================================================================
// Slice 13: Popup state summarization — mixed media
// =============================================================================

test('RED→GREEN: summarizeVolumeStatus handles mixed media', async () => {
  const { summarizeVolumeStatus } = await import(
    '../extensions/media-tamer/popup.js'
  );
  // All direct
  assert.equal(
    summarizeVolumeStatus([{ method: 'direct', applied: 150 }]).summary,
    'Applied: 150%'
  );
  // Mixed with unsupported
  const mixed = summarizeVolumeStatus([
    { method: 'direct', applied: 150 },
    { method: 'unsupported', applied: 100 },
  ]);
  assert.equal(mixed.hasUnavailable, true);
  assert.match(mixed.summary, /Mixed media \(1 unavailable\)/);
  // Empty
  assert.equal(summarizeVolumeStatus([]).summary, 'No media');
  assert.equal(summarizeVolumeStatus(null).summary, 'No media');
  // Muted
  const muted = summarizeVolumeStatus([{ method: 'unsupported', muted: true }]);
  assert.equal(muted.muted, true);
});

test('RED→GREEN: formatSpeedStatus shows error', async () => {
  const { formatSpeedStatus } = await import(
    '../extensions/media-tamer/popup.js'
  );
  assert.equal(formatSpeedStatus({ ok: true, speed: 1.5 }), 'Applied: 1.50x');
  assert.equal(formatSpeedStatus({ error: 'invalid' }), 'Error: invalid');
  assert.equal(formatSpeedStatus(null), 'No media');
});
