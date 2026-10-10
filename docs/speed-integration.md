# Speed Integration Contract

## Owned files
- `extensions/media-tamer/speed.js` — content script (IIFE, self-contained)
- `tests/speed.test.js` — unit tests (14 tests, all passing)

## Manifest changes (parent owns)
Add `speed.js` to the `content_scripts` array in `manifest.json` alongside `content.js`:

```json
"content_scripts": [
  {
    "matches": ["http://*/*", "https://*/*"],
    "js": ["content.js", "speed.js"],
    "all_frames": true,
    "run_at": "document_start"
  }
]
```

No new permissions required. No background script changes needed for basic operation.

## Message Protocol

All messages use `browser.runtime.sendMessage()` / `browser.runtime.onMessage`.

### VC_SPEED_SET — Set playback speed

**Direction:** Background/Popup → Content script

```js
browser.tabs.sendMessage(tabId, {
  type: 'VC_SPEED_SET',
  speed: 1.5,        // number, 0.25–3.0
  tabId: tabId       // optional, for unsolicited status routing
});
```

**Response (exact contract):**
```js
{
  speed: 1.5,           // requested/target speed (normalized)
  appliedSpeed: 1.5,    // actual speed applied (avg across elements), null if none
  count: 3,             // number of media elements successfully set
  status: 'ok',         // 'ok' | 'partial' | 'unsupported' | 'error'
  error: undefined,     // present only on error
  clamp: undefined,     // true if site clamped the speed
  countUnsupported: 0,  // elements that errored
  countSkipped: 0       // elements skipped
}
```

**Status values:**
- `ok` — all target elements set successfully (clamp flag may still be set)
- `partial` — some elements set, some errored
- `unsupported` — no media elements found
- `error` — invalid input or all elements failed

### VC_SPEED_GET — Query current speed

**Direction:** Background/Popup → Content script

```js
browser.tabs.sendMessage(tabId, {
  type: 'VC_SPEED_GET'
});
```

**Response:**
```js
{
  speed: 1.5,           // current target speed (1.0 if never set)
  appliedSpeed: 1.5,    // actual applied speed, null if never set
  count: 3,             // number of media elements in document
  status: 'ok'          // 'ok' | 'unsupported'
}
```

### VC_SPEED_STATUS — Unsolicited status update

**Direction:** Content script → Background (sent after SET/RESET)

```js
{
  type: 'VC_SPEED_STATUS',
  speed: 1.5,
  appliedSpeed: 1.5,
  count: 3,
  status: 'ok',
  tabId: tabId           // included if provided in SET
}
```

Background can listen with `browser.runtime.onMessage.addListener()` and check `msg.type === 'VC_SPEED_STATUS'`.

### VC_SPEED_RESET — Reset to 1.0x

**Direction:** Background/Popup → Content script

```js
browser.tabs.sendMessage(tabId, {
  type: 'VC_SPEED_RESET'
});
```

**Response:** Same shape as VC_SPEED_SET, with `speed: 1`.

## Validation Rules

| Input | Result |
|-------|--------|
| Non-number (`'abc'`, `null`, `{}`) | `validateSpeed` → `false`, normalize → `null` |
| `NaN`, `±Infinity` | rejected |
| `< 0.25` | clamped to `0.25` |
| `> 3.0` | clamped to `3.0` |
| `1.025` | rounded to `1.05` (nearest 0.05 step) |
| `1.024` | rounded to `1.0` |
| String `'1.5'` | coerced to `1.5` |

## UI Spec (parent owns)

### Popup Slider
- Label: **Playback speed**
- Range: `0.25` to `3.0`
- Step: `0.05`
- Show current value (e.g., "1.5x")
- Reset button → sends `VC_SPEED_RESET`

### Tab Context Menu
- Show current speed (e.g., "Speed: 1.5x")
- Preset items: `0.25x`, `0.5x`, `1x`, `1.5x`, `2x`, `3x`
- Each preset sends `VC_SPEED_SET` with that value

## Behavior Notes

1. **Per-document only** — no storage, no persistence. New tabs/documents default to 1.0.
2. **Video preferred** — `<video>` elements are targeted first; `<audio>` only if no video exists in the same root.
3. **Shadow DOM** — open shadow roots are traversed automatically.
4. **SPA support** — MutationObserver re-applies speed to dynamically inserted media.
5. **No feedback loops** — own changes are tagged with `__vgOwnChange` flag; site-initiated rate changes are detected and not fought.
6. **Pitch preserved** — sets `preservesPitch = true` (and `mozPreservesPitch`, `webkitPreservesPitch`) where supported.
7. **Honest reporting** — `appliedSpeed` reflects actual `playbackRate` after site clamp; `clamp: true` flag set if site refused requested speed.
8. **Sender validation** — messages from other extension IDs are silently ignored.
9. **defaultPlaybackRate** — only set if it's still at 1.0 (not prechanged by site/user before extension use).

## Error Handling

- Invalid speed → response with `status: 'error'`, `error: 'invalid speed value'`
- No media elements → `status: 'unsupported'`, `appliedSpeed: null`, `count: 0`
- Site clamp → `status: 'ok'`, `clamp: true`, `appliedSpeed` = actual rate
- Mixed results → `status: 'partial'`, `countUnsupported` = error count

## Test Results

```
✔ 14 speed tests passing
✔ 43 total project tests passing
```

Run: `node --test tests/speed.test.js`
