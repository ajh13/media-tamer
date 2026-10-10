# E2E Baseline Regression Test — Media Tamer Anchored Popup

Durable, reproducible end-to-end test tooling for the Media Tamer
`anchored-popup` path. Proves the full chain:

> toolbar click → popup DOM → preset handlers → background RDP →
> content script → actual media element state.

No root package.json, workflow, or parent file edits. This test workspace
owns its own pinned dependencies, browser path, and Xvfb display.

## Quick Start

```bash
cd test/e2e

# 1. Install pinned dependencies (separate lockfile, no root edits)
npm install

# 2. Generate the deterministic media fixture
npm run gen:media

# 3. Run the baseline (single)
npm run test

# 4. Run twice (reproducibility check)
npm run test:twice
# or directly:
./scripts/run-baseline-twice.sh
```

## What It Tests

| Test | Assertion | Hard Fail On |
|------|-----------|-------------|
| `media_ready` | `readyState >= 2` AND `duration > 0` | Null, non-finite, media not loaded |
| `speed_0_5` | `playbackRate === 0.5` (popup click → background → content script → DOM) | Null, non-finite, mismatch |
| `volume_50` | `el.volume === 0.5` (direct mode, popup click chain) | Null, non-finite, mismatch |
| `volume_reset` | `el.volume === 1` (reset button) | Null, non-finite, mismatch |
| `seek_undo` | `currentTime` restored after undo (media must be ≥5s) | Position not restored |
| `new_tab` | Second tab has independent `tabId`, `playbackRate` is isolated | Same tabId, cross-contamination |
| `theme_api` | `browser.theme.update()` sets dark frame, `getCurrent()` reads back `#1a1a2e` | Color mismatch or API failure |

### Click mechanism & `event.isTrusted`

The toolbar click is delivered via `xclick.py`, which uses X11's `XTestFakeButtonEvent`.
From the browser's perspective these are **synthetic** events: `event.isTrusted === false`.
The toolbar click listener in `popup.js` fires regardless (it does not gate on `isTrusted`),
so popup-open, preset dispatch, and all downstream assertions work as documented.

This runner does **not** claim `isTrusted` user activation — that is structurally impossible
under XTest. Any page, permission prompt, or API that requires a trusted user gesture
(e.g. `permissions.request`, `MediaStream`, fullscreen) must use keyboard input or a
real input device in CI. If a future test needs `isTrusted`, run it under `libxte`/
`xdotool` (still untrusted) or a USB input feeder (expensive). We assert on observable
side-effects (DOM state, RDP response), not on the click's trust level.

## Architecture

### Pinned Harness

The runner uses `firefox-webext-playwright-harness@0.3.0`, sourced from the
upstream Apache-2.0 release at commit `c62031e0675a79ab762ecd658c67f5fe3b304b02`
(`duckduckgo/firefox-webext-playwright-harness` on GitHub, main branch, July 2026).
The package is **not published to npm**; we vendor it as a portable tarball at
`test/e2e/scripts/firefox-webext-playwright-harness-0.3.0.tgz`. The tarball
contains real files (no symlinks, no local-absolute paths) plus `LICENSE.md` and
`README.md`. It is installed via `file:./scripts/firefox-webext-playwright-harness-0.3.0.tgz`
in `test/e2e/package.json`. No shared state with the root workspace.

If the harness is upstream-modified, rebuild the tarball from the pinned commit
with `tar czf` from a clean checkout — never edit the harness in place.

### Isolated Browser Cache

The harness is configured to use `PLAYWRIGHT_BROWSERS_PATH` set under
`test/e2e/.env-e2e` — browsers install once into this directory and are
never touched by other projects.

### Deterministic Xvfb

- Dynamically selects a free display in `:99-:199`
- Checks BOTH lock file AND socket before claiming — never deletes another
  display's lock or socket
- Launched detached; polled for readiness without `xdpyinfo`
- Killed in `finally` block via `process.kill(-pid)` (process group) and
  `SIGKILL` fallback

### Extension Integrity

Each run copies the extension from `extensions/media-tamer/` into a
test-local `.ext-copy/` directory. All source files are SHA-256 hashed
before copy; the copy is re-hashed and verified. No stale scratch copies
are ever used.

### Media Fixture

A deterministic 10-second MP4 is generated via `ffmpeg` with:

```
testsrc (visual) + sine 440Hz (audio)
640x360, 15fps, yuv420p, AAC 64k
```

The fixture is reproducible from the generator script. SHA-256 recorded in
`media-test.provenance.json`. Fixture is served over HTTP each run with
`Accept-Ranges: bytes` support.

## Directory Layout

```
test/e2e/
├── package.json              # Pinned harness + deps, own lockfile
├── package-lock.json         # Isolated lock (never shared with root)
├── scripts/
│   ├── baseline-runner.js    # Main RDP-driven regression runner
│   ├── gen-media-fixture.js  # Deterministic MP4 generator
│   ├── run-baseline-twice.sh # Run twice for reproducibility
│   └── xclick.py             # X11 click via XTest
├── node_modules/
│   └── .cache/
│       ├── media-test.mp4    # Generated fixture (gitignored)
│       └── media-test.provenance.json
├── baseline-result.json      # Latest run result (gitignored)
└── .ext-copy/                # Temporary ext copy per run (gitignored)
```

## Exit Codes

- `0` — All assertions passed
- `1` — Any assertion failed, popup open failed, or test error/timeout

## Integration Notes

This workspace is self-contained. The parent repo's `package.json` and CI
workflows are NOT modified. To add this runner to CI, add a job that:

1. `cd test/e2e && npm ci`
2. `npm run gen:media`
3. `npm run test:twice`
4. Verify exit code 0

The runner requires:
- `Xvfb` (system package)
- `python3` with X11/XTest libs
- `ffmpeg` (for fixture generation)
- Playwright's bundled Firefox (installed via `npx playwright install firefox`)
