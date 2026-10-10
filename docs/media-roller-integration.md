# Media Roller Integration

Optional remote video download via a self-hosted [media-roller](https://github.com/rroller/media-roller) server. This is a **pure helper** loaded as a classic background script before `background.js`. It exposes the `VC_MEDIA_ROLLER` namespace and does **not** register any message listeners, context menus, or permissions requests on its own.

## Architecture

```
manifest.json background.scripts (load order):
  1. media-roller.js   ← this helper (defines VC_MEDIA_ROLLER)
  2. background.js     ← parent (routes popup/menu commands)
```

The parent (`background.js`) is the sole trusted message router. It forwards `VC_MEDIA_ROLLER_DOWNLOAD` commands from the popup/menu to `VC_MEDIA_ROLLER.downloadTab(tabId)`.

## API

### `VC_MEDIA_ROLLER.configure(baseUrl)`

Validates, normalizes, and persists the media-roller server base URL to `browser.storage.local`.

**Validation rules:**
- Must be a non-empty string parseable as a URL
- Protocol must be `http://` or `https://`
- No credentials (`user:pass@host`)
- No query string (`?key=value`)
- No fragment (`#hash`)
- Path prefix is allowed (e.g., `https://host/prefix/`)
- Trailing slash is normalized (always present)

**Returns:** `Promise<{ status, url?, error?, code? }>`

```js
const result = await VC_MEDIA_ROLLER.configure('http://127.0.0.1:8080');
// { status: 'ok', url: 'http://127.0.0.1:8080/' }

const bad = await VC_MEDIA_ROLLER.configure('ftp://host');
// { status: 'error', code: 'bad_scheme', error: '...' }
```

### `VC_MEDIA_ROLLER.getConfig()`

Returns the current configuration state.

**Returns:** `Promise<{ enabled: boolean, baseUrl: string|null }>`

```js
const cfg = await VC_MEDIA_ROLLER.getConfig();
// { enabled: true, baseUrl: 'http://127.0.0.1:8080/' }
```

### `VC_MEDIA_ROLLER.downloadTab(tabId)`

Downloads the current tab's video via the configured media-roller server.

**Preconditions:**
1. Base URL must be configured (else `disabled`)
2. `downloads` permission must be granted (else `permission_required`)
3. No in-flight download for the same tab (else `in_flight`)
4. Tab URL must be valid http/https (else `invalid_url` or `restricted_url`)

**Download behavior:**
- Page URL obtained from `browser.tabs.get(tabId).url` (trusted source, never page messages)
- Fragment trimmed, query string preserved
- Download URL built with `URLSearchParams` to prevent argument injection
- Endpoint is always the fixed `api/download` — no custom yt-dlp options
- `browser.downloads.download({ url, conflictAction: 'uniquify' })` — native progress
- `saveAs` omitted — honors browser default download behavior
- `filename` omitted — server should supply via `Content-Disposition`
- No fetch/blob buffering — browser handles transfer natively

**Returns:** `Promise<{ status, id?, error?, code? }>`

```js
const result = await VC_MEDIA_ROLLER.downloadTab(tabId);
// { status: 'ok', id: 42 }  — download started (not completed)
// { status: 'permission_required', code: 'permission_required', error: '...' }
// { status: 'disabled', code: 'not_configured', error: '...' }
// { status: 'in_flight', code: 'in_flight', error: '...' }
// { status: 'restricted_url', code: 'restricted_scheme', error: '...' }
```

### Status codes

| Status | Meaning |
|--------|---------|
| `ok` | Download started successfully |
| `error` | Generic error (storage, network, tab not found) |
| `disabled` | No base URL configured |
| `permission_required` | `downloads` permission not granted |
| `invalid_url` | Tab URL is not valid http/https |
| `restricted_url` | Tab URL uses restricted scheme (about/file/blob/data/javascript) |
| `in_flight` | Download already in progress for this tab |

## UI Integration

### Download button (popup)

Add a download button to `popup.html`:

```html
<section class="control">
  <div class="control-header">
    <span class="control-label">Download</span>
    <output class="control-value" id="mr-status">—</output>
  </div>
  <button type="button" class="reset-btn" id="mr-download" title="Download this video via Media Roller">
    Download video
  </button>
</section>
```

In `popup.js`, wire the button:

```js
const MR_DOWNLOAD = 'VC_MEDIA_ROLLER_DOWNLOAD';

async function onMrDownload() {
  const resp = await sendCommand({ type: MR_DOWNLOAD, tabId: currentTabId });
  if (resp.status === 'ok') {
    el.mrStatus.textContent = `Downloading (#${resp.id})...`;
  } else if (resp.status === 'permission_required') {
    el.mrStatus.textContent = 'Permission required — click to grant';
    // Parent handles browser.permissions.request() on user gesture
  } else if (resp.status === 'disabled') {
    el.mrStatus.textContent = 'Not configured';
  } else if (resp.status === 'in_flight') {
    el.mrStatus.textContent = 'Already downloading';
  } else {
    el.mrStatus.textContent = `Error: ${resp.error}`;
  }
}
```

### Settings: base URL input

Add a settings section to `popup.html` or a dedicated options page:

```html
<section class="control">
  <div class="control-header">
    <span class="control-label">Media Roller server</span>
  </div>
  <input type="url" id="mr-baseurl" placeholder="http://127.0.0.1:8080" aria-label="Media Roller base URL">
  <button type="button" class="reset-btn" id="mr-save">Save</button>
  <span class="control-status" id="mr-config-status" role="status" aria-live="polite"></span>
</section>
```

In `popup.js`:

```js
async function loadMrConfig() {
  const resp = await VC_MEDIA_ROLLER.getConfig();
  if (resp.baseUrl) el.mrBaseurl.value = resp.baseUrl;
  el.mrConfigStatus.textContent = resp.enabled ? 'Configured' : 'Not configured';
}

async function onMrSave() {
  const result = await VC_MEDIA_ROLLER.configure(el.mrBaseurl.value.trim());
  if (result.status === 'ok') {
    el.mrConfigStatus.textContent = `Saved: ${result.url}`;
  } else {
    el.mrConfigStatus.textContent = `Error: ${result.error}`;
  }
}
```

### Native downloads API (optional)

To show the browser's download UI, the parent can call:

```js
browser.downloads.showDefaultFolder();
// or
browser.downloads.show(downloadId);
```

This is optional and handled by the parent, not this helper.

## Parent message routing

In `background.js`, add a handler for the download command:

```js
case 'VC_MEDIA_ROLLER_DOWNLOAD':
  if (!isPopup(sender)) return;
  return VC_MEDIA_ROLLER.downloadTab(msg.tabId);
```

## Server preparation

The media-roller server must be running and reachable at the configured base URL. The server:

1. Receives `GET /api/download?url=<encoded-page-url>`
2. Runs yt-dlp to download and transcode the video
3. Serves the actual MP4 file with `Content-Disposition: attachment`

**Initial server state:** The helper does NOT probe the server on startup or config save. The first download attempt will reveal if the server is reachable.

## Known limitations

- **Progress:** Native download progress is shown by the browser's download UI. The helper returns the download ID immediately (started, not completed).
- **Cancel:** Cancelling a download via the browser UI stops the local download but may **not** stop the remote yt-dlp process on the server.
- **Native HTTP failures:** If the server returns an error (e.g., unsupported site, yt-dlp failure), the browser will show a failed download. The error details are in the server response.
- **Download history:** Both the server URL and the source page URL appear in the browser's download history. This is native browser behavior.

## Security

- Base URL validated: http/https only, no credentials/query/hash
- Page URL from `browser.tabs.get()` only — never from page messages
- Rejects `about:`, `file:`, `blob:`, `data:`, `javascript:` URLs
- Rejects URLs with credentials
- Uses `URLSearchParams.set('url', pageURL)` to prevent query argument injection
- Endpoint is always the fixed `api/download` — no arbitrary yt-dlp options
- No custom headers, no cookies, no arbitrary backend probes
- Persists only `baseURL` in `storage.local` (not sync)
- No automatic network requests on startup, config save, or browsing
- No telemetry

## Permissions

The `downloads` permission is **optional** and **recommended**. The helper checks for it before downloading and returns `permission_required` if missing. The parent should request it on a user gesture:

```js
// In popup.js, on user click:
const granted = await browser.permissions.request({ permissions: ['downloads'] });
if (granted) { /* retry download */ }
```

Do NOT request permissions without a user gesture — Firefox will deny it.

## Data consent

This helper transmits the **page URL** to the configured media-roller server. It does not collect browsing history or telemetry. The parent manifest should declare appropriate data collection permissions. Since URLs are transmitted to a user-configured server, `data_collection_permissions.required` should NOT be `["none"]` if the parent declares it — consult the [Firefox built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/) documentation.

## Testing

Unit tests use mocked `browser.*` APIs (storage, permissions, tabs, downloads) in a `vm` context:

```bash
node --test extensions/media-tamer/tests/media-roller.test.js
```

Live integration tests with a real loopback mock endpoint and Firefox downloads are the parent's responsibility — no production server is needed for unit tests.
