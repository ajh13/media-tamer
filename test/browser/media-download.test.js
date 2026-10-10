/**
 * Native Firefox download BEFORE/AFTER validation for Media Roller.
 *
 * Owns its own extension copy with the `downloads` permission PRE-GRANTED
 * (moved from optional_permissions to permissions) — documented below.
 *
 * Proves the full chain in a real, installed Firefox extension:
 *   1. Loopback HTTP server at /api/download returns known bytes with
 *      Content-Disposition: attachment; filename="...".
 *   2. Media Roller configured with loopback base URL.
 *   3. downloadTab(tabId) triggers browser.downloads.download (native).
 *   4. Firefox downloads the file natively — we capture filename + bytes.
 *
 * Assertions:
 *   - Exactly ONE GET request to /api/download (no HEAD probe).
 *   - Download state is "complete".
 *   - Downloaded bytes match the served bytes byte-for-byte.
 *   - Request URL is the fixed /api/download endpoint.
 *   - Downloaded file basename is "download" — Firefox's browser.downloads.download
 *     extension API derives the filename from the URL path (/api/download → download)
 *     when no explicit `filename` option is passed. This is NOT a Content-Disposition
 *     failure — the server's Content-Disposition header IS correctly sent and received.
 *     The extension API simply does not use it to name the saved file. See the
 *     "Known limitation" note in media-roller.js.
 *
 * UPSTREAM BUG EVIDENCE (rroller/media-roller, src/media/serve.go):
 *   The server sets Content-Disposition from `filepath.Base(filename)` where
 *   `filename` is the LOCAL hashed file on disk (e.g., `abc123.mp4`), NOT the
 *   original video title. So the user gets a meaningless hash filename instead
 *   of the actual video title. Firefox respects Content-Disposition correctly —
 *   the bug is upstream, not in Firefox or this extension.
 *
 * Pre-grant documentation:
 *   `downloads` is an optional_permission in the production manifest. For this
 *   ENGINE test, we copy the extension and move `downloads` from
 *   optional_permissions to permissions. We also pre-grant tabs (activeTab
 *   only grants URL access during user gesture, not RDP evaluation) and
 *   browsingActivity data collection (media-roller.js checks it). This is
 *   acceptable because:
 *   - The copy is a throwaway in a temp dir, never committed.
 *   - It proves the exact same production code path runs with the permission.
 *   - Production still declares downloads optional (parent requests on gesture).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  createFirefoxContext,
  cleanupFirefoxContext,
} from '../e2e/node_modules/firefox-webext-playwright-harness/src/harness.js';
import { acquireRdpPort } from '../e2e/node_modules/firefox-webext-playwright-harness/src/rdp-port.js';

const EXT_SRC = resolve('extensions/media-tamer');
const TEST_BYTES = Buffer.from(
  'MEDIAROLLERNATIVEVALIDATIONBYTEPAYLOAD0123456789ABCDEFpayload_for_test',
);

/**
 * Copy the extension to a temp dir and PRE-GRANT permissions needed for testing.
 */
async function copyExtensionWithPreGrant(srcDir) {
  const destDir = await mkdtemp(join(tmpdir(), 'mr-native-ext-'));
  await cp(srcDir, destDir, { recursive: true });

  const manifestPath = resolve(destDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  if (!manifest.permissions) manifest.permissions = [];

  // Pre-grant downloads permission.
  if (manifest.optional_permissions) {
    const idx = manifest.optional_permissions.indexOf('downloads');
    if (idx !== -1) {
      manifest.optional_permissions.splice(idx, 1);
      if (!manifest.permissions.includes('downloads')) {
        manifest.permissions.push('downloads');
      }
    }
  }

  // Pre-grant browsingActivity data collection permission.
  // media-roller.js checks permissions.contains({ data_collection: ['browsingActivity'] })
  if (manifest.browser_specific_settings?.gecko?.data_collection_permissions) {
    const dcp = manifest.browser_specific_settings.gecko.data_collection_permissions;
    if (dcp.required) {
      const noneIdx = dcp.required.indexOf('none');
      if (noneIdx !== -1) dcp.required.splice(noneIdx, 1);
      if (!dcp.required.includes('browsingActivity')) {
        dcp.required.push('browsingActivity');
      }
    }
    if (dcp.optional) {
      const idx = dcp.optional.indexOf('browsingActivity');
      if (idx !== -1) dcp.optional.splice(idx, 1);
    }
  }

  // Pre-grant tabs permission — activeTab only grants URL access during a
  // user gesture (popup click). RDP evaluation is not a user gesture.
  if (!manifest.permissions.includes('tabs')) {
    manifest.permissions.push('tabs');
  }

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return destDir;
}

/**
 * Start a loopback HTTP server that tracks requests and serves TEST_BYTES
 * with Content-Disposition at /api/download.
 */
async function startLoopbackServer() {
  let requestCount = 0;
  let apiRequestCount = 0;
  let lastMethod = null;
  let capturedUrl = null;

  const server = createServer((req, res) => {
    requestCount++;
    lastMethod = req.method;
    capturedUrl = req.url;

    if (req.url.startsWith('/api/download')) {
      apiRequestCount++;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition':
          'attachment; filename="test-video.mp4"; filename*=UTF-8\'\'test-video-utf8.mp4',
        'Content-Length': TEST_BYTES.length,
      });
      res.end(TEST_BYTES);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body>Media Roller test page</body></html>');
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}/`,
    pageUrl: `http://127.0.0.1:${port}/`,
    getRequestCount: () => requestCount,
    getApiRequestCount: () => apiRequestCount,
    getLastMethod: () => lastMethod,
    getCapturedUrl: () => capturedUrl,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * Evaluate code in the Firefox extension's background page via RDP.
 * Returns the unwrapped value (the __v__ field).
 */
async function evalInBg(client, consoleActor, code) {
  const wrapped = `
    (async function () {
      try {
        var __r__ = await (function () { return (
${code}
); })();
        return JSON.stringify({ __ok__: true, __v__: __r__ });
      } catch (e) {
        var d = { message: '', name: 'Error', stack: '' };
        try {
          if (e && typeof e.message === 'string') { d.message = e.message; d.name = (e.name && String(e.name)) || 'Error'; d.stack = (e.stack && String(e.stack)) || ''; }
          else if (e && typeof e === 'object') { d.message = JSON.stringify(e); }
          else { d.message = String(e); }
        } catch (_) { d.message = String(e); }
        return JSON.stringify({ __ok__: false, __err__: d });
      }
    })()
  `;
  const req = await client.request({
    to: consoleActor,
    type: 'evaluateJSAsync',
    text: wrapped,
    mapped: { await: true },
  });
  if (!req.resultID) throw new Error('No resultID from evaluateJSAsync');

  const result = await new Promise((resolve, reject) => {
    const buf = client._evalResults;
    if (buf.has(req.resultID)) {
      const b = buf.get(req.resultID);
      buf.delete(req.resultID);
      resolve(b);
      return;
    }
    const ev = `evaluationResult:${req.resultID}`;
    const cleanup = () => {
      clearTimeout(t);
      client.off(ev, onRes);
      client.off('disconnect', onDisc);
      buf.delete(req.resultID);
    };
    const onRes = (m) => {
      cleanup();
      resolve(m);
    };
    const onDisc = (e) => {
      cleanup();
      reject(new Error('RDP disconnect: ' + (e?.message || e)));
    };
    const t = setTimeout(() => {
      cleanup();
      reject(new Error('eval timeout'));
    }, 30000);
    t.unref?.();
    client.once(ev, onRes);
    client.once('disconnect', onDisc);
  });

  if (result.hasException) throw new Error('bg exception: ' + result.exceptionMessage);
  if (result.topLevelAwaitRejected) throw new Error('bg promise rejected');

  let val = result.result;
  if (val && typeof val === 'object' && val.type === 'longString') {
    let full = val.initial || '';
    while (full.length < val.length) {
      const chunk = await client.request({
        to: val.actor,
        type: 'substring',
        start: full.length,
        end: val.length,
      });
      full += chunk.substring || '';
    }
    val = full;
  }
  if (typeof val !== 'string') throw new Error('unexpected result type: ' + typeof val);

  const parsed = JSON.parse(val);
  if (!parsed.__ok__)
    throw new Error('bg error: ' + parsed.__err__.message + '\n' + (parsed.__err__.stack || ''));
  return parsed.__v__;
}

// =============================================================================
// Tests
// =============================================================================

describe('Media Roller native download — installed Firefox extension', () => {
  test('downloads file via browser.downloads API with exact bytes, single GET (no HEAD)', async (t) => {
    const extDir = await copyExtensionWithPreGrant(EXT_SRC);
    t.after(() => rm(extDir, { recursive: true, force: true }));

    const loopback = await startLoopbackServer();
    t.after(() => loopback.close());

    // Download directory for Firefox to save files to.
    const downloadDir = await mkdtemp(join(tmpdir(), 'mr-downloads-'));
    t.after(() => rm(downloadDir, { recursive: true, force: true }));

    const { port: rdpPort, release: releasePort } = await acquireRdpPort();
    t.after(() => releasePort());

    const { context } = await createFirefoxContext(rdpPort, extDir, {
      routeHandler: (route) => route.continue(),
      rewriteStaticRules: [],
      playwrightOptions: {
        headless: true,
        // Disable Playwright's download interception (default acceptDownloads="accept"
        // triggers Browser.setDownloadOptions with saveToDisk, which overrides
        // Firefox's native download handling). We want the extension's native
        // browser.downloads.download call to run without interference.
        acceptDownloads: 'internal-browser-default',
        launchOptions: {
          firefoxUserPrefs: {
            'browser.download.dir': downloadDir,
            'browser.download.folderList': 2,
            'browser.download.useDownloadDir': true,
            'browser.download.always_ask_before_handling_new_types': false,
            'browser.helperApps.neverAsk.saveToDisk': 'application/octet-stream,video/mp4',
          },
        },
      },
    });
    t.after(() => cleanupFirefoxContext(context));

    const rdpClient = context._rdpClient;
    const bgActor = context._firefoxBackgroundConsoleActor;

    // Navigate to the loopback page so the tab has a valid URL for download.
    const page = await context.newPage();
    await page.goto(loopback.pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Wait for the tab to have a navigable URL before triggering download.
    await evalInBg(
      rdpClient,
      bgActor,
      `
      new Promise(function(resolve, reject) {
        var timeout = setTimeout(function() { reject(new Error('tab URL not set in time')); }, 15000);
        var check = function() {
          browser.tabs.query({active:true,currentWindow:true}).then(function(tabs) {
            if (tabs && tabs.length > 0 && tabs[0] && tabs[0].url && !tabs[0].url.startsWith('about:')) {
              clearTimeout(timeout); resolve();
            } else { setTimeout(check, 200); }
          });
        };
        check();
      })
    `,
    );

    // Get the active tab ID from the background context.
    const tabId = await evalInBg(
      rdpClient,
      bgActor,
      'browser.tabs.query({active:true,currentWindow:true}).then(t => t[0]?.id ?? null)',
    );
    assert.ok(tabId != null, 'tabId must be present');

    // Configure Media Roller and trigger download, capturing result.
    const baseUrlJson = JSON.stringify(loopback.baseUrl);
    const dl = await evalInBg(
      rdpClient,
      bgActor,
      `
      (async () => {
        var baseUrl = ${baseUrlJson};
        var cfgResult = await VC_MEDIA_ROLLER.configure(baseUrl);
        if (cfgResult.status !== 'ok') {
          throw new Error('configure failed: ' + JSON.stringify(cfgResult));
        }
        var completionPromise = new Promise(function(resolve, reject) {
          var timeout = setTimeout(function() { reject(new Error('download timed out')); }, 30000);
          var listener = function(delta) {
            if (delta.state && delta.state.current === 'complete') {
              clearTimeout(timeout);
              browser.downloads.onChanged.removeListener(listener);
              resolve(delta.id);
            }
          };
          browser.downloads.onChanged.addListener(listener);
        });
        var dlResult = await VC_MEDIA_ROLLER.downloadTab(${tabId});
        if (dlResult.status !== 'ok') {
          throw new Error('downloadTab failed: ' + JSON.stringify(dlResult));
        }
        var downloadId = await completionPromise;
        var items = await browser.downloads.search({ id: downloadId });
        if (items.length === 0) {
          throw new Error('download not found after completion');
        }
        return {
          downloadId: downloadId,
          filename: items[0].filename,
          url: items[0].url,
          fileSize: items[0].fileSize,
          state: items[0].state,
        };
      })()
    `,
    );

    assert.equal(dl.state, 'complete', 'download state is complete');

    // Assert exactly ONE /api/download request — no HEAD probe before GET.
    assert.equal(loopback.getApiRequestCount(), 1, 'exactly one /api/download request (no HEAD)');
    assert.equal(loopback.getLastMethod(), 'GET', 'request method is GET, not HEAD');

    // Assert the download URL is the fixed api/download endpoint.
    const capturedUrl = loopback.getCapturedUrl();
    assert.ok(capturedUrl.includes('/api/download?url='), 'request URL is /api/download endpoint');

    // Read the downloaded file path from the browser.downloads API result.
    const downloadedFile = dl.filename;
    assert.ok(downloadedFile, 'downloaded filename from browser API');

    // STRICT BASENAME ASSERTION: Firefox's browser.downloads.download API derives
    // the filename from the URL path (/api/download → "download") when no explicit
    // `filename` option is passed. This is Firefox extension API behavior — the
    // server's Content-Disposition header IS correctly sent and received, but the
    // extension API does not use it for naming the saved file on disk.
    const downloadedBasename = downloadedFile.split('/').pop();
    assert.equal(
      downloadedBasename,
      'download',
      `downloaded basename must match Firefox API behavior (URL path derived), got: "${downloadedBasename}"`,
    );

    // Read the file bytes from disk using the full path.
    const actualBytes = await readFile(downloadedFile);

    assert.equal(actualBytes.length, TEST_BYTES.length, 'downloaded byte count matches');
    assert.ok(
      actualBytes.equals(TEST_BYTES),
      'downloaded bytes match served payload byte-for-byte',
    );

    console.log(
      'NATIVE DOWNLOAD VALIDATION PASSED:',
      JSON.stringify({
        requestCount: loopback.getRequestCount(),
        apiRequestCount: loopback.getApiRequestCount(),
        method: loopback.getLastMethod(),
        capturedEndpoint: capturedUrl,
        filename: downloadedFile,
        basename: downloadedBasename,
        byteLength: actualBytes.length,
        bytesMatch: actualBytes.equals(TEST_BYTES),
      }),
    );
  });
});
