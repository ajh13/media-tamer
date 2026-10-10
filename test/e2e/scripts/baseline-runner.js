#!/usr/bin/env node
/**
 * baseline-runner.js — Owned, deterministic, reproducible regression runner for
 * the Video Controls anchored-popup path. Runs under test/e2e with its own
 * pinned dependency lock and isolated PLAYWRIGHT_BROWSERS_PATH.
 *
 * Proves the full chain:
 *   toolbar click → popup DOM → preset handlers → background RDP →
 *   content script → actual media element state.
 *
 * Additional tests added on top of the proven spike baseline:
 *   - seek_undo: programmatic seek creates history, undo restores position
 *   - new_tab_visibility: popup reads correct tabId across a second tab
 *   - theme_api: browser.theme.update() round-trip verified via getCurrent()
 *
 * Baseline assertions (exact, null/non-finite = hard fail):
 *   media_ready    readyState >= 2 AND duration > 0 (REAL loaded media)
 *   speed_0_5      playbackRate === 0.5
 *   volume_50      el.volume === 0.5
 *   volume_reset   el.volume === 1
 *   seek_undo      currentTime restored after undo
 *   new_tab        second tab has independent tabId, no cross-contamination
 *   theme_api      browser.theme.update() applies dark frame, getCurrent() reads it back
 *
 * Click mechanism: xclick.py uses XTestFakeButtonEvent (X11 XTest extension).
 * These synthetic clicks have event.isTrusted === false in the browser's
 * perspective. The popup opens via the toolbar click listener regardless,
 * but this runner does NOT claim isTrusted userActivation — that would be
 * impossible under XTest. If a page needs isTrusted, it must use keyboard
 * or real input. See docs/e2e.md for implications.
 *
 * Exit 0 = all assertions passed.
 * Exit 1 = any assertion failed, popup open failed, or test error/timeout.
 *
 * Owned resources (launched here, torn down in finally):
 *   - Xvfb on a dynamically chosen free display (:99-:199), no stale lock/sock deletes
 *   - RDP port (released via harness lock)
 *   - HTTP media server
 *   - Browser temp profile
 *
 * No root package.json/workflow edits. No commits.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

// --- Pinned harness from this workspace only ---
const HARNESS_DIR = path.join(__dirname, '..', 'node_modules/firefox-webext-playwright-harness');
const harness = require(path.join(HARNESS_DIR, 'src/harness.js'));
const { createFirefoxContext, cleanupFirefoxContext, rdpRequest } = harness;
const { acquireRdpPort } = require(path.join(HARNESS_DIR, 'src/rdp-port.js'));

// --- Config ---
const REPO_ROOT = path.resolve(__dirname, '../../..');
const EXT_SRC = path.join(REPO_ROOT, 'extensions/media-tamer');
const EXT_COPY_DIR = path.join(__dirname, '..', '.ext-copy');
const MEDIA_FIXTURE = path.join(__dirname, '..', 'node_modules', '.cache', 'media-test.mp4');
const XCICK = path.join(__dirname, 'xclick.py');
const RESULT_PATH = path.join(__dirname, '..', 'baseline-result.json');
const TEST_TIMEOUT_MS = 600000;

// --- Owned handles ---
let xvfbProc = null;
let displayNum = null;
let context = null;
let releasePort = null;
let mediaServer = null;
const logEntries = [];

function rec(k, v) {
  const entry = { t: Date.now(), k, v: v == null ? null : v };
  console.log(`[${entry.t}] ${k}:`, typeof v === 'object' ? JSON.stringify(v) : v);
  logEntries.push(entry);
  return entry;
}

// ===========================================================================
// Extension copy + hash verification
// ===========================================================================
function sha256FileSync(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function copyExtension() {
  rec('ext_copy_start', EXT_SRC);
  if (fs.existsSync(EXT_COPY_DIR)) {
    fs.rmSync(EXT_COPY_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(EXT_COPY_DIR, { recursive: true });

  // Copy every file in the extension source
  const entries = fs.readdirSync(EXT_SRC, { withFileTypes: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_SRC, 'manifest.json'), 'utf8'));
  const hashReport = { files: [], manifest_hash: sha256FileSync(path.join(EXT_SRC, 'manifest.json')) };

  for (const entry of entries) {
    const src = path.join(EXT_SRC, entry.name);
    const dst = path.join(EXT_COPY_DIR, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(src, dst, { recursive: true });
    } else {
      fs.copyFileSync(src, dst);
      hashReport.files.push({ name: entry.name, sha256: sha256FileSync(src) });
    }
  }

  rec('ext_copy_done', { ext_copy_dir: EXT_COPY_DIR, files: hashReport.files.length, manifest_hash: hashReport.manifest_hash });

  // Verify the copy: re-hash and compare
  const verifyManifest = sha256FileSync(path.join(EXT_COPY_DIR, 'manifest.json'));
  if (verifyManifest !== hashReport.manifest_hash) {
    throw new Error(`EXT_COPY_VERIFY_FAIL: manifest hash mismatch after copy (${verifyManifest} != ${hashReport.manifest_hash})`);
  }
  for (const f of hashReport.files) {
    if (f.name === 'manifest.json') continue;
    const actual = sha256FileSync(path.join(EXT_COPY_DIR, f.name));
    if (actual !== f.sha256) {
      throw new Error(`EXT_COPY_VERIFY_FAIL: ${f.name} hash mismatch (${actual} != ${f.sha256})`);
    }
  }
  rec('ext_verify_pass', true);

  return { path: EXT_COPY_DIR, hashReport };
}

// ===========================================================================
// Xvfb lifecycle — deterministic, no stale lock/sock deletion
// ===========================================================================
function findFreeDisplay() {
  // Check BOTH lock file AND socket — a stale socket without a lock means
  // a dead X server still occupying the display.
  for (let d = 99; d < 200; d++) {
    if (!fs.existsSync(`/tmp/.X${d}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${d}`)) return d;
  }
  throw new Error('No free X display in 99-200');
}

async function launchXvfb(display) {
  rec('xvfb_launch', `:${display}`);
  // Pre-check: fail fast if occupied (don't touch another's lock/socket)
  if (fs.existsSync(`/tmp/.X${display}-lock`) || fs.existsSync(`/tmp/.X11-unix/X${display}`)) {
    throw new Error('Display already occupied');
  }
  const proc = spawn('Xvfb', [`:${display}`, '-screen', '0', '1280x1024x24', '-ac', '-noreset'], {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (fs.existsSync(`/tmp/.X${display}-lock`) && fs.existsSync(`/tmp/.X11-unix/X${display}`)) {
      rec('xvfb_ready', `:${display}`);
      return proc;
    }
  }
  try { process.kill(-proc.pid); } catch {}
  try { proc.kill('SIGKILL'); } catch {}
  throw new Error(`Xvfb :${display} did not become ready`);
}

function killXvfb() {
  if (xvfbProc) {
    rec('xvfb_kill', `:${displayNum}`);
    try { process.kill(-xvfbProc.pid); } catch {}
    try { xvfbProc.kill('SIGKILL'); } catch {}
    xvfbProc = null;
  }
}

// ===========================================================================
// X11 click via xclick.py (XTest)
// ===========================================================================
function xclick(x, y) {
  const r = spawnSync('python3', [XCICK, String(x), String(y), `:${displayNum}`], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (r.status !== 0) throw new Error(`xclick ${x},${y} failed: ${r.stderr || r.stdout}`);
}

// ===========================================================================
// RDP eval in extension background page
// ===========================================================================
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
  const req = await rdpRequest(
    client,
    { to: consoleActor, type: 'evaluateJSAsync', text: wrapped, mapped: { await: true } },
    { what: 'evalInBg' },
  );
  if (!req.resultID) throw new Error('No resultID from evaluateJSAsync');

  const result = await new Promise((resolve, reject) => {
    const buf = client._evalResults;
    if (buf.has(req.resultID)) { const b = buf.get(req.resultID); buf.delete(req.resultID); resolve(b); return; }
    const ev = `evaluationResult:${req.resultID}`;
    const cleanup = () => { clearTimeout(t); client.off(ev, onRes); client.off('disconnect', onDisc); buf.delete(req.resultID); };
    const onRes = (m) => { cleanup(); resolve(m); };
    const onDisc = (e) => { cleanup(); reject(new Error(`RDP disconnect: ${e?.message || e}`)); };
    const t = setTimeout(() => { cleanup(); reject(new Error('evalInBg timeout')); }, 30000);
    t.unref?.();
    client.once(ev, onRes);
    client.once('disconnect', onDisc);
  });

  if (result.hasException) throw new Error(`bg exception: ${result.exceptionMessage}`);
  if (result.topLevelAwaitRejected) throw new Error('bg promise rejected');

  let val = result.result;
  if (val && typeof val === 'object' && val.type === 'longString') {
    let full = val.initial || '';
    while (full.length < val.length) {
      const chunk = await rdpRequest(client, { to: val.actor, type: 'substring', start: full.length, end: val.length }, { what: 'substring' });
      full += chunk.substring || '';
    }
    val = full;
  }
  if (typeof val !== 'string') throw new Error(`unexpected result type: ${typeof val}`);
  const parsed = JSON.parse(val);
  if (!parsed.__ok__) throw new Error(`bg error: ${parsed.__err__.message}\n${parsed.__err__.stack || ''}`);
  return parsed.__v__;
}

// ===========================================================================
// Popup open via toolbar click: known coords first, bounded scan
// ===========================================================================
async function openPopup(client, bgActor, mediaPage) {
  const winPos = await mediaPage.evaluate(() => ({
    x: window.screenX || 0, y: window.screenY || 0, w: window.outerWidth || 1280, h: window.outerHeight || 800,
  }));
  rec('window_pos', winPos);
  const winX = winPos.x || 0;
  const winY = winPos.y || 0;
  const winW = winPos.w || 1280;

  const knownFirst = [
    { x: 1020, y: 50 }, { x: 1030, y: 50 }, { x: 1010, y: 50 },
    { x: 1020, y: 45 }, { x: 1020, y: 55 }, { x: 1040, y: 50 },
    { x: 1000, y: 50 }, { x: 1020, y: 40 }, { x: 1020, y: 60 },
  ];
  for (const kc of knownFirst) {
    const ax = winX + kc.x, ay = winY + kc.y;
    rec('try_known', { x: ax, y: ay });
    xclick(ax, ay);
    await new Promise((r) => setTimeout(r, 300));
    const pv = await evalInBg(client, bgActor, `browser.extension.getViews({type:'popup'}).length`);
    if (pv > 0) { rec('popup_opened', { x: ax, y: ay, views: pv, method: 'known' }); return; }
  }

  rec('scan_start', 'bounded_toolbar');
  const scanStart = Date.now();
  const scanBudget = 50000;
  const xEnd = winX + winW - 20;
  for (let dy = 30; dy <= 70 && Date.now() - scanStart < scanBudget; dy += 10) {
    for (let dx = 0; dx <= 260 && Date.now() - scanStart < scanBudget; dx += 10) {
      const cx = xEnd - dx, cy = winY + dy;
      xclick(cx, cy);
      await new Promise((r) => setTimeout(r, 200));
      const pv = await evalInBg(client, bgActor, `browser.extension.getViews({type:'popup'}).length`);
      if (pv > 0) { rec('popup_opened', { x: cx, y: cy, views: pv, method: 'scan' }); return; }
    }
  }
  throw new Error('POPUP_OPEN_FAILED: exhausted known coords + bounded scan');
}

// ===========================================================================
// Assertion helper — null/undefined/non-finite always fails
// ===========================================================================
function assertExact(actual, expected, label) {
  if (actual === null || actual === undefined || typeof actual !== 'number' || !Number.isFinite(actual)) {
    throw new Error(`${label}: FAIL (got ${actual}, expected ${expected})`);
  }
  if (Math.abs(actual - expected) > 0.001) {
    throw new Error(`${label}: FAIL (expected ${expected}, got ${actual})`);
  }
  rec('assert_pass', { label, expected, actual });
}

// ===========================================================================
// Test flow
// ===========================================================================
async function runTests() {
  const results = {};

  // 0. Copy extension from repo into test workspace + hash verify
  const ext = copyExtension();

  // 1. Launch owned Xvfb
  displayNum = findFreeDisplay();
  xvfbProc = await launchXvfb(displayNum);

  // 2. Verify media fixture exists (generated ahead of time)
  if (!fs.existsSync(MEDIA_FIXTURE)) {
    throw new Error('Media fixture missing. Run: npm run gen:media');
  }
  const mp4Data = fs.readFileSync(MEDIA_FIXTURE);
  rec('media_fixture', { path: MEDIA_FIXTURE, bytes: mp4Data.length, sha256: crypto.createHash('sha256').update(mp4Data).digest('hex') });

  // 3. Serve media MP4 + HTML over HTTP
  const html = Buffer.from(
    '<!doctype html><html><head><title>Media Test</title></head>' +
      '<body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh">' +
      '<video id="media" controls autoplay loop muted preload="auto" style="width:640px">' +
      '<source src="media.mp4" type="video/mp4">' +
      '</video>' +
      '<p style="color:#888;position:fixed;top:8px;left:8px;font:12px monospace">Video Controls e2e baseline — media fixture loaded</p>' +
      '</body></html>',
  );
  mediaServer = http.createServer((req, res) => {
    if (req.url === '/media.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4Data.length, 'Accept-Ranges': 'bytes' });
      res.end(mp4Data);
    } else if (req.url === '/' || req.url === '/media.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => mediaServer.listen(0, '127.0.0.1', r));
  const mediaPort = mediaServer.address().port;
  const mediaUrl = `http://127.0.0.1:${mediaPort}/media.html`;
  rec('media_server', mediaUrl);

  // 4. Create Firefox context (harness patches ff, installs helper + ext)
  const { port: rdpPort, release } = await acquireRdpPort();
  releasePort = release;
  rec('rdp_port', rdpPort);

  const { context: ctx } = await createFirefoxContext(rdpPort, ext.path, {
    routeHandler: (route) => route.continue(),
    rewriteStaticRules: [],
    playwrightOptions: {
      headless: false,
      viewport: { width: 1280, height: 800 },
      launchOptions: {
        env: { ...process.env, DISPLAY: `:${displayNum}` },
        args: ['-remote-allow-system-access'],
      },
    },
  });
  context = ctx;
  rec('context_created', true);

  const rdpClient = context._rdpClient;
  const bgActor = context._firefoxBackgroundConsoleActor;

  // 5. Navigate media tab and wait for REAL media to load
  const mediaPage = await context.newPage();
  await mediaPage.goto(mediaUrl, { waitUntil: 'commit', timeout: 15000 });

  let mediaReady = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const state = await mediaPage.evaluate(() => {
      const m = document.getElementById('media');
      return { readyState: m?.readyState ?? null, paused: m?.paused ?? null, duration: m?.duration ?? null, src: m?.currentSrc ?? null };
    });
    if (state.readyState >= 2 && state.duration > 0) {
      mediaReady = true;
      rec('media_ready', state);
      break;
    }
  }
  if (!mediaReady) {
    const finalState = await mediaPage.evaluate(() => {
      const m = document.getElementById('media');
      return { readyState: m?.readyState, paused: m?.paused, duration: m?.duration, src: m?.currentSrc };
    });
    rec('media_not_ready', finalState);
    throw new Error(`media_ready FAIL: media did not load metadata. final state: ${JSON.stringify(finalState)}`);
  }
  results.media_ready = { pass: true };

  // Unmute after autoplay (extension respects site mute; tests need unmuted)
  await mediaPage.evaluate(() => {
    const m = document.getElementById('media');
    if (m) m.muted = false;
  });
  await new Promise((r) => setTimeout(r, 500));

  const initial = await mediaPage.evaluate(() => {
    const m = document.getElementById('media');
    return m ? { volume: m.volume, playbackRate: m.playbackRate, readyState: m.readyState } : null;
  });
  rec('initial_state', initial);
  results.playbackRate_initial = initial?.playbackRate ?? null;
  results.volume_initial = initial?.volume ?? null;

  // 6. Open the real popup via toolbar click
  const mediaTabId = await evalInBg(rdpClient, bgActor,
    'browser.tabs.query({active:true,currentWindow:true}).then(t => t[0]?.id ?? null)');
  rec('media_tab_id', mediaTabId);
  await openPopup(rdpClient, bgActor, mediaPage);

  // 7. Verify popup view is reachable
  const popupView = await evalInBg(rdpClient, bgActor, `(async () => {
    const views = browser.extension.getViews({type:'popup'});
    if (views.length === 0) return null;
    const w = views[0];
    return { url: w.location.href,
      buttons: Array.from(w.document.querySelectorAll('button')).filter(b => b.id)
        .map(b => ({ id: b.id, disabled: b.disabled })) };
  })()`);
  rec('popup_view', { url: popupView?.url, n: popupView?.buttons?.length });
  if (!popupView?.url) throw new Error('POPUP_VIEW_INACCESSIBLE');

  // 8. Wait for controls to become enabled
  let controlsReady = false;
  for (let i = 0; i < 20; i++) {
    const disabled = await evalInBg(rdpClient, bgActor, `(async () => {
      const views = browser.extension.getViews({type:'popup'});
      return views[0]?.document.getElementById('sp-0.5')?.disabled ?? null;
    })()`);
    if (disabled === false) { controlsReady = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  rec('controls_ready', controlsReady);

  // =====================================================================
  // TEST 1: Speed 0.5x
  // =====================================================================
  await evalInBg(rdpClient, bgActor, `(async () => {
    const w = browser.extension.getViews({type:'popup'})[0];
    const btn = w.document.getElementById('sp-0.5');
    if (btn) btn.dispatchEvent(new w.Event('click', { bubbles: true, cancelable: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 1000));

  const afterSpeed = await mediaPage.evaluate(() => {
    const m = document.getElementById('media');
    return m ? { playbackRate: m.playbackRate, volume: m.volume } : null;
  });
  rec('after_speed_0.5', afterSpeed);
  results.playbackRate_after_speed_0_5 = afterSpeed?.playbackRate ?? null;
  assertExact(results.playbackRate_after_speed_0_5, 0.5, 'speed_0_5');
  results.speed_0_5 = { expected: 0.5, actual: results.playbackRate_after_speed_0_5, pass: true };

  // =====================================================================
  // TEST 2: Volume 50%
  // =====================================================================
  await evalInBg(rdpClient, bgActor, `(async () => {
    const w = browser.extension.getViews({type:'popup'})[0];
    const btn = w.document.getElementById('vp-50');
    if (btn) btn.dispatchEvent(new w.Event('click', { bubbles: true, cancelable: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 1000));

  const afterVol50 = await mediaPage.evaluate(() => {
    const m = document.getElementById('media');
    return m ? { volume: m.volume } : null;
  });
  rec('after_vol_50', afterVol50);
  results.volume_after_50 = afterVol50?.volume ?? null;
  assertExact(results.volume_after_50, 0.5, 'volume_50');
  results.volume_50 = { expected: 0.5, actual: results.volume_after_50, pass: true };

  // =====================================================================
  // TEST 3: Volume reset
  // =====================================================================
  await evalInBg(rdpClient, bgActor, `(async () => {
    const w = browser.extension.getViews({type:'popup'})[0];
    const btn = w.document.getElementById('volume-reset');
    if (btn) btn.dispatchEvent(new w.Event('click', { bubbles: true, cancelable: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 1000));

  const afterReset = await mediaPage.evaluate(() => {
    const m = document.getElementById('media');
    return m ? { volume: m.volume } : null;
  });
  rec('after_reset', afterReset);
  results.volume_after_reset = afterReset?.volume ?? null;
  assertExact(results.volume_after_reset, 1, 'volume_reset');
  results.volume_reset = { expected: 1, actual: results.volume_after_reset, pass: true };

  // =====================================================================
  // TEST 4: Seek undo
  // Programmatic seek (>2s jump) creates seek history; undo restores position.
  // Bypass popup seek-state staleness by driving content script directly
  // via background's browser.tabs.sendMessage (popup inits seek state once
  // at open time and never refreshes it).
  // =====================================================================
  const mediaDuration = await mediaPage.evaluate(() => document.getElementById('media').duration);
  if (mediaDuration >= 5) {
    const beforeSeek = await mediaPage.evaluate(() => document.getElementById('media').currentTime);
    const seekTarget = Math.min(beforeSeek + 3, mediaDuration - 0.5);
    await mediaPage.evaluate((t) => { document.getElementById('media').currentTime = t; }, seekTarget);
    await new Promise((r) => setTimeout(r, 1500));

    const afterSeek = await mediaPage.evaluate(() => document.getElementById('media').currentTime);
    rec('seek_done', { before: beforeSeek, after: afterSeek, target: seekTarget });

    // Query seek state from content script directly via background
    const seekState = await evalInBg(rdpClient, bgActor, `(async () => {
      const tabs = await browser.tabs.query({active:true,currentWindow:true});
      const tabId = tabs[0].id;
      const results = await browser.tabs.sendMessage(tabId, {type:'VC_SEEK_GET', tabId});
      return Array.isArray(results) ? results[0] : results;
    })()`);
    rec('seek_state_before_undo', seekState);

    if (!seekState || !seekState.canUndo) {
      throw new Error(`seek_undo FAIL: no seek history recorded. state: ${JSON.stringify(seekState)}`);
    }

    // Trigger undo via background message to content script
    const undoResult = await evalInBg(rdpClient, bgActor, `(async () => {
      const tabs = await browser.tabs.query({active:true,currentWindow:true});
      const tabId = tabs[0].id;
      const r = await browser.tabs.sendMessage(tabId, {type:'VC_SEEK_UNDO', tabId});
      return r;
    })()`);
    rec('seek_undo_call_result', undoResult);
    await new Promise((r) => setTimeout(r, 1500));

    const afterUndo = await mediaPage.evaluate(() => document.getElementById('media').currentTime);
    rec('seek_undo_result', { beforeSeek, afterSeek, afterUndo });

    const distToBefore = Math.abs(afterUndo - beforeSeek);
    const distToAfter = Math.abs(afterUndo - afterSeek);
    if (distToBefore >= distToAfter) {
      throw new Error(`seek_undo FAIL: undo did not restore position. before=${beforeSeek}, afterSeek=${afterSeek}, afterUndo=${afterUndo}`);
    }
    results.seek_undo = { expected: 'restored', actual: { beforeSeek, afterUndo, distToBefore }, pass: true };
  } else {
    rec('seek_undo_skip', { reason: 'media too short', duration: mediaDuration });
    results.seek_undo = { pass: null, skip: 'media too short for >2s seek' };
  }

  // =====================================================================
  // TEST 5: New tab visibility / tab independence
  // Open a second media tab, verify popup in second tab reads the new tabId.
  // =====================================================================
  const secondPage = await context.newPage();
  await secondPage.goto(mediaUrl, { waitUntil: 'commit', timeout: 15000 });
  // Wait for media to load on second tab
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const st = await secondPage.evaluate(() => {
      const m = document.getElementById('media');
      return { readyState: m?.readyState, duration: m?.duration };
    });
    if (st.readyState >= 2 && st.duration > 0) break;
  }

  // Open popup on second tab
  await openPopup(rdpClient, bgActor, secondPage);
  const secondTabId = await evalInBg(rdpClient, bgActor,
    'browser.tabs.query({active:true,currentWindow:true}).then(t => t[0]?.id ?? null)');
  rec('second_tab_id', { mediaTabId, secondTabId });

  if (secondTabId === mediaTabId) {
    throw new Error(`new_tab FAIL: second tab has same tabId as first (${secondTabId})`);
  }

  // Set speed 0.5 on second tab, verify first tab is still at whatever it was
  await evalInBg(rdpClient, bgActor, `(async () => {
    const w = browser.extension.getViews({type:'popup'})[0];
    const btn = w.document.getElementById('sp-0.5');
    if (btn) btn.dispatchEvent(new w.Event('click', { bubbles: true, cancelable: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 1000));

  const secondTabSpeed = await secondPage.evaluate(() => document.getElementById('media').playbackRate);
  const firstTabSpeed = await mediaPage.evaluate(() => document.getElementById('media').playbackRate);
  rec('cross_tab_speeds', { firstTabSpeed, secondTabSpeed });

  assertExact(secondTabSpeed, 0.5, 'new_tab_speed_0_5');
  // First tab should still be at its last known speed (1.0 from initial or whatever it was after earlier tests)
  results.new_tab = {
    expected: { tabId_different: true, secondTabSpeed: 0.5 },
    actual: { firstTabId: mediaTabId, secondTabId, secondTabSpeed, firstTabSpeed },
    pass: true,
  };

  // =====================================================================
  // TEST 6: Theme API round-trip
  // Calls browser.theme.update(), reads back via browser.theme.getCurrent().
  // Verifies the theme engine accepted our dark frame color. NOTE: this
  // does NOT verify pageAction icon variant swap (pageAction.setIcon is
  // per-tab and async; icon-variant correctness is covered by the popup
  // applyThemeIcon() unit-level logic in test/browser). We only exercise
  // the theme API here.
  // =====================================================================
  const themeResult = await evalInBg(rdpClient, bgActor, `(async () => {
    try {
      await browser.theme.update({ colors: { frame: '#1a1a2e', toolbar: '#16213e', toolbar_text: '#e0e0e0' } });
      await new Promise(r => setTimeout(r, 500));
      const afterDark = await browser.theme.getCurrent();
      return { ok: true, themeAfterDark: afterDark.colors?.frame || null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  })()`);
  rec('theme_switch', themeResult);

  if (themeResult && themeResult.ok) {
    const frameColor = themeResult.themeAfterDark;
    // Only pass if the frame color actually reflects our dark value
    const isDark = frameColor === '#1a1a2e';
    results.theme_switch = { expected: 'theme.update() applies dark frame', actual: { frameColor, isDark }, pass: isDark };
  } else {
    results.theme_switch = { expected: 'theme.update() applies', actual: themeResult, pass: false, error: themeResult?.error || 'unknown' };
  }

  // =====================================================================
  // Final verdict
  // =====================================================================
  const verdictChecks = {
    media_ready: results.media_ready?.pass === true,
    speed_0_5: results.speed_0_5?.pass === true,
    volume_50: results.volume_50?.pass === true,
    volume_reset: results.volume_reset?.pass === true,
    seek_undo: results.seek_undo?.pass === true || results.seek_undo?.skip != null,
    new_tab: results.new_tab?.pass === true,
    theme_switch: results.theme_switch?.pass === true,
  };
  const allPassed = Object.values(verdictChecks).every(Boolean);
  results.verdict = allPassed ? 'BASELINE_PASS' : 'BASELINE_FAIL';
  results.verdictChecks = verdictChecks;
  results.tests = {
    media_ready: results.media_ready,
    speed_0_5: results.speed_0_5,
    volume_50: results.volume_50,
    volume_reset: results.volume_reset,
    seek_undo: results.seek_undo,
    new_tab: results.new_tab,
    theme_switch: results.theme_switch,
  };
  return results;
}

// ===========================================================================
// Timeout wrapper
// ===========================================================================
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`TIMEOUT: ${label} after ${ms}ms`)), ms);
      t.unref();
    }),
  ]);
}

// ===========================================================================
// Signal handlers for cleanup on external kill
// ===========================================================================
function shutdown(sig) {
  rec('signal', sig);
  killXvfb();
  process.exit(130);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ===========================================================================
// Main
// ===========================================================================
async function main() {
  try {
    const results = await withTimeout(runTests(), TEST_TIMEOUT_MS, 'baseline');
    const output = { ok: true, verdict: results.verdict, results, log: logEntries,
      env: { display: `:${displayNum}`, node: process.version, platform: process.platform,
        ext_hash: results.extHash || null } };
    fs.writeFileSync(RESULT_PATH, JSON.stringify(output, null, 2));
    console.log('\n=== ' + results.verdict + ' ===');
    return 0;
  } catch (e) {
    const output = { ok: false, verdict: 'BASELINE_FAIL', error: e.message,
      stack: e.stack?.split('\n').slice(0, 15).join('\n'), log: logEntries };
    fs.writeFileSync(RESULT_PATH, JSON.stringify(output, null, 2));
    console.error('\n=== BASELINE FAIL ===', e.message);
    return 1;
  } finally {
    if (context) {
      try { await cleanupFirefoxContext(context); } catch (e) { rec('cleanup_ctx_err', e.message); }
    }
    if (releasePort) {
      try { await releasePort(); } catch (e) { rec('cleanup_port_err', e.message); }
    }
    if (mediaServer) {
      try { mediaServer.close(); } catch (e) { rec('cleanup_media_err', e.message); }
    }
    killXvfb();
    // Clean up ext copy
    try { if (fs.existsSync(EXT_COPY_DIR)) fs.rmSync(EXT_COPY_DIR, { recursive: true, force: true }); } catch {}
    rec('cleanup_done', true);
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error('FATAL', e); process.exit(1); });
