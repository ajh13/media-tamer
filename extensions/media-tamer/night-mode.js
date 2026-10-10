/**
 * Video Number Guard — Night Mode audio graph helper.
 *
 * Classic content script (no ES module exports, no build step).
 * Runs in isolated content-script world; VC_NIGHT_MODE is a var global
 * in that scope, NOT window (page API).
 *
 * Factory create(context) returns a parallel dry/wet compression helper:
 *   input -> dryGain -> output  (dry path, unity at bypass)
 *   input -> compressor -> wetGain -> output  (wet path)
 *
 * Volume worker owns the media element source and connects:
 *   source -> helper.input, helper.output -> existingGain -> destination
 *
 * Parent may add final peak protection AFTER helper.output via
 * createOutputProtection(context).
 *
 * No automatic makeup gain. Bypass = strength 0 = unity dry route.
 * Short gain ramps on dry/wet avoid jumps/clicks.
 */
/* exported VC_NIGHT_MODE */
const VC_NIGHT_MODE = (() => {
  'use strict';
  const VC_NIGHT_MODE = {
    PRESETS: Object.freeze({
      OFF: 0,
      LIGHT: 35,
      STRONG: 70,
    }),
    MIN_STRENGTH: 0,
    MAX_STRENGTH: 100,
    DEFAULT_STRENGTH: 0,
    // Candidate compressor base parameters (not fixed at all strengths)
    BASE_THRESHOLD: -24,
    BASE_RATIO: 4,
    BASE_KNEE: 12,
    BASE_ATTACK: 0.005,
    BASE_RELEASE: 0.25,
    // Gain ramp time constant for click-free dry/wet transitions
    RAMP_TIME: 0.02,
  };

  /**
   * Validate and clamp strength to [0, 100].
   * Returns null for invalid input (non-finite, non-number).
   * @param {*} value
   * @returns {number|null}
   */
  function normalizeStrength(value) {
    if (typeof value !== 'number') return null;
    if (!Number.isFinite(value)) return null;
    if (value < VC_NIGHT_MODE.MIN_STRENGTH) return VC_NIGHT_MODE.MIN_STRENGTH;
    if (value > VC_NIGHT_MODE.MAX_STRENGTH) return VC_NIGHT_MODE.MAX_STRENGTH;
    return value;
  }

  /**
   * Map strength [0,100] to compressor parameters.
   * At strength 0: neutral (threshold=0, ratio=1, no compression).
   * At strength 100: full base parameters.
   * @param {number} strength — validated 0-100
   * @returns {{threshold: number, ratio: number, knee: number, attack: number, release: number}}
   */
  function strengthToCompressorParams(strength) {
    if (strength <= 0) {
      return {
        threshold: 0,
        ratio: 1,
        knee: 0,
        attack: VC_NIGHT_MODE.BASE_ATTACK,
        release: VC_NIGHT_MODE.BASE_RELEASE,
      };
    }
    const t = strength / 100;
    return {
      threshold: VC_NIGHT_MODE.BASE_THRESHOLD * t,
      ratio: 1 + (VC_NIGHT_MODE.BASE_RATIO - 1) * t,
      knee: VC_NIGHT_MODE.BASE_KNEE * t,
      attack: VC_NIGHT_MODE.BASE_ATTACK,
      release: VC_NIGHT_MODE.BASE_RELEASE,
    };
  }

  /**
   * Create a night-mode compression helper.
   * @param {AudioContext} context — the AudioContext to create nodes in
   * @returns {{input: AudioNode, output: AudioNode, setStrength: Function, bypass: Function, getStatus: Function, dispose: Function}}
   */
  function create(context) {
    if (
      !context ||
      typeof context.createGain !== 'function' ||
      typeof context.createDynamicsCompressor !== 'function'
    ) {
      throw new Error('create() requires a valid AudioContext');
    }

    const input = context.createGain();
    const output = context.createGain();
    const dryGain = context.createGain();
    const wetGain = context.createGain();
    const compressor = context.createDynamicsCompressor();

    // Initial state: bypassed (unity dry, zero wet)
    dryGain.gain.value = 1;
    wetGain.gain.value = 0;
    compressor.threshold.value = 0;
    compressor.ratio.value = 1;
    compressor.knee.value = 0;
    compressor.attack.value = VC_NIGHT_MODE.BASE_ATTACK;
    compressor.release.value = VC_NIGHT_MODE.BASE_RELEASE;

    // Topology
    input.connect(dryGain);
    dryGain.connect(output);
    input.connect(compressor);
    compressor.connect(wetGain);
    wetGain.connect(output);

    let currentStrength = VC_NIGHT_MODE.DEFAULT_STRENGTH;
    let disposed = false;

    function assertNotDisposed() {
      if (disposed) throw new Error('night-mode helper has been disposed');
    }

    function setStrength(strength) {
      assertNotDisposed();
      const s = normalizeStrength(strength);
      if (s === null) return;
      currentStrength = s;

      const params = strengthToCompressorParams(s);
      const now = context.currentTime;
      const ramp = VC_NIGHT_MODE.RAMP_TIME;

      // Update compressor params
      compressor.threshold.setTargetAtTime(params.threshold, now, ramp);
      compressor.ratio.setTargetAtTime(params.ratio, now, ramp);
      compressor.knee.setTargetAtTime(params.knee, now, ramp);
      compressor.attack.setTargetAtTime(params.attack, now, ramp);
      compressor.release.setTargetAtTime(params.release, now, ramp);

      // The compressor has look-ahead latency. Mixing delayed wet audio with
      // undelayed dry audio continuously causes comb filtering. Crossfade only
      // during enable/bypass transitions; strength controls compressor parameters.
      const wet = s > 0 ? 1 : 0;
      const dry = 1 - wet;
      dryGain.gain.setTargetAtTime(dry, now, ramp);
      wetGain.gain.setTargetAtTime(wet, now, ramp);
    }

    function bypass() {
      assertNotDisposed();
      setStrength(0);
    }

    function getStatus() {
      assertNotDisposed();
      return {
        strength: currentStrength,
        bypassed: currentStrength === 0,
        gainReduction: compressor.reduction || 0,
      };
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      try {
        input.disconnect();
      } catch (_) {}
      try {
        dryGain.disconnect();
      } catch (_) {}
      try {
        compressor.disconnect();
      } catch (_) {}
      try {
        wetGain.disconnect();
      } catch (_) {}
      try {
        output.disconnect();
      } catch (_) {}
    }

    return {
      input,
      output,
      setStrength,
      bypass,
      getStatus,
      dispose,
    };
  }

  /**
   * Create a best-effort output protection stage.
   * Place AFTER user volume gain in the chain.
   * Uses a second high-ratio compressor plus conservative output gain.
   * NOT a true-peak brickwall limiter — clearly best effort, no clipping guarantee.
   * @param {AudioContext} context
   * @returns {{input: AudioNode, output: AudioNode, dispose: Function}}
   */
  function createOutputProtection(context) {
    if (
      !context ||
      typeof context.createGain !== 'function' ||
      typeof context.createDynamicsCompressor !== 'function'
    ) {
      throw new Error('createOutputProtection() requires a valid AudioContext');
    }

    const input = context.createGain();
    const comp = context.createDynamicsCompressor();
    const outGain = context.createGain();
    const output = context.createGain();

    // Conservative protection settings
    comp.threshold.value = -6;
    comp.ratio.value = 12;
    comp.knee.value = 0;
    comp.attack.value = 0.003;
    comp.release.value = 0.1;
    outGain.gain.value = 0.9; // conservative headroom

    input.connect(comp);
    comp.connect(outGain);
    outGain.connect(output);

    let disposed = false;

    function dispose() {
      if (disposed) return;
      disposed = true;
      try {
        input.disconnect();
      } catch (_) {}
      try {
        comp.disconnect();
      } catch (_) {}
      try {
        outGain.disconnect();
      } catch (_) {}
      try {
        output.disconnect();
      } catch (_) {}
    }

    return { input, output, dispose };
  }
  VC_NIGHT_MODE.create = create;
  VC_NIGHT_MODE.createOutputProtection = createOutputProtection;
  return Object.freeze(VC_NIGHT_MODE);
})();
