/**
 * Video Number Guard — Volume + Night Mode content script.
 *
 * Classic IIFE content script (no ES module exports, no build step).
 * Runs at document_start in isolated content-script world.
 *
 * Protocol:
 *   VC_VOLUME_SET {percent: int 0..300} → apply volume, return status
 *   VC_VOLUME_GET                        → return current volume status
 *   VC_NIGHT_SET  {strength: int 0..100}→ set night mode, return status
 *   VC_NIGHT_GET                         → return night mode status
 *
 * Audio graph per media element (only when gain path or night active):
 *   MediaElementAudioSource → night.input → night.output → gain → protection → destination
 *
 * Volume owns the source. Never creates a second source for the same element.
 * Night helper (VC_NIGHT_MODE) is optional; if missing, night is unsupported.
 */
(function () {
  'use strict';

  // --- Protocol constants ---
  const VC_VOLUME_SET = 'VC_VOLUME_SET';
  const VC_VOLUME_GET = 'VC_VOLUME_GET';
  const VC_NIGHT_SET = 'VC_NIGHT_SET';
  const VC_NIGHT_GET = 'VC_NIGHT_GET';

  // --- Extension ID (must match manifest.json gecko.id) ---
  const EXT_ID = 'media-tamer@example.invalid';

  // --- Constants ---
  const MIN_PERCENT = 0;
  const MAX_PERCENT = 300;
  const DEFAULT_PERCENT = 100;
  const MIN_NIGHT = 0;
  const MAX_NIGHT = 100;
  const DEFAULT_NIGHT = 0;

  // --- Per-document state ---
  let sharedAudioCtx = null;
  let nightHelper = null;
  let outputProtection = null;
  let currentVolumePercent = DEFAULT_PERCENT;
  let volumeApplied = false;
  let currentNightStrength = DEFAULT_NIGHT;
  let nightApplied = false;
  let lastVolumeResult = null;
  let lastNightResult = null;
  const elementStates = new Map();
  let mediaObserver = null;
  let sequenceCounter = 0;
  let pendingVolumePercent = null;
  let pendingNightStrength = null;
  let interactionListenerAttached = false;

  // --- Sender validation ---
  function isValidSender(sender) {
    if (!sender || typeof sender !== 'object') return false;
    return sender.id === EXT_ID;
  }

  // --- Validation ---
  function validatePercent(value) {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value >= MIN_PERCENT &&
      value <= MAX_PERCENT
    );
  }

  function validateNightStrength(value) {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= MIN_NIGHT &&
      value <= MAX_NIGHT
    );
  }

  // --- Media classification ---
  function classifyMediaElement(el) {
    if (!el) return 'unsafe';
    if (el.mediaKeys) return 'unsafe';
    if (el.__vgHadEncrypted) return 'unsafe';

    try {
      const src = el.currentSrc || el.src;
      if (!src) {
        // No src — MSE or srcObject; treat as gain-eligible
        return 'gain';
      }
      if (typeof src === 'object') {
        // srcObject (MediaStream) — unsafe
        return 'unsafe';
      }
      if (src.startsWith('data:')) {
        // data: URLs can't be routed through WebAudio — reject for gain path
        return 'unsafe';
      }
      // blob: URLs are same-origin by spec — gain-eligible
      if (src.startsWith('blob:')) {
        return 'gain';
      }
      const url = new URL(src, typeof location !== 'undefined' ? location.href : undefined);
      if (typeof location !== 'undefined' && url.origin === location.origin) {
        return 'gain';
      }
      return 'unsafe';
    } catch (_) {
      return 'unsafe';
    }
  }

  // --- Find media elements (including open shadow roots) ---
  function findMediaElements(root) {
    const results = [];
    try {
      if (!root || !root.querySelectorAll) return results;
      const videos = root.querySelectorAll('video');
      for (let i = 0; i < videos.length; i++) results.push(videos[i]);
      const audios = root.querySelectorAll('audio');
      for (let i = 0; i < audios.length; i++) results.push(audios[i]);
      const all = root.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (el && el.shadowRoot) {
          const shadowResults = findMediaElements(el.shadowRoot);
          for (let j = 0; j < shadowResults.length; j++) {
            results.push(shadowResults[j]);
          }
        }
      }
    } catch (_) {}
    return results;
  }

  // --- Element state management ---
  function getOrCreateElementState(el) {
    if (!elementStates.has(el)) {
      elementStates.set(el, {
        source: null,
        gain: null,
        baselineVolume: typeof el.volume === 'number' ? el.volume : 1,
        mode: 'direct',
        srcAtSourceCreation: null,
        needsReloadOnSrcChange: false,
        reloadRequired: false,
      });
    }
    return elementStates.get(el);
  }

  // --- Audio graph management ---
  function ensureAudioContext() {
    if (!sharedAudioCtx) {
      sharedAudioCtx = new AudioContext();
    }
    return sharedAudioCtx;
  }

  function rebuildConnections(el, state) {
    try {
      state.source.disconnect();
    } catch (_) {}
    try {
      state.gain.disconnect();
    } catch (_) {}

    const nightActive = currentNightStrength > 0 && nightHelper;

    if (nightActive) {
      state.source.connect(nightHelper.input);
      nightHelper.output.connect(state.gain);
    } else {
      state.source.connect(state.gain);
    }

    if (outputProtection) {
      state.gain.connect(outputProtection.input);
      outputProtection.output.connect(sharedAudioCtx.destination);
    } else {
      state.gain.connect(sharedAudioCtx.destination);
    }
  }

  // --- Interaction-driven AudioContext resume ---
  // Firefox suspends AudioContext in content scripts until the user interacts
  // with the page. We listen for the first real page interaction and retry any
  // pending volume/night command once AudioContext is running.
  function attachInteractionListener() {
    if (interactionListenerAttached) return;
    interactionListenerAttached = true;
    async function onInteract() {
      if (sharedAudioCtx && (pendingVolumePercent != null || pendingNightStrength != null)) {
        // Resume is itself called from a trusted gesture (real page click),
        // satisfying the browser's user-gesture requirement for AudioContext.
        if (sharedAudioCtx.state === 'suspended') {
          await sharedAudioCtx.resume();
          // AudioContext state transition is async — poll briefly.
          await new Promise((resolve) => {
            if (sharedAudioCtx.state === 'running') return resolve();
            const handler = () => {
              sharedAudioCtx.removeEventListener('statechange', handler);
              resolve();
            };
            sharedAudioCtx.addEventListener('statechange', handler);
            // Safety net: don't block forever if state never changes
            setTimeout(() => {
              sharedAudioCtx.removeEventListener('statechange', handler);
              resolve();
            }, 1000);
          });
        }
        if (sharedAudioCtx.state !== 'running') return;

        // Clear pending BEFORE applying to avoid recursion loops
        const vol = pendingVolumePercent;
        const night = pendingNightStrength;
        pendingVolumePercent = null;
        pendingNightStrength = null;
        if (vol != null) {
          const volResult = applyVolumeToDocument(vol);
          lastVolumeResult = volResult;
        }
        if (night != null) {
          applyNightToDocument(night);
          if (nightHelper) {
            try {
              const helperStatus = nightHelper.getStatus();
              const elements = findMediaElements(document);
              let count = 0;
              for (const el of elements) {
                const state = elementStates.get(el);
                if (state && state.source) count++;
              }
              lastNightResult = {
                strength: currentNightStrength,
                active: currentNightStrength > 0,
                count,
                status: 'ok',
                reduction: helperStatus.gainReduction,
              };
            } catch (_) {}
          }
        }
      }
    }
    try {
      window.addEventListener('click', onInteract, { capture: true, once: false });
      window.addEventListener('touchstart', onInteract, { capture: true, once: false });
      window.addEventListener('keydown', onInteract, { capture: true, once: false });
    } catch (_) {}
  }

  function applyNightToDocument(strength) {
    try {
      if (sharedAudioCtx.state === 'suspended') return;
      if (!nightHelper) {
        nightHelper = VC_NIGHT_MODE.create(sharedAudioCtx);
      }
      nightHelper.setStrength(strength);

      // Create output protection if available
      if (!outputProtection && typeof VC_NIGHT_MODE.createOutputProtection === 'function') {
        try {
          outputProtection = VC_NIGHT_MODE.createOutputProtection(sharedAudioCtx);
        } catch (_) {}
      }

      // Ensure all media elements have gain paths routed through the night
      // helper. Without this, the night compressor exists but no audio flows
      // through it (sources were never created for elements in direct mode).
      applyVolumeToDocument(currentVolumePercent);
    } catch (_) {}
  }

  function ensureGraph(el, state) {
    if (!state.source) {
      state.source = sharedAudioCtx.createMediaElementSource(el);
      state.srcAtSourceCreation = el.currentSrc || el.src || null;
      state.needsReloadOnSrcChange = true;
    }
    if (!state.gain) {
      state.gain = sharedAudioCtx.createGain();
    }
    rebuildConnections(el, state);
  }

  // --- Apply volume to a single element ---
  function applyVolumeToElement(el, percent) {
    const multiplier = percent / 100;
    const state = getOrCreateElementState(el);

    // Respect site mute
    if (el.muted) {
      return { status: 'unsupported', applied: 0, muted: true };
    }

    const classification = classifyMediaElement(el);
    const nightActive = currentNightStrength > 0;
    const needsGainPath = percent > 100 || nightActive;

    if (!needsGainPath) {
      // Direct mode: adjust el.volume relative to baseline
      if (state.gain) {
        // Reset gain to avoid hidden boost
        state.gain.gain.value = 1.0;
      }
      const targetVolume = Math.min(1, Math.max(0, state.baselineVolume * multiplier));
      el.__vgOwnChange = true;
      el.volume = targetVolume;
      state.mode = 'direct';
      return { status: 'ok', applied: percent, method: 'direct' };
    }

    // Gain path needed
    if (classification === 'unsafe') {
      // Can't create gain path; fall back to direct at max
      if (state.gain) {
        state.gain.gain.value = 1.0;
      }
      el.__vgOwnChange = true;
      el.volume = state.baselineVolume;
      state.mode = 'direct';
      return { status: 'unsupported', applied: 100, method: 'unsupported' };
    }

    // Ensure AudioContext is running
    try {
      ensureAudioContext();
    } catch (e) {
      return { status: 'error', applied: null, error: String(e) };
    }

    if (sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume().catch(() => {});
      pendingVolumePercent = percent;
      attachInteractionListener();
      return {
        status: 'unsupported',
        applied: 100,
        needsInteraction: true,
        error: 'AudioContext suspended, needs interaction',
      };
    }

    // Build graph
    try {
      ensureGraph(el, state);
    } catch (e) {
      return { status: 'error', applied: null, error: String(e) };
    }

    // Apply via gain
    el.__vgOwnChange = true;
    el.volume = state.baselineVolume;
    state.gain.gain.value = multiplier;
    state.mode = 'gain';

    return { status: 'ok', applied: percent, method: 'gain' };
  }

  // --- Compute overall status ---
  function getVolumeStatus(count, total, hasError, needsInteraction) {
    if (total === 0) return 'idle';
    if (count === 0 && hasError) return 'error';
    if (count === 0) return 'unsupported';
    if (count < total || hasError) return 'partial';
    if (needsInteraction) return 'partial';
    return 'ok';
  }

  // --- Apply volume to all media ---
  function applyVolumeToDocument(percent) {
    const elements = findMediaElements(document);
    let count = 0;
    let appliedSum = 0;
    let anyError = false;
    let lastError = null;
    let needsInteraction = false;

    for (const el of elements) {
      const result = applyVolumeToElement(el, percent);
      if (result.status === 'ok') {
        count++;
        appliedSum += result.applied;
      } else if (result.status === 'error') {
        anyError = true;
        lastError = result.error;
      } else if (result.status === 'unsupported' && result.needsInteraction) {
        needsInteraction = true;
      }
    }

    const appliedPercent = count > 0 ? appliedSum / count : null;
    const status = getVolumeStatus(count, elements.length, anyError, needsInteraction);

    return {
      percent,
      appliedPercent,
      count,
      status,
      error: lastError,
      needsInteraction: needsInteraction || undefined,
    };
  }

  // --- Volume SET handler ---
  async function handleVolumeSet(message) {
    const seq = ++sequenceCounter;
    const percent = message.percent;

    if (!validatePercent(percent)) {
      return {
        percent: null,
        appliedPercent: null,
        count: 0,
        status: 'error',
        error: 'invalid percent',
      };
    }

    // Yield to allow stale commands to be detected
    await Promise.resolve();

    // Stale check
    if (seq !== sequenceCounter) {
      return {
        percent,
        appliedPercent: null,
        count: 0,
        status: 'error',
        error: 'stale command',
      };
    }

    currentVolumePercent = percent;
    volumeApplied = true;
    pendingVolumePercent = null;

    const result = applyVolumeToDocument(percent);
    lastVolumeResult = result;
    return result;
  }

  // --- Volume GET handler ---
  function handleVolumeGet() {
    if (!volumeApplied || !lastVolumeResult) {
      const elements = findMediaElements(document);
      return {
        percent: currentVolumePercent,
        appliedPercent: null,
        count: elements.length,
        status: 'idle',
      };
    }
    return lastVolumeResult;
  }

  // --- Night SET handler ---
  async function handleNightSet(message) {
    const seq = ++sequenceCounter;
    const strength = message.strength;

    if (!validateNightStrength(strength)) {
      return {
        strength: null,
        active: false,
        count: 0,
        status: 'error',
        error: 'invalid night strength',
      };
    }

    await Promise.resolve();

    if (seq !== sequenceCounter) {
      return {
        strength,
        active: false,
        count: 0,
        status: 'error',
        error: 'stale command',
      };
    }

    currentNightStrength = strength;
    nightApplied = true;
    pendingNightStrength = null;

    // Check if night helper is available
    if (typeof VC_NIGHT_MODE === 'undefined' || typeof VC_NIGHT_MODE.create !== 'function') {
      const result = {
        strength,
        active: false,
        count: 0,
        status: 'unsupported',
        error: 'night-mode helper unavailable',
      };
      return result;
    }

    // Strength 0 disables night — no audio processing needed, AudioContext
    // state is irrelevant. Clear any stale pending and report cleanly.
    if (strength === 0) {
      pendingNightStrength = null;
      if (nightHelper) {
        try {
          nightHelper.setStrength(0);
        } catch (_) {}
      }
      const result = {
        strength: 0,
        active: false,
        count: 0,
        status: 'ok',
      };
      lastNightResult = result;
      return result;
    }

    try {
      ensureAudioContext();

      if (sharedAudioCtx.state === 'suspended') {
        sharedAudioCtx.resume().catch(() => {});
        pendingNightStrength = strength;
        attachInteractionListener();
        const result = {
          strength,
          active: false,
          count: 0,
          status: 'unsupported',
          error: 'AudioContext suspended, needs interaction',
          needsInteraction: true,
        };
        lastNightResult = result;
        return result;
      }

      // Create night helper if needed
      if (!nightHelper) {
        nightHelper = VC_NIGHT_MODE.create(sharedAudioCtx);
      }

      nightHelper.setStrength(strength);

      // Create output protection if available
      if (!outputProtection && typeof VC_NIGHT_MODE.createOutputProtection === 'function') {
        try {
          outputProtection = VC_NIGHT_MODE.createOutputProtection(sharedAudioCtx);
        } catch (_) {}
      }

      // Ensure all media elements have gain paths routed through night.
      // Elements in direct mode (no source yet) won't have audio flowing
      // through the night helper unless we create their gain paths here.
      applyVolumeToDocument(currentVolumePercent);

      // Count elements with active sources
      const elements = findMediaElements(document);
      let count = 0;
      for (const el of elements) {
        const state = elementStates.get(el);
        if (state && state.source) count++;
      }

      const helperStatus = nightHelper.getStatus();
      const result = {
        strength,
        active: strength > 0,
        count,
        status: 'ok',
        reduction: helperStatus.gainReduction,
      };
      lastNightResult = result;
      return result;
    } catch (e) {
      const result = {
        strength,
        active: false,
        count: 0,
        status: 'error',
        error: String(e),
      };
      return result;
    }
  }

  // --- Night GET handler ---
  function handleNightGet() {
    if (!nightApplied) {
      return {
        strength: currentNightStrength,
        active: false,
        count: 0,
        status: 'idle',
      };
    }

    // Pending but not yet applied (AudioContext was suspended at SET time)
    if (!nightHelper && lastNightResult) {
      return lastNightResult;
    }

    try {
      const helperStatus = nightHelper.getStatus();
      const elements = findMediaElements(document);
      let count = 0;
      for (const el of elements) {
        const state = elementStates.get(el);
        if (state && state.source) count++;
      }

      return {
        strength: currentNightStrength,
        active: currentNightStrength > 0,
        count,
        status: 'ok',
        reduction: helperStatus.gainReduction,
      };
    } catch (e) {
      return {
        strength: currentNightStrength,
        active: false,
        count: 0,
        status: 'error',
        error: String(e),
      };
    }
  }

  // --- Message handler ---
  function onMessage(message, sender, sendResponse) {
    if (!isValidSender(sender)) return;

    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case VC_VOLUME_SET:
        handleVolumeSet(message).then(function (resp) {
          try {
            sendResponse(resp);
          } catch (_) {}
        });
        return true;

      case VC_VOLUME_GET:
        sendResponse(handleVolumeGet());
        return true;

      case VC_NIGHT_SET:
        handleNightSet(message).then(function (resp) {
          try {
            sendResponse(resp);
          } catch (_) {}
        });
        return true;

      case VC_NIGHT_GET:
        sendResponse(handleNightGet());
        return true;

      default:
        return;
    }
  }

  // --- MutationObserver for dynamic media ---
  function ensureMediaObserver() {
    if (mediaObserver) return;
    var refresh = debounce(function () {
      var elements = findMediaElements(document);
      var currentSet = new Set(elements);
      var iterator = elementStates.entries();
      var entry;
      while (!(entry = iterator.next()).done) {
        var el = entry.value[0];
        var state = entry.value[1];
        if (!currentSet.has(el)) {
          elementStates.delete(el);
        } else if (state.needsReloadOnSrcChange) {
          var currentSrc = el.currentSrc || el.src || '';
          if (currentSrc !== state.srcAtSourceCreation) {
            state.reloadRequired = true;
          }
        }
      }
    }, 100);
    mediaObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].type === 'childList') {
          refresh();
          return;
        }
      }
    });
    if (document.documentElement) {
      mediaObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
  }

  function debounce(fn, wait) {
    var timer = null;
    return function debounced() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn();
      }, wait);
    };
  }

  // --- Init ---
  function init() {
    browser.runtime.onMessage.addListener(onMessage);
    ensureMediaObserver();
  }

  // --- Start (only in browser context) ---
  if (typeof browser !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
