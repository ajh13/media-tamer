# Firefox Media Tamer Extension — UI & Extension Guidelines

Actionable standards for a cohesive, compact, accessible popup and extension architecture. Sources cited inline; no licensed code copied.

---

## 1. Popup Architecture

### 1.1 HTML/CSS/JS Separation
- **One HTML file**, one CSS file, one classic JS script per popup. No inline `<script>` or `onclick=` attributes.
- CSP forbids inline scripts in MV3 (`script-src` allows only `'self'`, `'none'`, `'wasm-unsafe-eval'`). MV2 allows hashes but they are fragile; avoid.
- Load JS with `<script src="popup.js" defer></script>` (classic script, not `type="module"` — modules in popups work but are unnecessary and complicate MV2 compatibility).

> Source: [MDN — content_security_policy](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy)

### 1.2 Sizing
- Set `min-width`/`max-width` on `<body>`, **not** `:root`. Firefox calculates layout from `<body>` in strict mode.
- Target **320–360px** width. Firefox caps popup at 800×600 and resizes to fit content (max 10×/sec on DOM mutations).
- Avoid forcing height; let content flow. Popups scroll vertically if needed.

> Source: [MDN — Popups](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Popups)

### 1.3 Lifecycle
- Popup document is **loaded fresh each time shown**, unloaded on close. Do not rely on persistent JS state in the popup itself.
- Query `browser.tabs.query({active: true, currentWindow: true})` on load to get the current tab, then request state from background.
- Close popup with `window.close()` if no relevant tab/media found.

---

## 2. Design Tokens & Typography

### 2.1 System Fonts Only
Use no external fonts as a privacy and performance choice; the default extension script CSP is not a blanket remote-font prohibition. Self-hosted woff2 adds unnecessary bundle weight here. Use the system stack:

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
             "Helvetica Neue", Arial, sans-serif;
```

For monospace (numeric values): `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`.

### 2.2 Color Tokens (Light + Dark)
Define via CSS custom properties, toggle via `@media (prefers-color-scheme: dark)` or class on `<html>`:

```css
:root {
  --bg: #ffffff;
  --surface: #f5f5f5;
  --text: #1a1a1a;
  --text-muted: #6b6b6b;
  --accent: #0060df;       /* Firefox Photon blue */
  --accent-hover: #003eaa;
  --border: #e0e0e0;
  --danger: #d72646;
  --ok: #0a8a00;
  --radius: 4px;
  --gap: 8px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1b22;
    --surface: #2b2a33;
    --text: #fbfbfe;
    --text-muted: #a8a8b3;
    --accent: #0df;          /* Photon blue 60 */
    --accent-hover: #00b0ff;
    --border: #52525e;
    --danger: #ff6b81;
    --ok: #7be087;
  }
}
```

Reference: [Mozilla Photon Design System](https://design.firefox.com/photon/) (colors, spacing, typography).

### 2.3 Spacing Scale
Use a compact 4/8px grid:

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--radius-sm: 3px;
--radius-md: 4px;
```

### 2.4 Typography Scale
```css
--font-size-sm: 11px;
--font-size-base: 12px;
--font-size-md: 13px;
--font-size-lg: 14px;
--font-weight-normal: 400;
--font-weight-medium: 500;
--font-weight-semibold: 600;
--line-height: 1.4;
```

Use `font-variant-numeric: tabular-nums` on numeric outputs so values don't jitter when they change.

---

## 3. Control Layout — Uniform Row Pattern

Every control (Volume, Speed, Night Mode) uses the **same row layout**:

```
[Label          value]   ← header row, space-between
[      slider        ]   ← full-width slider
[status        reset]   ← footer row, status left, reset right
```

### 3.1 HTML Structure
```html
<section class="control" data-control="volume">
  <div class="control-header">
    <label class="control-label" for="volume-slider">Volume</label>
    <output class="control-value" id="volume-value">100%</output>
  </div>
  <input type="range" class="slider" id="volume-slider"
         min="0" max="300" step="1" value="100"
         aria-label="Volume 0 to 300 percent">
  <div class="control-footer">
    <span class="control-status" id="volume-status">No media</span>
    <button type="button" class="reset-btn" id="volume-reset"
            title="Reset volume to 100%">Reset</button>
  </div>
</section>
```

### 3.2 CSS for Uniform Rows
```css
.control {
  padding: var(--space-3) var(--space-3);
  margin-bottom: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.control-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: var(--space-2);
}

.control-label {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  color: var(--text-muted);
}

.control-value {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}

.control-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: var(--space-2);
  gap: var(--space-2);
}

.control-status {
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

---

## 4. Slider Styling

### 4.1 Cross-Browser Slider
```css
.slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  outline: none;
  cursor: pointer;
}

.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent);
  cursor: pointer;
  border: 2px solid var(--bg);
  box-shadow: 0 1px 3px rgba(0,0,0,0.3);
}

.slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent);
  cursor: pointer;
  border: 2px solid var(--bg);
  box-shadow: 0 1px 3px rgba(0,0,0,0.3);
}

.slider:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

### 4.2 Keyboard & Focus
- Sliders are natively keyboard-accessible (Arrow keys, Home/End, Page Up/Down).
- **Never** remove the focus ring. If styling, use `:focus-visible` with a visible outline matching `--accent`.
- Tab order follows DOM order. Place controls in logical sequence.

---

## 5. Status Messaging — Honest States

### 5.1 State Vocabulary
Use consistent, honest language. Never show a value as applied when it wasn't:

| State | Status Text | Meaning |
|-------|-------------|---------|
| No media | `No media` | No `<video>`/`<audio>` in tab |
| Applied | `Applied: 150%` | Value confirmed on element |
| Gain fallback | `Applied: 150% (gain)` | Used AudioContext gain (volume > 100%) |
| Unavailable | `Unavailable (DRM/cross-origin)` | Cannot access media element |
| Site muted | `Unavailable (site muted)` | Tab muted at browser level |
| Mixed | `Mixed media (2 unavailable)` | Multiple elements, some unreachable |
| Error | `Error: <message>` | Operation failed |

### 5.2 Status Color Coding
Use `data-status` attribute, not class switching:

```css
.control-status[data-status="ok"] { color: var(--ok); }
.control-status[data-status="error"] { color: var(--danger); }
.control-status[data-status="unsupported"] { color: var(--text-muted); font-style: italic; }
```

### 5.3 Requested vs Actual
When the site clamps a value (e.g., speed limited to 2x by player), show:
- **Value display**: requested value (what user set)
- **Status**: `Applied: 2.00x (clamped)` — honest about what actually took effect

---

## 6. Reset Buttons

### 6.1 Behavior
- Reset sets the control to its **default** value (Volume: 100%, Speed: 1.00x, Night: Off/0).
- Reset sends the same message as sliding to that value.
- Reset button is a **secondary** control — small, outlined, not prominent.

### 6.2 Styling
```css
.reset-btn {
  background: transparent;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  padding: 2px 10px;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  flex-shrink: 0;
}

.reset-btn:hover {
  background: var(--accent);
  color: var(--bg);
}

.reset-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

---

## 7. Page Action (Address Bar Icon)

### 7.1 Manifest
```json
"page_action": {
  "default_popup": "popup.html",
  "default_icon": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png"
  },
  "default_title": "Media Tamer",
  "show_matches": ["http://*/*", "https://*/*"]
}
```

- Page action is **hidden by default**; use `pageAction.show(tabId)` when media is detected.
- `show_matches` in manifest auto-shows on matching URLs (Firefox 78+).
- Use SVG icons with `prefers-color-scheme` media query for light/dark adaptation.

> Source: [MDN — Page_actions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Page_actions)

### 7.2 Icon Visibility
- Show page action only on tabs where the extension is relevant (pages with media).
- Use `pageAction.onClicked` only if no popup; with popup, click opens popup automatically.
- Update `pageAction.setTitle({tabId, title: "Media Tamer — 150%"})` to reflect state in tooltip.

### 7.3 SVG Icon Theming
```html
<svg ...>
  <style>
    @media (prefers-color-scheme: dark) {
      .icon-fill { fill: #fbfbfe; }
    }
  </style>
  ...
</svg>
```

Firefox applies an implicit CSS filter to SVG icons in dark themes (deactivating in Firefox 152). Test with `extensions.webextensions.pageActionIconDarkModeFilter.enabled = false` in about:config.

---

## 8. Context Menu (Right-Click Tab)

### 8.1 menus.onShown for Current Values
Use `menus.onShown` to update menu items with the current tab's state **before** the menu renders:

```js
browser.menus.onShown.addListener(async (info, tab) => {
  if (!tab) return;
  const state = await getTabState(tab.id);
  // Update titles to show current values
  browser.menus.update('vg-volume', { title: `Volume: ${state.volume}%` });
  browser.menus.update('vg-speed', { title: `Speed: ${state.speed}x` });
  browser.menus.refresh();
});
```

> Source: [MDN — menus.onShown](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/menus/onShown)

### 8.2 Menu Structure
- Parent items: "Video volume", "Video speed", "Night mode"
- Children: presets as `checkbox` type, checked = current value
- Use `menus.ContextType.TAB` for tab right-click menu
- `info.tabId` in onClicked gives the right-clicked tab

### 8.3 Preset Checked State
Update checked state in `onShown` via `menus.update(id, {checked: true/false})` then `menus.refresh()`.

---

## 9. Storage & Privacy

### 9.1 No Data Collection Declaration
For AMO submission (required for new extensions from Nov 3, 2025):

```json
"browser_specific_settings": {
  "gecko": {
    "id": "media-tamer@example.invalid",
    "strict_min_version": "140.0",
    "data_collection_permissions": {
      "required": ["none"]
    }
  }
}
```

- `"none"` = no data collection/transmission. Shows "This extension does not collect any data" at install.
- If no data is collected, **do not** use `storage.local` for anything that persists across sessions. In-memory per-tab state only.

> Source: [Extension Workshop — Firefox built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)

### 9.2 Storage API
- If using `storage.local` for user preferences (not telemetry), declare `storage` permission.
- Do not store browsing history, URLs, or media content.
- Per-tab state should be in-memory (`Map<tabId, state>`) in background script, cleaned up on tab close/navigation.

### 9.3 Feature Detection for Data Consent
```js
const perms = await browser.permissions.getAll();
if (!perms.data_collection) {
  // Firefox < 140 — built-in consent unavailable
  // Set strict_min_version: "140.0" to avoid this path
}
```

---

## 10. Manifest Constraints

### 10.1 MV2 vs MV3
- This project uses **MV2 with a persistent background page** to retain session-only per-tab settings. This is a project choice, not a Mozilla recommendation for all personal add-ons.
- Do not treat Chrome MV3 service-worker configuration as a drop-in Firefox manifest. Firefox uses background scripts/event pages; verify current [MDN background compatibility](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background) before any migration.
- Current manifest: `"manifest_version": 2`, `"background": {"scripts": ["background.js"], "persistent": true}`.

### 10.2 CSP (Default is Sufficient)
Default CSP for MV2:
```
script-src 'self'; object-src 'self';
```
- No `unsafe-inline`, no `unsafe-eval`, no remote scripts.
- Do not override unless absolutely necessary. If you must, keep it tight.

### 10.3 Permissions
- Minimal permissions. `menus` for context menu, `storage` only if persisting preferences.
- No `<all_urls>` needed — content_scripts with `matches` handles page access.
- `host_permissions` for optional host access.

---

## 11. AMO Signing & Distribution

### 11.1 Unlisted Signing
- Private repo, unlisted distribution: use `web-ext sign` or AMO Developer Hub "On your own" channel.
- Unlisted extensions are **not** publicly listed on AMO but are signed and installable via direct `.xpi` link.
- All submissions undergo automated validation; manual review can occur at any time.

> Source: [Extension Workshop — Signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)

### 11.2 CAPTCHA Blocking
- AMO's CAPTCHA can block automated signing via `web-ext sign`.
- Workaround: upload manually via AMO Developer Hub web UI, or use AMO API with API keys.
- For CI/CD: use `web-ext sign` with `AMO_API_KEY` + `AMO_API_SECRET`; handle CAPTCHA failures gracefully.

### 11.3 Source Code Submission
- If the build is minified/bundled, AMO requires source code submission.
- For simple extensions (no bundler), the uploaded ZIP is sufficient.

---

## 12. Disabled & Unsupported States

### 12.1 Control Disabled State
When no media is present or media is inaccessible:

```css
.control[data-disabled="true"] .slider {
  opacity: 0.5;
  pointer-events: none;
}

.control[data-disabled="true"] .reset-btn {
  opacity: 0.5;
  pointer-events: none;
}
```

- Set `aria-disabled="true"` on the slider.
- Status text explains *why* (not just "disabled"): `No media`, `Unavailable (DRM)`.

### 12.2 Unsupported vs Unavailable
- **Unsupported**: Feature not possible on this page (no media element, cross-origin iframe).
- **Unavailable**: Feature blocked by site/DRM/browser (muted tab, clamped speed).
- Use distinct status messages for each so users understand the difference.

---

## 13. Keyboard & Accessibility

### 13.1 Focus Management
- All interactive elements (sliders, reset buttons) must be reachable via Tab.
- Visible focus ring on all interactive elements (`:focus-visible`).
- Do not trap focus in popup; allow natural tab order.

### 13.2 ARIA
- Sliders: `aria-label` describing range and current value.
- Outputs: `<output>` element linked to slider via `for` attribute.
- Status: `role="status"` or `aria-live="polite"` for dynamic status updates.

### 13.3 Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  .slider::-webkit-slider-thumb { transition: none; }
  .reset-btn { transition: none; }
}
```

---

## 14. Naming Standardization

### 14.1 Control Names
Use consistent, concise labels:

| Control | Label | Value Format | Default | Reset Label |
|---------|-------|--------------|---------|-------------|
| Volume | `Volume` | `150%` | `100%` | `Reset` |
| Speed | `Speed` | `1.50x` | `1.00x` | `Reset` |
| Night Mode | `Night mode` | `Off` / `35` | `Off` | `Reset` |

### 14.2 Message Types
Prefix with `VC_` (Media Tamer):
- `VC_VOLUME_SET`, `VC_VOLUME_GET`, `VC_VOLUME_STATUS`
- `VC_SPEED_SET`, `VC_SPEED_GET`, `VC_SPEED_STATUS`
- `VC_NIGHT_SET`, `VC_NIGHT_GET`, `VC_NIGHT_STATUS`

### 14.3 Status Object Shape
```js
{
  ok: boolean,
  applied: number,      // actual value applied
  requested: number,    // what was requested
  method: "direct" | "gain" | "unsupported",
  muted: boolean,
  clamp: boolean,       // true if site clamped the value
  error: string | undefined
}
```

---

## 15. Quick Reference — Mandatory Constraints

| Constraint | Source | Action |
|------------|--------|--------|
| No inline scripts | CSP default | External JS files only |
| No `eval()` / `new Function()` | CSP default | Use JSON.parse, structured data |
| No remote scripts | CSP default | Bundle everything locally |
| `script-src 'self'` minimum | CSP | Don't loosen unless required |
| Page action hidden by default | MDN | Call `pageAction.show()` on media detect |
| `browser_style` deprecated in MV3 | MDN | Set `false` or omit; provide own styles |
| Data consent required (new extensions) | Extension Workshop | Declare `data_collection_permissions` |
| All extensions must be signed | Extension Workshop | Use `web-ext sign` or AMO Hub |
| No external fonts without CSP allowance | CSP | Use system fonts |
| Popup max 800×600 | MDN | Design for 320–360px width |
| `menus.refresh()` after `menus.update()` | MDN | Always call in `onShown` handler |

---

## 16. Reference URLs

- [Firefox Extension Workshop — UX Best Practices](https://extensionworkshop.com/documentation/develop/user-experience-best-practices/)
- [MDN — Popups](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Popups)
- [MDN — Page_actions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Page_actions)
- [MDN — content_security_policy](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy)
- [MDN — Browser styles](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Browser_styles)
- [MDN — menus.onShown](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/menus/onShown)
- [Extension Workshop — Firefox built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
- [Extension Workshop — Signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
- [Mozilla Photon Design System](https://design.firefox.com/photon/)
- [Global Speed (polywock/globalSpeed)](https://github.com/polywock/globalSpeed) — reference for slider + preset UI patterns
- [uBlock Origin (gorhill/uBlock)](https://github.com/gorhill/uBlock) — reference for CSS variable design system
