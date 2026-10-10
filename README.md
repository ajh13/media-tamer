# Media Tamer — Firefox Extension

A combined Firefox extension (page-action popup + tab-context presets) that blocks accidental number-key seeks and adds playback controls:

| Feature | Range | Reset |
|---------|-------|-------|
| **Number-key seek block** | 0–9 unmodified keys intercepted; normal text entry preserved | ON/OFF toggle in Settings |
| **Volume boost** | 0–300% relative to the player's starting volume | 100% |
| **Playback speed** | 0.25–3× | 1× |
| **Night mode** | Dynamic-range compression (not dialogue isolation) | Off |
| **Seek undo** | Configurable shortcut (default `Ctrl+Z`) | — |

Optional **Media Roller** lets you send the current tab URL to a self-hosted server and start a native Firefox download (opt-in only; see below).

> **Status:** experimental prototype. An unsigned ZIP can be built locally, and the repository includes a tag-triggered GitHub Actions workflow for Mozilla Add-ons signing/submission once AMO API secrets are configured. Core controls, popup layout, Media Roller loopback download, and Firefox E2E paths are covered by automated tests. Not validated against every streaming service.

## Installing

No pre-built release artifact is published. Build the extension, then load it temporarily in Firefox:

1. Install dependencies and build:
   ```bash
   npm ci
   npm run build
   ```
   This produces an unsigned ZIP under `dist/` (e.g. `dist/media_tamer-<version>.zip`).

2. In Firefox 142+, open `about:debugging#/runtime/this-firefox`.

3. Choose **Load Temporary Add-on…** and select the `manifest.json` inside `extensions/media-tamer/`.

4. Reload your video page. Open **Media Tamer** in the address bar (Firefox may group page actions under its menu). Right-click a tab for presets.

Temporary installation is removed when Firefox restarts. Permanent installation requires Mozilla signing. This repo can submit to AMO from GitHub Actions after `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` are configured as repository secrets. See [docs/signing.md](docs/signing.md). **Do not disable signature verification.**

## Requirements

- Firefox **142+** (uses `data_collection_permissions` and `browser.theme`)
- Node.js **24**, npm 12+ (to build / run tests)

## What works — and what doesn't

**Honest limits:**

- **DRM / unsafe cross-origin media** cannot use Web Audio boost or night mode. Native volume reduction may still apply.
- **Web Audio routing is irreversible** for a media element. If a site swaps sources after routing, or playback goes silent, reload the page. Conservative checks are used, but redirect safety cannot be guaranteed.
- **Night mode is compression**, not AI dialogue enhancement and not a guaranteed brickwall limiter. Start at a low listening volume.
- **Seek history** cannot always distinguish your seeks from site-initiated ones. Closed shadow roots and some custom players may not be intercepted.
- **Per-tab volume/speed/night settings** reset on full navigation. Shortcut and Media Roller configuration are stored locally.
- No claim of compatibility with YouTube, Netflix, HBO/Max, Jellyfin, or other DRM-walled services is made.

## Media Roller

An optional, user-controlled remote-download helper. Disabled until you explicitly configure a server.

- Expand the popup's **Media Roller** settings and save your self-hosted server's base URL (`http://` or `https://`, no credentials, no query string, no fragment).
- Saving a URL does **not** initiate a download. Clicking **Download** requests the optional `downloads` permission, then sends the current tab URL to the fixed `/api/download?url=…` endpoint on your server and uses Firefox's download behavior.
- **No cookies, passwords, or authentication tokens** are exported. URLs may contain sensitive query parameters — use only a server you trust.
- The server and your Firefox download history may retain those URLs. Cancelling a browser download may not stop server-side work. DRM downloading is not promised.
- Media Roller's native Firefox download path is verified against a local loopback server. Real self-hosted/server deployments still need user-specific validation.

## Privacy & permissions

- **No telemetry.** No analytics, no beacon, no remote reporting.
- Playback settings stay in memory per tab. Shortcut and Media Roller configuration persist in `storage.local` (not synced). Optional downloads transmit the current tab URL to your chosen server.
- Manifest `permissions`: `menus`, `storage`, `webNavigation`, `activeTab`, `theme`. `downloads` is optional and only requested on an explicit user gesture.
- `data_collection_permissions` declares `required: none`, `optional: browsingActivity` (the latter only used by the opt-in Media Roller download flow).

## Verification & tests

```bash
npm ci              # install from lockfile (never `npm install`)
npm test            # unit tests: Node 24, mocked Firefox/Web Audio APIs
npm run lint        # ESLint (flat config) + extension structural validator
npm run format:check
npm run build       # unsigned .zip in dist/
npm run test:browser    # real Firefox via Playwright (requires Firefox binary)
```

Browser tests verify keyboard interception, typing, iframes, theme-aware popup/menu behavior, Media Roller's native Firefox download path against a loopback server, and real `OfflineAudioContext` compression. Unit tests exercise production classic scripts against mocked APIs.

A separate, **isolated e2e** harness (`test/e2e/`) exercises the anchored-popup path with a pinned Firefox profile. It runs independently (own lockfile, own browsers) and verifies popup → background → content-script behavior on a deterministic media fixture, including the private-PulseAudio night-mode activation path when the private null sink is available. Unit tests are not a substitute for end-to-end validation on real sites.

## Repository maintenance

ESLint, Prettier, structural validation, tests, npm audit, and Dependabot configuration are included. SHA-pinned GitHub Actions CI runs quality → unit tests → browser tests. The Dependabot auto-merge gate runs in dry-run by default and is verified in CI; live scheduled merges require `AUTOMERGE_LIVE=true`. Major updates and GitHub Actions changes require manual review.

## License

Licensed under the [MIT License](LICENSE). See [SECURITY.md](SECURITY.md) for reporting guidance.
