#!/usr/bin/env node
/**
 * Scratch harness for native Media Roller download validation.
 *
 * Copies the extension to a temp dir (with downloads pre-granted), starts a
 * loopback server, installs the extension in a real Firefox via the
 * playwright-harness, triggers VC_MEDIA_ROLLER.downloadTab, and asserts:
 *   - Exactly ONE GET request to /api/download (no HEAD probe).
 *   - Download state is "complete".
 *   - Downloaded bytes match served bytes byte-for-byte.
 *   - Request URL is the fixed /api/download endpoint.
 *
 * Inspects production media-roller.js but does NOT patch it. Only the test
 * copy's manifest is modified (downloads, tabs, browsingActivity pre-granted).
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname);
const EXT_SRC = path.join(REPO_ROOT, 'extensions/media-tamer');
const HARNESS_DIR = path.join(REPO_ROOT, 'test', 'e2e', 'node_modules', 'firefox-webext-playwright-harness');

const TEST_BYTES = Buffer.from(
  'MEDIAROLLERNATIVEVALIDATIONBYTEPAYLOAD0123456789ABCDEFpayload_for_test',
);

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyExtensionWithPreGrant(srcDir) {
  const destDir = mkdtemp('mr-native-ext-');
  fs.cpSync(srcDir, destDir, { recursive: true });

  const manifestPath = path.join(destDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (!manifest.permissions) manifest.permissions = [];

  // Pre-grant downloads permission.
  if (manifest.optional_permissions) {
    const idx = manifest.optional_permissions.indexOf('downloads');
    if (idx !== -1) {
      manifest.optional_permissions.splice(idx, 1);
      manifest.permissions.push('downloads');
    }
  }

  // Pre-grant browsingActivity data collection permission.
  if (manifest.browser_specific_settings?.gecko?.data_collection_permissions) {
    const dcp = manifest.browser_specific_settings.gecko.data_collection_permissions;
    if (dcp.required) {
      const noneIdx = dcp.required.indexOf('none');
      if (noneIdx !== -1) dcp.required.splice(noneIdx, 1);
      if (!dcp.required.includes('browsingActivity')) dcp.required.push('browsingActivity');
    }
    if (dcp.optional) {
      const idx = dcp.optional.indexOf('browsingActivity');
      if (idx !== -1) dcp.optional.splice(idx, 1);
    }
  }

  // Pre-grant tabs permission for URL access in RDP context.
  if (!manifest.permissions.includes('tabs')) manifest.permissions.push('tabs');

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return destDir;
}

function startLoopbackServer() {
  let requestCount = 0;
  let apiRequestCount = 0;
  let lastMethod = null;
  let capturedUrl = null;

  const server = http.createServer((req, res) => {
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

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}/`,
        pageUrl: `http://127.0.0.1:${port}/`,
        getRequestCount: () => requestCount,
        getApiRequestCount: () => apiRequestCount,
        getLastMethod: () => lastMethod,
        getCapturedUrl: () => capturedUrl,
      });
    });
  });
}

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
  const req = await client.request({ to: consoleActor, type: 'evaluateJSAsync', text: wrapped, mapped: { await: true } });
  if (!req.resultID) throw new Error('No resultID');
  const result = await new Promise((resolve, reject) => {
    const buf = client._evalResults;
    if (buf.has(req.resultID)) { const b = buf.get(req.resultID); buf.delete(req.resultID); resolve(b); return; }
    const ev = 'evaluationResult:' + req.resultID;
    const cleanup = () => { clearTimeout(t); client.off(ev, onRes); client.off('disconnect', onDisc); buf.delete(req.resultID); };
    const onRes = (m) => { cleanup(); resolve(m); };
    const onDisc = (e) => { cleanup(); reject(new Error('disconnect')); };
    const t = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 30000);
    t.unref?.();
    client.once(ev, onRes);
    client.once('disconnect', onDisc);
  });
  if (result.hasException) throw new Error('exception: ' + result.exceptionMessage);
  if (result.topLevelAwaitRejected) throw new Error('rejected');
  let val = result.result;
  if (val && typeof val === 'object' && val.type === 'longString') { let full = val.initial || ''; while (full.length < val.length) { const chunk = await client.request({ to: val.actor, type: 'substring', start: full.length, end: val.length }); full += chunk.substring || ''; } val = full; }
  if (typeof val !== 'string') throw new Error('unexpected type: ' + typeof val);
  const parsed = JSON.parse(val);
  if (!parsed.__ok__) throw new Error('bg error: ' + (parsed.__err__ && parsed.__err__.message));
  return parsed.__v__;
}

async function main() {
  const { createFirefoxContext, cleanupFirefoxContext } = require(path.join(HARNESS_DIR, 'src', 'harness.js'));
  const { acquireRdpPort } = require(path.join(HARNESS_DIR, 'src', 'rdp-port.js'));

  console.log('Using harness from:', HARNESS_DIR);

  const extDir = copyExtensionWithPreGrant(EXT_SRC);
  console.log('Extension copy (downloads + tabs + browsingActivity pre-granted):', extDir);

  const loopback = await startLoopbackServer();
  console.log('Loopback server at:', loopback.baseUrl);

  const downloadDir = mkdtemp('mr-downloads-');
  console.log('Download dir:', downloadDir);

  const { port: rdpPort, release: releasePort } = await acquireRdpPort();
  console.log('RDP port:', rdpPort);

  let context;
  try {
    ({ context } = await createFirefoxContext(rdpPort, extDir, {
      routeHandler: (route) => route.continue(),
      rewriteStaticRules: [],
      playwrightOptions: {
        headless: true,
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
    }));

    const rdpClient = context._rdpClient;
    const bgActor = context._firefoxBackgroundConsoleActor;

    const page = await context.newPage();
    await page.goto(loopback.pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Wait for tab URL to be set.
    await evalInBg(rdpClient, bgActor, `
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
    `);

    const tabId = await evalInBg(rdpClient, bgActor,
      'browser.tabs.query({active:true,currentWindow:true}).then(t => t[0]?.id ?? null)'
    );
    console.log('Active tab ID:', tabId);

    const baseUrlJson = JSON.stringify(loopback.baseUrl);
    const dl = await evalInBg(rdpClient, bgActor, `
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
    `);

    console.log('Download result:', JSON.stringify(dl));

    // Assertions.
    if (dl.state !== 'complete') throw new Error('FAIL: download state is ' + dl.state + ', expected complete');
    if (loopback.getApiRequestCount() !== 1) throw new Error('FAIL: ' + loopback.getApiRequestCount() + ' API requests, expected 1 (no HEAD)');
    if (loopback.getLastMethod() !== 'GET') throw new Error('FAIL: request method is ' + loopback.getLastMethod() + ', expected GET');
    if (!loopback.getCapturedUrl().includes('/api/download?url=')) throw new Error('FAIL: URL does not include /api/download?url=');

    const downloadedFile = dl.filename;
    if (!downloadedFile) throw new Error('FAIL: no downloaded filename');

    const actualBytes = fs.readFileSync(downloadedFile);

    if (actualBytes.length !== TEST_BYTES.length) throw new Error('FAIL: byte count mismatch (' + actualBytes.length + ' vs ' + TEST_BYTES.length + ')');
    if (!actualBytes.equals(TEST_BYTES)) throw new Error('FAIL: downloaded bytes do not match served payload');

    console.log('\n=== NATIVE DOWNLOAD VALIDATION PASSED ===');
    console.log(JSON.stringify({
      requestCount: loopback.getRequestCount(),
      apiRequestCount: loopback.getApiRequestCount(),
      method: loopback.getLastMethod(),
      capturedEndpoint: loopback.getCapturedUrl(),
      filename: downloadedFile,
      byteLength: actualBytes.length,
      bytesMatch: true,
    }, null, 2));
  } finally {
    if (context) {
      try { await cleanupFirefoxContext(context); } catch {}
    }
    try { await releasePort(); } catch {}
    try { fs.rmSync(extDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch {}
    try { loopback.server.close(); } catch {}
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\n=== FAIL ===');
  console.error(e.message);
  process.exit(1);
});
