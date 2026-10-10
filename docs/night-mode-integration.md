# Night Mode Integration Contract

## Owned files
- `extensions/media-tamer/night-mode.js` — classic content script (no ES exports)
- `extensions/media-tamer/tests/night-mode.test.js` — unit tests (17 tests, all passing)
- `extensions/media-tamer/tests/night-mode.browser.test.js` — browser integration tests (5 tests, all passing)

## Manifest changes (parent owns)
Add `night-mode.js` to the `content_scripts` array in `manifest.json` alongside `content.js`:

```json
"content_scripts": [
  {
    "matches": ["http://*/*", "https://*/*"],
    "js": ["content.js", "night-mode.js"],
    "all_frames": true,
    "run_at": "document_start"
  }
]
```

No new permissions required.

## API

### Global constant

```js
var VC_NIGHT_MODE = {
  PRESETS: { OFF: 0, LIGHT: 35, STRONG: 70 },
  MIN_STRENGTH: 0,
  MAX_STRENGTH: 100,
  DEFAULT_STRENGTH: 0,
  BASE_THRESHOLD: -24,
  BASE_RATIO: 4,
  BASE_KNEE: 12,
  BASE_ATTACK: 0.005,
  BASE_RELEASE: 0.25,
  RAMP_TIME: 0.02,
};
```

`VC_NIGHT_MODE` is a `var` in the isolated content-script scope — NOT `window.VC_NIGHT_MODE` (page API). This is intentional: classic content scripts run in an isolated world.

### Factory: `create(context)`

```js
const helper = VC_NIGHT_MODE.create(audioContext);
```

Creates a parallel dry/wet compression helper in the given `AudioContext`.

**Graph topology:**
```
input -> dryGain -> output           (dry path, unity at bypass)
input -> compressor -> wetGain -> output  (wet path)
```

**Parameters:**
- `context` — `AudioContext` to create nodes in

**Returns:**
```js
{
  input,       // AudioNode — connect source here
  output,      // AudioNode — connect to gain/destination here
  setStrength, // (strength: number) => void
  bypass,      // () => void
  getStatus,   // () => { strength, bypassed, gainReduction }
  dispose,     // () => void
}
```

### `setStrength(strength)`

Sets compression strength 0–100.

- `0` = bypass (unity dry, no compression)
- `35` = Light preset
- `70` = Strong preset
- `100` = maximum compression

**Validation:**
- Non-number types → rejected (no change)
- `NaN`, `±Infinity` → rejected
- Out-of-range → clamped to [0, 100]

**Behavior:**
- At strength 0: compressor neutral (threshold=0, ratio=1), dryGain=1, wetGain=0
- At strength 100: full base parameters, dryGain=0, wetGain=1
- Intermediate: linear interpolation of dry/wet mix and compressor params
- Uses `setTargetAtTime` with 20ms ramp for click-free transitions

### `bypass()`

Resets to strength 0 (unity dry route). Same as `setStrength(0)`.

### `getStatus()`

```js
{
  strength,      // number — current strength 0-100
  bypassed,      // boolean — true if strength === 0
  gainReduction, // number — compressor.reduction in dB (0 or negative)
}
```

### `dispose()`

Disconnects all created nodes. Safe to call multiple times. Throws if called after dispose.

### Output protection: `createOutputProtection(context)`

```js
const protection = VC_NIGHT_MODE.createOutputProtection(audioContext);
```

Best-effort peak protection stage. Place AFTER user volume gain in the chain.

**NOT a true-peak brickwall limiter** — clearly best effort, no clipping guarantee.

**Topology:**
```
input -> compressor -> outGain -> output
```

- Compressor: threshold=-6, ratio=12, knee=0, attack=0.003, release=0.1
- Output gain: 0.9 (conservative headroom)

**Returns:**
```js {
  input, output, dispose
}
```

## Volume worker integration

Volume worker creates `MediaElementAudioSource` once and connects:

```js
source.connect(helper.input);
helper.output.connect(existingGainNode);
existingGainNode.connect(protection.input);  // optional
protection.output.connect(destination);
```

Parent may add final peak protection after `helper.output` via `createOutputProtection`.

## Design notes

1. **No automatic makeup gain** — enabling compression doesn't unexpectedly blast volume.
2. **Unity defaults** — bypass = strength 0 = transparent dry route.
3. **No doubled volume** — dry/wet mix sums to 1.0 at all strengths.
4. **Click-free** — short gain ramps (20ms) on dry/wet transitions.
5. **Bounded** — all inputs validated, no NaN/Infinity allowed.
6. **No API/network/storage** — pure audio graph helper.
7. **No collecting audio** — no analysis of audio content.
8. **Independent volume cap** — helper doesn't stack boosts with user gain.
9. **Honest reporting** — no real Jellyfin/Netflix tuning yet; candidate parameters only.

## Test results

```
✔ 17 night-mode unit tests passing
✔ 5 night-mode browser tests passing
```

Run unit tests: `node --test extensions/media-tamer/tests/night-mode.test.js`
Run browser tests: `node /path/to/run-night-mode-browser-tests.js` (Playwright + Chromium)
