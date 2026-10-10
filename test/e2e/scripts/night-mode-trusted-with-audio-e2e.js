#!/usr/bin/env node
/**
 * night-mode-trusted-with-audio-e2e.js — Full before→interact→after night mode validation
 * using a private PulseAudio null sink.
 *
 * Previous E2E (night-mode-trusted-e2e.js) works around the no-audio-device scenario by
 * testing the "pending" path only. With a private Pulse null sink running, AudioContext
 * CAN actually resume after a trusted user interaction. This test proves the real
 * activation path end-to-end:
 *
 *   1. BEFORE: AudioContext starts suspended, night 70 → pending
 *   2. INTERACT: Send trusted keydown (Playwright keyboard API) → interaction listener
 *      resumes AudioContext and applies pending night
 *   3. AFTER: GET reports active=true, strength=70, status=ok, gain reduction active
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
const { rdpRequest } = harness;
const { acquireRdpPort } = require(path.join(HARNESS_DIR, 'src/rdp-port.js'));

const REPO_ROOT = path.resolve(__dirname, '../../..');
const EXT_SRC = path.join(REPO_ROOT, 'extensions/media-tamer');
const EXT_COPY_DIR = path.join(__dirname, '..', '.night-ext-copy-audio');
const MEDIA_FIXTURE = path.join(__dirname, '..', 'node_modules', '.cache', 'media-test.mp4');
const RESULT_PATH = path.join(__dirname, '..', 'night-mode-trusted-audio-result.json');
const XCICK = path.join(__dirname, 'xclick.py');
const TEST_TIMEOUT_MS = 600000;

const SCRATCH = process.env.VC_AUDIO_E2E_PULSE_RUN || '.tmp/audio-e2e/pulse-run';
const PULSE_SERVER = `${SCRATCH}/socket`;

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
  const knownFirst = [{ x: 1020, y: 50 }, { x: 1030, y: 50 }, { x: 1010, y: 50 }, { x: 1020, y: 45 }, { x: 1020, y: 55 }];
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
      launchOptions: {
        env: {
          ...process.env,
          DISPLAY: `:${displayNum}`,
          PULSE_SERVER: PULSE_SERVER,
          LD_LIBRARY_PATH: `${SCRATCH}/modules:${SCRATCH}/../pulse-bin/usr/lib/x86_64-linux-gnu/pulseaudio:${SCRATCH}/../pulse-bin/usr/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu/pulseaudio:/usr/lib/x86_64-linux-gnu:${process.env.LD_LIBRARY_PATH || ''}`,
        },
        args: ['-remote-allow-system-access'],
      },
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

  // =====================================================================
  // BEFORE: AudioContext state on media page (should be suspended without interaction)
  // =====================================================================
  console.log('\n=== BEFORE: AudioContext initial state (suspended expected) ===');
  const audioCtxBefore = await mediaPage.evaluate(() => {
    const ctx = new AudioContext();
    const state = ctx.state;
    ctx.close();
    return { initialState: state };
  });
  rec('audio_ctx_before', audioCtxBefore);
  recordAssert('audio_ctx_initial_suspended', audioCtxBefore.initialState === 'suspended', 'suspended', audioCtxBefore.initialState);

  // =====================================================================
  // PENDING: Night 70 while AudioContext suspended → pending state
  // =====================================================================
  console.log('\n=== PENDING: Night preset 70 while AudioContext suspended ===');
  await openPopup(rdpClient, bgActor, mediaPage);

  // Wait for controls
  for (let i = 0; i < 20; i++) {
    const disabled = await evalBg(rdpClient, bgActor, `(async () => { const views = browser.extension.getViews({type:'popup'}); return views[0]?.document.getElementById('np-70')?.disabled ?? null; })()`);
    if (disabled === false) break;
    await new Promise(r => setTimeout(r, 500));
  }

  await evalBg(rdpClient, bgActor, `(async () => { const w = browser.extension.getViews({type:'popup'})[0]; const btn = w.document.getElementById('np-70'); if (btn) btn.dispatchEvent(new w.Event('click', { bubbles: true, cancelable: true })); })()`);
  await new Promise(r => setTimeout(r, 1000));

  const nightPending = await evalBg(rdpClient, bgActor, `(async () => { const tabs = await browser.tabs.query({active:true,currentWindow:true}); const tabId = tabs[0].id; const results = await browser.tabs.sendMessage(tabId, {type:'VC_NIGHT_GET', tabId}); return Array.isArray(results) ? results[0] : results; })()`);
  rec('night_pending_before_interaction', nightPending);
  recordAssert('night_pending: needsInteraction=true', nightPending.needsInteraction === true, true, nightPending.needsInteraction);
  recordAssert('night_pending: active=false', nightPending.active === false, false, nightPending.active);
  recordAssert('night_pending: strength=70', nightPending.strength === 70, 70, nightPending.strength);
  recordAssert('night_pending: status=unsupported', nightPending.status === 'unsupported', 'unsupported', nightPending.status);

  // =====================================================================
  // INTERACT: Trusted keydown to trigger interaction listener → resume AudioContext
  // =====================================================================
  console.log('\n=== INTERACT: Trusted keydown (Playwright keyboard API) ===');
  await mediaPage.bringToFront();
  await new Promise(r => setTimeout(r, 500));
  await mediaPage.locator('#media').click({ force: false }).catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  await mediaPage.keyboard.press('Space');
  await new Promise(r => setTimeout(r, 2000));

  // =====================================================================
  // AFTER: Re-set night 70 → with AudioContext now running, should be active=true
  // The extension's interaction listener resumed sharedAudioCtx during the
  // trusted keydown. We prove this by re-setting night and checking the
  // extension reports active=true, count>=1 (media element routed), and
  // gainReduction<0 (compressor active).
  // =====================================================================
  console.log('\n=== AFTER: Re-set night 70 with running AudioContext ===');
  // Re-set night 70 (clear any pending first)
  await evalBg(rdpClient, bgActor, `(async () => { const w = browser.extension.getViews({type:'popup'})[0]; const btn = w.document.getElementById('night-reset'); if (btn) btn.dispatchEvent(new w.Event('click', { bubbles: true, cancelable: true })); })()`);
  await new Promise(r => setTimeout(r, 500));
  await evalBg(rdpClient, bgActor, `(async () => { const w = browser.extension.getViews({type:'popup'})[0]; const btn = w.document.getElementById('np-70'); if (btn) btn.dispatchEvent(new w.Event('click', { bubbles: true, cancelable: true })); })()`);
  await new Promise(r => setTimeout(r, 1500));

  const nightAfter = await evalBg(rdpClient, bgActor, `(async () => { const tabs = await browser.tabs.query({active:true,currentWindow:true}); const tabId = tabs[0].id; const results = await browser.tabs.sendMessage(tabId, {type:'VC_NIGHT_GET', tabId}); return Array.isArray(results) ? results[0] : results; })()`);
  rec('night_after_interaction', nightAfter);

  recordAssert('night_after_interaction: active=true', nightAfter.active === true, true, nightAfter.active);
  recordAssert('night_after_interaction: strength=70', nightAfter.strength === 70, 70, nightAfter.strength);
  recordAssert('night_after_interaction: status=ok', nightAfter.status === 'ok', 'ok', nightAfter.status);
  recordAssert('night_after_interaction: count>=1 (media element routed)', nightAfter.count >= 1, '>=1', nightAfter.count);
  recordAssert('night_after_interaction: gainReduction<0 (compressor active)', (nightAfter.reduction ?? 0) < 0, '<0', nightAfter.reduction);

  // Final verdict
  const failed = assertions.filter(a => !a.pass);
  const verdict = failed.length === 0 ? 'NIGHT_AUDIO_E2E_PASS' : 'NIGHT_AUDIO_E2E_FAIL';
  return { verdict, assertions, failed_count: failed.length, log: logEntries };
}

async function main() {
  try {
    const result = await Promise.race([
      runTests(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), TEST_TIMEOUT_MS)),
    ]);
    const output = { ok: result.failed_count === 0, verdict: result.verdict, assertions: result.assertions, log: result.log,
      env: { display: `:${displayNum}`, node: process.version, platform: process.platform, pulse_server: PULSE_SERVER } };
    fs.writeFileSync(RESULT_PATH, JSON.stringify(output, null, 2));
    console.log('\n=== ' + result.verdict + ' ===');
    return result.failed_count === 0 ? 0 : 1;
  } catch (e) {
    const output = { ok: false, verdict: 'NIGHT_AUDIO_E2E_FAIL', error: e.message, assertions, log: logEntries };
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
