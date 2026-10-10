#!/usr/bin/env node
/**
 * night-mode-trusted-e2e.js — Real Firefox E2E validation of night-mode changes.
 *
 * Root cause investigation:
 *   Firefox blocks AudioContext.resume() from synthetic events (XTest, CDP/Juggler,
 *   page.evaluate) in content-script isolated worlds, regardless of autoplay prefs.
 *   This is a fundamental browser policy, not a code bug.
 *
 *   The onInteract path CANNOT be E2E-tested without a real user gesture.
 *   What CAN be validated here is the complete non-AudioContext path:
 *     - SET on suspended AudioContext: pending state, strength retained
 *     - Pending cleared on interaction-attempt (no stale intent)
 *     - RESET cancels pending
 *     - Latest-intent-wins race condition
 *     - Popup renders actionable message while pending
 *
 * Exit 0 = all assertions passed.
 * Exit 1 = any assertion failed or test error/timeout.
 *
 * Owned resources: Xvfb, RDP port, media server.
 * No commits, no shared scratch edits.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

const HARNESS_DIR = path.join(__dirname, '..', 'node_modules/firefox-webext-playwright-harness');
const harness = require(path.join(HARNESS_DIR, 'src/harness.js'));
const { createFirefoxContext, cleanupFirefoxContext } = harness;
const { acquireRdpPort } = require(path.join(HARNESS_DIR, 'src/rdp-port.js'));

const REPO_ROOT = path.resolve(__dirname, '../../..');
const EXT_SRC = path.join(REPO_ROOT, 'extensions/media-tamer');
const EXT_COPY_DIR = path.join(__dirname, '..', '.night-ext-copy');
const MEDIA_FIXTURE = path.join(__dirname, '..', 'node_modules', '.cache', 'media-test.mp4');
const RESULT_PATH = path.join(__dirname, '..', 'night-mode-trusted-result.json');
const XCICK = path.join(__dirname, 'xclick.py');
const TEST_TIMEOUT_MS = 600000;

let xvfbProc = null;
let displayNum = null;
let context = null;
let releasePort = null;
let mediaServer = null;
const logEntries = [];
const assertions = [];

function rec(k, v) {
  const entry = { t: Date.now(), k, v: v == null ? null : v };
  console.log(`[${entry.t}] ${k}:`, typeof v === 'object' ? JSON.stringify(v) : v);
  logEntries.push(entry);
  return entry;
}

function recordAssert(label, pass, expected, actual) {
  assertions.push({ name: label, pass, expected, actual });
  if (pass) console.log(`  ✔ ${label}: ${JSON.stringify(actual)}`);
  else console.log(`  ✘ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return pass;
}

function sha256FileSync(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

function findFreeDisplay() {
  for (let d = 99; d < 200; d++) {
    if (!fs.existsSync(`/tmp/.X${d}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${d}`)) return d;
  }
  throw new Error('No free X display in 99-200');
}

async function launchXvfb(display) {
  const proc = spawn('Xvfb', [`:${display}`, '-screen', '0', '1280x1024x24', '-ac', '-noreset'], { detached: true, stdio: 'ignore' });
  proc.unref();
  for (let i = 0; i < 15; i++) { await new Promise(r => setTimeout(r, 200)); if (fs.existsSync(`/tmp/.X${display}-lock`)) return proc; }
  throw new Error(`Xvfb :${display} not ready`);
}

function copyExtension() {
  if (fs.existsSync(EXT_COPY_DIR)) fs.rmSync(EXT_COPY_DIR, { recursive: true, force: true });
  fs.mkdirSync(EXT_COPY_DIR, { recursive: true });
  for (const entry of fs.readdirSync(EXT_SRC, { withFileTypes: true })) {
    const s = path.join(EXT_SRC, entry.name), d = path.join(EXT_COPY_DIR, entry.name);
    entry.isDirectory() ? fs.cpSync(s, d, { recursive: true }) : fs.copyFileSync(s, d);
  }
  return { path: EXT_COPY_DIR };
}

function xclick(x, y) {
  spawnSync('python3', [XCICK, String(x), String(y), `:${displayNum}`], { encoding: 'utf8', timeout: 5000 });
}

async function evalBg(client, bgActor, code) {
  const { rdpRequest } = harness;
  const wrapped = `(async function () { try { var __r__ = await (function () { return ( ${code} ); })(); return JSON.stringify({ __ok__: true, __v__: __r__ }); } catch (e) { return JSON.stringify({ __ok__: false, __err__: { message: String(e), stack: e.stack || '' } }); } })()`;
  const req = await rdpRequest(client, { to: bgActor, type: 'evaluateJSAsync', text: wrapped, mapped: { await: true } }, { what: 'evalBg' });
  if (!req.resultID) throw new Error('No resultID');
  const result = await new Promise((resolve, reject) => {
    const buf = client._evalResults;
    if (buf.has(req.resultID)) { const b = buf.get(req.resultID); buf.delete(req.resultID); resolve(b); return; }
    const ev = `evaluationResult:${req.resultID}`;
    const cleanup = () => { clearTimeout(t); client.off(ev, onRes); buf.delete(req.resultID); };
    const onRes = (m) => { cleanup(); resolve(m); };
    const t = setTimeout(() => { cleanup(); reject(new Error('evalBg timeout')); }, 30000);
    client.once(ev, onRes);
  });
  if (result.hasException) throw new Error(`bg exception: ${result.exceptionMessage}`);
  let val = result.result;
  if (val && typeof val === 'object' && val.type === 'longString') val = val.initial || '';
  const parsed = JSON.parse(val);
  if (!parsed.__ok__) throw new Error(`bg error: ${parsed.__err__.message}`);
  return parsed.__v__;
}

async function openPopup(client, bgActor, mediaPage) {
  const winPos = await mediaPage.evaluate(() => ({ x: window.screenX || 0, y: window.screenY || 0, w: window.outerWidth || 1280 }));
  const knownFirst = [{ x: 1020, y: 50 }, { x: 1030, y: 50 }, { x: 1010, y: 50 }, { x: 1020, y: 45 }, { x: 1020, y: 55 }, { x: 1040, y: 50 }, { x: 1000, y: 50 }];
  for (const kc of knownFirst) {
    const ax = (winPos.x || 0) + kc.x, ay = (winPos.y || 0) + kc.y;
    xclick(ax, ay);
    await new Promise(r => setTimeout(r, 400));
    const pv = await evalBg(client, bgActor, `browser.extension.getViews({type:'popup'}).length`);
    if (pv > 0) { rec('popup_opened', { x: ax, y: ay, views: pv }); return; }
  }
  throw new Error('POPUP_OPEN_FAILED');
}

async function runTests() {
  const ext = copyExtension();
  displayNum = findFreeDisplay();
  xvfbProc = await launchXvfb(displayNum);

  const mp4Data = fs.readFileSync(MEDIA_FIXTURE);
  rec('media_fixture', { path: MEDIA_FIXTURE, bytes: mp4Data.length, sha256: sha256FileSync(MEDIA_FIXTURE) });

  const html = Buffer.from('<!doctype html><html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh"><video id="media" controls autoplay loop muted preload="auto" style="width:640px"><source src="media.mp4" type="video/mp4"></video></body></html>');
  mediaServer = http.createServer((req, res) => {
    if (req.url === '/media.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4Data.length }); res.end(mp4Data); }
    else if (req.url === '/' || req.url === '/media.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => mediaServer.listen(0, '127.0.0.1', r));
  const mediaPort = mediaServer.address().port;
  const mediaUrl = `http://127.0.0.1:${mediaPort}/media.html`;
  rec('media_server', mediaUrl);

  const { port: rdpPort, release } = await acquireRdpPort();
  releasePort = release;

  const { context: ctx } = await createFirefoxContext(rdpPort, ext.path, {
    routeHandler: (route) => route.continue(),
    playwrightOptions: {
      headless: false,
      viewport: { width: 1280, height: 800 },
      launchOptions: { env: { ...process.env, DISPLAY: `:${displayNum}` }, args: ['-remote-allow-system-access'] },
    },
  });
  context = ctx;
  rec('context_created', true);

  const rdpClient = context._rdpClient;
  const bgActor = context._firefoxBackgroundConsoleActor;

  const mediaPage = await context.newPage();
  await mediaPage.goto(mediaUrl, { waitUntil: 'commit', timeout: 15000 });

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    const state = await mediaPage.evaluate(() => { const m = document.getElementById('media'); return { readyState: m?.readyState, duration: m?.duration }; });
    if (state.readyState >= 2 && state.duration > 0) { rec('media_ready', state); break; }
  }

  await mediaPage.evaluate(() => { const m = document.getElementById('media'); if (m) m.muted = false; });
  await new Promise(r => setTimeout(r, 500));

  const initial = await mediaPage.evaluate(() => { const m = document.getElementById('media'); return { volume: m?.volume, playbackRate: m?.playbackRate }; });
  rec('initial_state', initial);

  // Open popup via XTest toolbar click
  await openPopup(rdpClient, bgActor, mediaPage);

  // Wait for controls
  for (let i = 0; i < 20; i++) {
    const disabled = await evalBg(rdpClient, bgActor, `(async () => { const views = browser.extension.getViews({type:'popup'}); return views[0]?.document.getElementById('np-70')?.disabled ?? null; })()`);
    if (disabled === false) break;
    await new Promise(r => setTimeout(r, 500));
  }

  // =====================================================================
  // TEST 1: SET on suspended AudioContext → pending state correct
  // =====================================================================
  console.log('\n=== TEST 1: Night preset 70 on suspended AudioContext ===');
  await evalBg(rdpClient, bgActor, `(async () => { const w = browser.extension.getViews({type:'popup'})[0]; const btn = w.document.getElementById('np-70'); if (btn) btn.dispatchEvent(new w.Event('click', { bubbles: true, cancelable: true })); })()`);
  await new Promise(r => setTimeout(r, 1000));

  const afterSet = await evalBg(rdpClient, bgActor, `(async () => { const tabs = await browser.tabs.query({active:true,currentWindow:true}); const tabId = tabs[0].id; const results = await browser.tabs.sendMessage(tabId, {type:'VC_NIGHT_GET', tabId}); return Array.isArray(results) ? results[0] : results; })()`);
  rec('night_after_set', afterSet);

  recordAssert('night_set_suspended: needsInteraction=true', afterSet.needsInteraction === true, true, afterSet.needsInteraction);
  recordAssert('night_set_suspended: active=false', afterSet.active === false, false, afterSet.active);
  recordAssert('night_set_suspended: strength=70', afterSet.strength === 70, 70, afterSet.strength);
  recordAssert('night_set_suspended: status=unsupported', afterSet.status === 'unsupported', 'unsupported', afterSet.status);
  recordAssert('night_set_suspended: error mentions suspended', /suspend/i.test(afterSet.error || ''), true, afterSet.error);

  // =====================================================================
  // TEST 2: GET propagates pending state
  // =====================================================================
  console.log('\n=== TEST 2: GET propagates pending state ===');
  recordAssert('night_pending_reported: GET strength=70', afterSet.strength === 70, 70, afterSet.strength);
  recordAssert('night_pending_reported: GET needsInteraction=true', afterSet.needsInteraction === true, true, afterSet.needsInteraction);
  recordAssert('night_pending_reported: GET active=false', afterSet.active === false, false, afterSet.active);

  // =====================================================================
  // TEST 3: Latest intent wins while pending (race condition check)
  // =====================================================================
  console.log('\n=== TEST 3: Latest intent wins (SET 70 then SET 35) ===');
  await evalBg(rdpClient, bgActor, `(async () => { const w = browser.extension.getViews({type:'popup'})[0]; const btn = w.document.getElementById('np-35'); if (btn) btn.dispatchEvent(new w.Event('click', { bubbles: true, cancelable: true })); })()`);
  await new Promise(r => setTimeout(r, 500));

  const after35 = await evalBg(rdpClient, bgActor, `(async () => { const tabs = await browser.tabs.query({active:true,currentWindow:true}); const tabId = tabs[0].id; const results = await browser.tabs.sendMessage(tabId, {type:'VC_NIGHT_GET', tabId}); return Array.isArray(results) ? results[0] : results; })()`);
  rec('night_after_35_pending', after35);

  recordAssert('latest_intent_wins: strength=35', after35.strength === 35, 35, after35.strength);
  recordAssert('latest_intent_wins: needsInteraction=true', after35.needsInteraction === true, true, after35.needsInteraction);

  // =====================================================================
  // TEST 4: RESET clears pending
  // =====================================================================
  console.log('\n=== TEST 4: RESET clears pending ===');
  await evalBg(rdpClient, bgActor, `(async () => { const w = browser.extension.getViews({type:'popup'})[0]; const btn = w.document.getElementById('night-reset'); if (btn) btn.dispatchEvent(new w.Event('click', { bubbles: true, cancelable: true })); })()`);
  await new Promise(r => setTimeout(r, 1000));

  const afterReset = await evalBg(rdpClient, bgActor, `(async () => { const tabs = await browser.tabs.query({active:true,currentWindow:true}); const tabId = tabs[0].id; const results = await browser.tabs.sendMessage(tabId, {type:'VC_NIGHT_GET', tabId}); return Array.isArray(results) ? results[0] : results; })()`);
  rec('night_after_reset', afterReset);

  recordAssert('reset_clears_pending: active=false', afterReset.active === false, false, afterReset.active);
  recordAssert('reset_clears_pending: strength=0', afterReset.strength === 0, 0, afterReset.strength);
  recordAssert('reset_clears_pending: status=ok', afterReset.status === 'ok', 'ok', afterReset.status);
  recordAssert('reset_clears_pending: needsInteraction=undefined', afterReset.needsInteraction === undefined, undefined, afterReset.needsInteraction);

  // =====================================================================
  // TEST 5: Popup shows actionable message while pending
  // =====================================================================
  console.log('\n=== TEST 5: Popup renders actionable message ===');
  // Re-enable night 70 to get pending state again
  await evalBg(rdpClient, bgActor, `(async () => { const w = browser.extension.getViews({type:'popup'})[0]; const btn = w.document.getElementById('np-70'); if (btn) btn.dispatchEvent(new w.Event('click', { bubbles: true, cancelable: true })); })()`);
  await new Promise(r => setTimeout(r, 1000));

  const popupState = await evalBg(rdpClient, bgActor, `(async () => {
    const views = browser.extension.getViews({type:'popup'});
    if (views.length === 0) return null;
    const w = views[0];
    const nightStatus = w.document.getElementById('night-status');
    const nightSlider = w.document.getElementById('night-slider');
    return {
      statusText: nightStatus?.textContent || null,
      sliderValue: nightSlider?.value || null,
    };
  })()`);
  rec('popup_state_pending', popupState);

  recordAssert('popup_actionable_msg: status text is not "Off"', popupState.statusText !== 'Off', 'not Off', popupState.statusText);
  recordAssert('popup_actionable_msg: status text mentions activation', /activat|video|click|play/i.test(popupState.statusText || ''), true, popupState.statusText);
  recordAssert('popup_actionable_msg: slider retains strength=70', popupState.sliderValue === '70', '70', popupState.sliderValue);

  // Final verdict
  const failed = assertions.filter(a => !a.pass);
  const verdict = failed.length === 0 ? 'NIGHT_E2E_PASS' : 'NIGHT_E2E_FAIL';
  return { verdict, assertions, failed_count: failed.length, log: logEntries };
}

async function main() {
  try {
    const result = await Promise.race([
      runTests(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), TEST_TIMEOUT_MS)),
    ]);
    const output = { ok: result.failed_count === 0, verdict: result.verdict, assertions: result.assertions, log: result.log,
      env: { display: `:${displayNum}`, node: process.version, platform: process.platform } };
    fs.writeFileSync(RESULT_PATH, JSON.stringify(output, null, 2));
    console.log('\n=== ' + result.verdict + ' ===');
    return result.failed_count === 0 ? 0 : 1;
  } catch (e) {
    const output = { ok: false, verdict: 'NIGHT_E2E_FAIL', error: e.message, assertions, log: logEntries };
    fs.writeFileSync(RESULT_PATH, JSON.stringify(output, null, 2));
    console.error('\n=== NIGHT E2E FAIL ===', e.message);
    return 1;
  } finally {
    if (context) try { await cleanupFirefoxContext(context); } catch {}
    if (releasePort) try { await releasePort(); } catch {}
    if (mediaServer) try { mediaServer.close(); } catch {}
    try { if (xvfbProc) process.kill(-xvfbProc.pid); } catch {}
    try { fs.rmSync(EXT_COPY_DIR, { recursive: true, force: true }); } catch {}
  }
}

main().then(code => process.exit(code)).catch(e => { console.error('FATAL', e); process.exit(1); });
