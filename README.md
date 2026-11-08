# Media Tamer — Browser Extension

Block accidental number-key seeks and control playback in Firefox and Chrome. Both browsers use the same popup and playback controls.

| Control | Range / behavior |
| --- | --- |
| Number-key seek block | Intercepts unmodified 0–9 outside text fields; toggle in Settings |
| Volume | 0–300% of the player's starting volume; reset to 100% |
| Speed | 0.25–3×; reset to 1× |
| Night mode | Dynamic-range compression; off by default |
| Seek undo | Configurable shortcut (default `Ctrl+Z`) |

Optional [Media Roller](https://github.com/rroller/media-roller) integration sends the current tab URL to your self-hosted server for download.

## Install

Requires Firefox 142+ or Chrome 148+. To build from source, use Node.js 24 and npm.

```bash
npm ci
npm run build
```

- **Firefox** — Open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and open `extensions/media-tamer/manifest.json`. Find Media Tamer in the address bar or right-click the browser tab for presets. A permanent install requires a Mozilla-signed release.
- **Chrome** — Open `chrome://extensions`, turn on **Developer mode**, select **Load unpacked**, and open `dist/chrome`. Open Media Tamer from the extensions toolbar or right-click a blank area of the page for presets. Chrome's native menu shows preset commands without per-tab checkmarks.

Reload your video page after installing. [GitHub Releases](https://github.com/ajh13/media-tamer/releases) carry both unsigned ZIPs. The Firefox ZIP is `dist/media_tamer-<version>.zip` and the Chrome ZIP is `dist/media_tamer-chrome-<version>.zip`. See [release setup](docs/signing.md) for marketplace distribution.

## Limits

- DRM and unsafe cross-origin media may prevent Web Audio boost or compression; native volume reduction may still work. No compatibility with specific streaming services is promised.
- Web Audio routing cannot be undone for an element. If audio goes silent or a site swaps sources, reload the page. Redirects can also defeat safety checks.
- Night mode compresses dynamics; it does not isolate dialogue or guarantee a brickwall limit. Start at a low volume.
- Seek undo may include site-initiated seeks. Closed shadow roots and custom players may evade number-key blocking.
- Volume, speed, and night mode reset on full navigation; shortcuts and Media Roller configuration persist locally.

## Media Roller

[Media Roller](https://github.com/rroller/media-roller) is a separate, unauthenticated, self-hosted download server intended for a trusted home network. **Do not expose it to public traffic.** Its `/api/download?url=…` endpoint is the integration used here.

In the popup, expand **Media Roller** and save its base URL (`http://` or `https://`, without credentials, query, or fragment). Saving does not download anything. Clicking **Download** requests the optional `downloads` permission, sends the current tab URL to that server, and starts a native browser download.

No browser cookies or saved passwords are sent separately, but the URL itself can contain sensitive parameters or tokens. Use only a server you trust. The server and browser history may retain it; cancelling the browser download may not stop server-side work. DRM downloading is not promised. The download path was tested with a local loopback server, not every self-hosted deployment.

## Privacy & permissions

No telemetry. Playback settings are scoped to the tab and browser session. Shortcuts and Media Roller configuration use local extension storage. HTTP and HTTPS content scripts block number-key seeks and control media across frames. Media Roller sends the active page URL to your configured server only when you click Download and grant the optional permission. Firefox also requests the `browsingActivity` data permission. Media Tamer's use of browsing activity adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including its Limited Use requirements.

## Test

```bash
npm test                 # unit tests
npm run lint             # ESLint and extension validation
npm run format:check
npm run build            # unsigned ZIPs for both browsers
npm run test:browser     # Playwright + Firefox binary
npm run test:chrome      # Playwright Chromium + unpacked Chrome extension
```

Browser tests cover keyboard interception, popup behavior, local Media Roller downloads, and real audio compression. A separate harness in `test/e2e/` tests the anchored popup with a pinned Firefox profile; neither suite proves compatibility with every site.

## License

[MIT](LICENSE). Report security issues via [SECURITY.md](SECURITY.md).
