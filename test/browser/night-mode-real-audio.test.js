import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { firefox } from 'playwright';

const SCRATCH = process.env.VC_AUDIO_E2E_PULSE_RUN || '.tmp/audio-e2e/pulse-run';

function ffEnv() {
  return {
    ...process.env,
    PULSE_SERVER: `${SCRATCH}/socket`,
    LD_LIBRARY_PATH: `${SCRATCH}/modules:${SCRATCH}/../pulse-bin/usr/lib/x86_64-linux-gnu/pulseaudio:${SCRATCH}/../pulse-bin/usr/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu/pulseaudio:/usr/lib/x86_64-linux-gnu`,
  };
}

test(
  'Private Pulse null sink: real AudioContext runs in Firefox headless',
  { timeout: 30000 },
  async (t) => {
    const browser = await firefox.launch({ headless: true, env: ffEnv() });
    t.after(() => browser.close());

    const page = await browser.newPage();
    await page.addScriptTag({ path: resolve('extensions/media-tamer/night-mode.js') });

    // Phase 1: BEFORE — AudioContext starts suspended, resume() must succeed (proves sink works)
    const beforeResume = await page.evaluate(async () => {
      const ctx = new AudioContext();
      const s = ctx.state;
      if (s !== 'suspended') return { unexpectedInitialState: s };
      try {
        await ctx.resume();
      } catch (e) {
        return { stateBeforeResume: s, resumeError: e.message };
      }
      return {
        stateBeforeResume: s,
        stateAfterResume: ctx.state,
        running: ctx.state === 'running',
      };
    });
    console.log('Phase 1 — before/after resume:', JSON.stringify(beforeResume));
    assert.equal(
      beforeResume.running,
      true,
      'AudioContext must reach running state via private Pulse sink',
    );

    // Phase 2: Night-mode compression graph on OfflineAudioContext (startRendering only exists there)
    const result = await page.evaluate(async () => {
      const sr = 48000;
      const ctx = new OfflineAudioContext(1, sr * 3, sr);

      const helper = VC_NIGHT_MODE.create(ctx);
      helper.setStrength(70);

      const buffer = ctx.createBuffer(1, sr * 3, sr);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = 1.0;
      const protect = VC_NIGHT_MODE.createOutputProtection(ctx);

      source.connect(helper.input);
      helper.output.connect(gain);
      gain.connect(protect.input);
      protect.output.connect(ctx.destination);

      source.start();
      const output = (await ctx.startRendering()).getChannelData(0);

      let rms = 0,
        peak = 0,
        finite = true;
      for (let i = sr; i < output.length; i++) {
        rms += output[i] * output[i];
        peak = Math.max(peak, Math.abs(output[i]));
        if (!Number.isFinite(output[i])) finite = false;
      }
      rms = Math.sqrt(rms / (output.length - sr));

      return { rms, peak, finite, status: helper.getStatus() };
    });
    console.log('Phase 2 — night-mode graph:', JSON.stringify(result));

    assert.ok(result.finite, 'Output samples must be finite');
    assert.ok(result.rms > 0, 'Output must have non-zero RMS');
    assert.equal(result.status.bypassed, false, 'Compressor must be active at strength=70');
    assert.ok(
      result.status.gainReduction < 0,
      'Compressor reports gain reduction (negative dB) when active',
    );
  },
);
