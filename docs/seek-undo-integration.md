# Seek Undo Integration

## Component

`extensions/media-tamer/seek-undo.js` — content-script component that records video seeks and restores them on a configurable keybind (default `Ctrl+Z`).

Owned files:
- `extensions/media-tamer/seek-undo.js` — content component (this doc)
- `test/unit/seek-undo.test.js` — 49 unit tests (JSDOM)
- `docs/seek-undo-integration.md` — this file

## Behavior

- **Listens** at window capture for a configurable keybind (default `Ctrl+Z`).
- **Only intercepts** when a valid seek history entry exists AND the page target is non-editable.
- **Never** intercepts in `<input>`, `<textarea>`, `<select>`, `[contenteditable]`, `designMode`, or ARIA textbox/searchbox/combobox/spinbutton roles.
- **Never** intercepts during IME composition.
- **Default Ctrl+Z** when no undo history exists: does nothing, does not `preventDefault`, passes through.
- **Only prevents default on successful undo** — failed/no-op attempts leave the event untouched.
- **No conflict** with the base number blocker (different event types and key filters).

## Seek History

- Per media session, keyed to the active video element.
- Detects `seeking` → `seeked` transitions with a time delta ≥ threshold (default 2s).
- Excludes ordinary playback (`timeupdate` without `seeking`/`seeked`).
- Excludes tiny drift below threshold.
- Excludes initial metadata/start/resume setup (no `seeking` event).
- Clears on `loadstart` and `emptied` (media source/episode change).
- **Undo does not record itself** as a new entry (guarded by `isPerformingUndo` flag).
- LIFO order: most recent seek undone first.

## Active Video Selection

- Tracks the last video that fired `play` or `playing`.
- Only one active/main video target per frame.
- Avoids undoing arbitrary preview/background videos.

## Shadow DOM + Dynamic Insertion

- `MutationObserver` on `documentElement` (childList, subtree) re-scans for videos.
- `scanForVideo` traverses open shadow roots.
- `attachToAllVideos` attaches media listeners to all current videos including shadow DOM.
- Dynamically inserted videos are picked up via the observer.

## Configurable Keybind

Default: `Ctrl+Z` (NOT `Meta+Z` / `Cmd+Z`).

Configurable via `VC_SEEK_CONFIG` message or `configure()` API:

```js
{
  binding: { key: 'z', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
  enabled: true,
  threshold: 2 // seconds (optional)
}
```

## Runtime Protocol

All messages via `window.postMessage`.

### Inbound

| Message | Fields | Description |
|---------|--------|-------------|
| `VC_SEEK_CONFIG` | `binding`, `enabled`, `threshold?` | Configure the component |
| `VC_SEEK_GET_STATE` | — | Request current state |
| `VC_SEEK_UNDO` | — | Trigger undo programmatically |

### Outbound

| Message | Fields | Description |
|---------|--------|-------------|
| `VC_SEEK_STATE` | `binding`, `enabled`, `historyCount`, `threshold` | Current state |
| `VC_SEEK_UNDO_RESULT` | `success`, `restoredFrom?`, `restoredTo?` | Undo result |

## API (programmatic)

```js
const seekUndo = createSeekUndo(window, document);
seekUndo.init();
seekUndo.configure({ binding: {...}, enabled: true });
seekUndo.getState(); // { binding, enabled, historyCount, threshold }
seekUndo.undo();     // { success, restoredFrom, restoredTo }
seekUndo.destroy();
```

## Integration Notes

- **Parent handles persistence/UI** — this component does not use `browser.storage`.
- **Volume/speed never persist** — by design.
- **Frame-local** — operates in each frame independently (`all_frames: true` in manifest).
- **No guarantees** absolute discrimination between site-initiated and user-initiated seeks. The component records any `seeking`/`seeked` transition above threshold. Some sites may programmatically seek (e.g., on resume, ad insertion, quality switch). Document this limitation to users.

## Limitations

1. **Site-initiated vs user-initiated**: Cannot distinguish. Programmatic seeks (e.g., "resume where you left off", ad boundaries, quality switches) may be recorded and undoable. This is a known limitation.
2. **Shadow DOM**: `MutationObserver` does not observe internal shadow tree mutations. `scanForVideo` catches shadow host changes but not internal shadow tree edits. Acceptable for v1.
3. **Single active video**: Only the last-played video is tracked. Background/preview videos are ignored.
4. **No cross-frame undo**: Each frame has its own history.
5. **Threshold**: Fixed at 2s (configurable). Seeks below this are ignored to avoid flooding history with tiny adjustments.

## Tests

49 unit tests in `test/unit/seek-undo.test.js` covering:
- Basic seek recording and undo
- Threshold filtering (below/at/above 2s)
- Editable target preservation (input, textarea, select, contenteditable, ARIA roles)
- IME composition and designMode
- Non-matching keys (plain Z, Ctrl+Shift+Z, Meta+Z, digits, other Ctrl combos)
- Configurable shortcuts (Meta+Z, Ctrl+Shift+X, disabled state)
- Source/episode change reset (loadstart, emptied)
- Undo recursion (undo does not record itself)
- LIFO multi-undo
- Active video selection
- State and command API
- Runtime protocol (VC_SEEK_CONFIG, VC_SEEK_UNDO)
- Shadow DOM and dynamic video detection
- Paused/playing state preservation
- Case-insensitive key matching
- No preventDefault on failed undo
- Ordinary playback exclusion
- Init idempotency and destroy cleanup
