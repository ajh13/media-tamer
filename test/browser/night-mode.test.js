import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { firefox } from 'playwright';

test(
  'real Firefox OfflineAudioContext: night mode bypass, compression, and finite output',
  { timeout: 60000 },
  async (t) => {
    const browser = await firefox.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.addScriptTag({ path: resolve('extensions/media-tamer/night-mode.js') });
    const result = await page.evaluate(async () => {
      async function render(amplitude, strength, userVolume = 1, protect = false) {
        const sr = 48000,
          ctx = new OfflineAudioContext(1, sr * 3, sr);
        const helper = VC_NIGHT_MODE.create(ctx);
        helper.setStrength(strength);
        const buffer = ctx.createBuffer(1, sr * 3, sr),
          data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++)
          data[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / sr);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = userVolume;
        source.connect(helper.input);
        helper.output.connect(gain);
        if (protect) {
          const p = VC_NIGHT_MODE.createOutputProtection(ctx);
          gain.connect(p.input);
          p.output.connect(ctx.destination);
        } else gain.connect(ctx.destination);
        source.start();
        const output = (await ctx.startRendering()).getChannelData(0);
        let sum = 0,
          peak = 0,
          maxDiff = 0,
          finite = true;
        for (let i = sr; i < output.length; i++) {
          sum += output[i] * output[i];
          peak = Math.max(peak, Math.abs(output[i]));
          maxDiff = Math.max(
            maxDiff,
            Math.abs(output[i] - amplitude * Math.sin((2 * Math.PI * 440 * i) / sr) * userVolume),
          );
          if (!Number.isFinite(output[i])) finite = false;
        }
        return { rms: Math.sqrt(sum / (output.length - sr)), peak, maxDiff, finite };
      }
      const bypass = await render(0.3, 0),
        gain = await render(0.3, 0, 2);
      const quiet = await render(0.03, 100),
        loud = await render(0.7, 100);
      const levels = [];
      for (const s of [0, 35, 70, 100]) levels.push(await render(0.7, s));
      const protection = await render(0.9, 0, 3, true);
      return {
        bypass,
        gain,
        quiet,
        loud,
        levels,
        protection,
        inputRatio: 0.7 / 0.03,
        outputRatio: loud.rms / quiet.rms,
      };
    });
    console.log('Firefox DSP measurements:', JSON.stringify(result));
    assert.ok(result.bypass.maxDiff < 1e-5, 'bypass transparent');
    assert.ok(result.gain.maxDiff < 1e-5, 'volume applied once');
    assert.ok(
      result.outputRatio < result.inputRatio * 0.8,
      'steady-state loud/quiet range reduced',
    );
    for (const level of result.levels) assert.equal(level.finite, true);
    assert.ok(
      result.protection.peak < 2.7,
      'protection reduces boosted peaks; not a brickwall guarantee',
    );
  },
);
