# Media Tamer — Firefox Extension

Block accidental number-key seeks and control playback from an address-bar popup or tab menu.

| Control | Range / behavior |
| --- | --- |
| Number-key seek block | Intercepts unmodified 0–9 outside text fields; toggle in Settings |
| Volume | 0–300% of the player's starting volume; reset to 100% |
| Speed | 0.25–3×; reset to 1× |
| Night mode | Dynamic-range compression; off by default |
| Seek undo | Configurable shortcut (default `Ctrl+Z`) |

Optional [Media Roller](https://github.com/rroller/media-roller) integration sends the current tab URL to your self-hosted server for download.

> **Experimental:** No pre-built release is published. Automated tests cover the controls and local download path, but not every streaming service.

## Install

Requires Firefox 142+, Node.js 24, and npm 12+.

```bash
npm ci
npm run build
```

The build creates an unsigned ZIP at `dist/media_tamer-<version>.zip`. To try it, open `about:debugging#/runtime/this-firefox` in Firefox and load `extensions/media-tamer/manifest.json` as a **Temporary Add-on**. Reload your video page, then open Media Tamer in the address bar or right-click the tab for presets.

Temporary add-ons disappear when Firefox restarts. Permanent installation requires Mozilla signing; see [signing instructions](docs/signing.md). **Do not disable signature verification.**

## Limits

- DRM and unsafe cross-origin media may prevent Web Audio boost or compression; native volume reduction may still work. No compatibility with specific streaming services is promised.
- Web Audio routing cannot be undone for an element. If audio goes silent or a site swaps sources, reload the page. Redirects can also defeat safety checks.
- Night mode compresses dynamics; it does not isolate dialogue or guarantee a brickwall limit. Start at a low volume.
- Seek undo may include site-initiated seeks. Closed shadow roots and custom players may evade number-key blocking.
- Volume, speed, and night mode reset on full navigation; shortcuts and Media Roller configuration persist locally.

## Media Roller

[Media Roller](https://github.com/rroller/media-roller) is a separate, unauthenticated, self-hosted download server intended for a trusted home network. **Do not expose it to public traffic.** Its `/api/download?url=…` endpoint is the integration used here.

In the popup, expand **Media Roller** and save its base URL (`http://` or `https://`, without credentials, query, or fragment). Saving does not download anything. Clicking **Download** requests Firefox's optional `downloads` permission, sends the current tab URL to that server, and starts a native Firefox download.

No browser cookies or saved passwords are sent separately, but the URL itself can contain sensitive parameters or tokens. Use only a server you trust. The server and Firefox history may retain it; cancelling the browser download may not stop server-side work. DRM downloading is not promised. The download path was tested with a local loopback server, not every self-hosted deployment.

## Privacy & permissions

No telemetry. Per-tab playback settings stay in memory; shortcuts and Media Roller settings use `storage.local` (not sync). The manifest uses `menus`, `storage`, `webNavigation`, `activeTab`, and `theme`; `downloads` is requested only when you click Download. `data_collection_permissions` declares no required collection and optional `browsingActivity` for that opt-in flow.

## Test

```bash
npm test                 # unit tests
npm run lint             # ESLint and extension validation
npm run format:check
npm run build            # unsigned ZIP
npm run test:browser     # Playwright + Firefox binary
```

Browser tests cover keyboard interception, popup behavior, local Media Roller downloads, and real audio compression. A separate harness in `test/e2e/` tests the anchored popup with a pinned Firefox profile; neither suite proves compatibility with every site.

## License

[MIT](LICENSE). Report security issues via [SECURITY.md](SECURITY.md).
