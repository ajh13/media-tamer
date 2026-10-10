# Media Tamer Extension — Design System

Compact 320px popup with hidden drag-surface sliders. Implements Firefox page_action popup standards.

---

## Popup Dimensions

- **Width**: 320px (body fixed)
- **Padding**: 5px all around
- **Row gap**: 4px between rows
- **Max height**: 580px with overflow-y auto

## Control Layout (Hidden Slider Pattern)

Each control is a single 44px row: `[− button] [surface field] [+ button]`

```
┌──────────────────────────────────────────┐
│  [−]  Volume ················· 100%  [+] │
│  [−]  Reduce volume peaks ···· Off   [+] │
│  [−]  Speed ·················· 1.00x [+] │
├──────────────────────────────────────────┤
│  [↶ Undo seek]      [↓ Download]         │
├──────────────────────────────────────────┤
│  [Reset all]        [Settings]           │
└──────────────────────────────────────────┘
```

### Surface Field

- 44px height, full-width draggable surface
- Hidden native `<input type="range">` overlay for accessibility
- Always-visible thin vertical position tick line (2px accent color)
- Fill bar revealed on hover/focus
- Drag anywhere on field to adjust value
- Keyboard: arrows step, Shift = 10x, Home/End = min/max
- 44px minus/plus flanking buttons for precise steps

### Control Ranges

| Control | Min | Max | Step | Default | Display |
|---------|-----|-----|------|---------|---------|
| Volume | 0 | 300 | 1 | 100 | "100%" |
| Peaks | 0 | 100 | 1 | 0 | "Off" or "35%" |
| Speed | 0.25 | 3 | 0.05 | 1 | "1.00x" |

## Color Themes

### Light Mode (default)
```css
--bg: #f8f9fb;
--fg: #20252e;
--line: #cbd1da;
--button: #e9edf3;
--fill: #c4d9f7;
--accent: #185dbd;
```

### Dark Mode
```css
--bg: #20242b;
--fg: #f0f3f8;
--line: #49515f;
--button: #303743;
--fill: #334d70;
--accent: #8abcff;
```

### Appearance Settings
- **System** (default): follows `prefers-color-scheme` via `@media`
- **Light/Dark**: overrides via `html[data-theme]` attribute
- Persisted in `browser.storage.local` as `{ appearance: "system"|"light"|"dark" }

## Typography

```css
font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
```

- Label: 12px muted
- Value: 19px bold tabular-nums
- Step buttons: 24px icon
- Bottom buttons: 12px

## Actions Row

- Undo seek + Download buttons, 44px height
- Disabled when no media tab

## Reset All

- Resets volume=100, peaks=0, speed=1 for current tab only
- Sends atomic VC_RESET_ALL to background
- Cancels any pending audio activation safely
- Does NOT affect: seek binding, Media Roller config, appearance setting

## Settings Panel

- Collapsible via Settings toggle button
- Appearance select: System / Light / Dark
- Seek shortcut display with Change button
- Media Roller server URL config (collapsed)

## Accessibility

- All controls keyboard reachable
- Native range inputs accessible via overlay technique
- `aria-label` on all inputs and buttons
- `aria-expanded` on collapsible sections
- `aria-live="polite"` on status updates
- `prefers-reduced-motion` respected
- Focus-visible outlines on all interactive elements
- 44px minimum touch targets

## Night Mode Label

- User-facing label: "Reduce volume peaks" (popup + context menu)
- Internal protocol: VC_NIGHT_SET / VC_NIGHT_GET unchanged
- Display: 0 = "Off", 1-100 = "35%" (precise percentage)

## File Structure

```
extensions/media-tamer/
├── popup.html       ← compact structure
├── popup.css        ← tokens + component styles
├── popup.js         ← classic script, no modules
├── background.js    ← routing, reset-all handler
├── volume.js        ← content: volume + night mode
├── speed.js         ← content: playback rate
├── night-mode.js    ← content: audio compression
├── seek-undo.js     ← content: seek history
├── media-roller.js  ← background: download server
└── content.js       ← number-key guard
```

No inline scripts. No external fonts. No remote resources.
