# Media Tamer — Firefox Compatibility Report

## Environment
- Firefox 155.0 (Playwright firefox-1543)
- Selenium WebDriver 4.49.0 with geckodriver 0.37.1
- Test repo: `media-tamer`
- Addon: `media-tamer@example.invalid` v1.1.5

## Tests Performed

### 1. YouTube Live Site (Real Addon Install)
- **Result:** PASS
- Installed temporary addon via Selenium on local HTTP, navigated to YouTube public video
- Content script active: number-key '5' did NOT seek video (verified: time unchanged after press)
- No addon console errors
- Page action available on http/https URLs (show_matches)

### 2. Theme API (parseCSSColor + isDarkTheme)
- **Result:** PASS
- `parseCSSColor`: rgb(), #hex, #hex3, named colors (white/black/transparent), unknown returns null
- `isDarkTheme`: luminance-based using toolbar_field > toolbar > ... > frame priority chain
- Falls back to `prefers-color-scheme: dark` when no theme colors available

### 3. Popup Dark Mode Rendering
- **Result:** PASS
- Light scheme: --bg=#ffffff, --text=#1a1a1a, --accent=#0060df
- Dark scheme: --bg=#1c1b22, --text=#fbfbfe, --accent=#0df
- `prefers-color-scheme: dark` correctly matches colorScheme: 'dark'
- Popup height compact (371px) in both light and dark

### 4. Context Menu State
- **Result:** PASS
- Root menu "Media Tamer" with submenus (volume/speed/night)
- Volume/speed presets: checkbox type
- Night mode presets: radio type
- Undo seek: disabled by default, enabled when seek history exists
- `onShown` listener updates parent titles with current values and calls `refresh()`
- `onClick` dispatches correct VC_* commands

### 5. Address Bar Icon Path
- **Result:** PASS
- Dark theme → light icon (light strokes on dark background for contrast)
- Light theme → dark icon
- Uses `browser.pageAction.setIcon` (page_action doesn't support theme_icons natively — Bug 1409107)
- `browser.theme.onUpdated` listener reapplies icon to all tabs on theme change
- Applied on tab complete (status === 'complete')

### 6. Manifest Compatibility
- **Result:** PASS
- Permissions: menus, storage, webNavigation, activeTab, theme
- gecko.strict_min_version: 142.0
- page_action.show_matches: http://*/*, https://*/*
- Persistent background (required for pageAction)

## Known Constraints
- **page_action vs browser_action**: Extension uses page_action (Firefox legacy). MV3 migration would require browser_action with `show_matches` via `action` API.
- **theme_icons not supported**: page_action lacks native theme_icons (Firefox Bug 1409107). Manual icon swapping via theme.getCurrent() + pageAction.setIcon() works around this.
- **strict_min_version 142.0**: Requires Firefox 142+ (data_collection_permissions support).
- **Selenium installAddon**: Requires HTTP(S) page context (cannot install on `about:` pages).
- **YouTube**: No login required; addon content script intercepts keydown at document_start.

## Files
- `test/browser/theme-menu-live.test.js` — 13 tests (4 suites). Static-source assertions (suites 4 & 5) do regex matching on `background.js` to verify menu wiring and icon paths. Runtime coverage is provided by the e2e baseline and extension.test.js. The YouTube live test (suite 1) is network-dependent: if the video is unreachable or duration ≤ 10s, the seek-guard assertion is skipped (not failed).
