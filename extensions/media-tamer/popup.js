/**
 * Media Tamer — Popup script (IIFE, classic script, no ES modules).
 *
 * Firefox MV2 page_action popup. Compact drag-surface sliders.
 * Sends commands to background, awaits real responses, renders honest state.
 *
 * Tab target captured at popup open, held constant. Controls disabled until
 * initial GET responses arrive. Rapid slider updates are sequenced per-control.
 *
 * Settings: appearance (system/light/dark) persisted in browser.storage.local.
 * Reset all: volume=100, peaks=0, speed=1 for current tab, cancels pending.
 */
(function () {
  'use strict';

  // --- Protocol constants (must match background.js) ---
  const VC = {
    VOLUME_SET: 'VC_VOLUME_SET',
    VOLUME_GET: 'VC_VOLUME_GET',
    SPEED_SET: 'VC_SPEED_SET',
    SPEED_GET: 'VC_SPEED_GET',
    NIGHT_SET: 'VC_NIGHT_SET',
    NIGHT_GET: 'VC_NIGHT_GET',
    RESET_ALL: 'VC_RESET_ALL',
    SEEK_CONFIG: 'VC_SEEK_CONFIG',
    SEEK_GET: 'VC_SEEK_GET',
    SEEK_UNDO: 'VC_SEEK_UNDO',
    MEDIA_ROLLER_DOWNLOAD: 'VC_MEDIA_ROLLER_DOWNLOAD',
    MEDIA_ROLLER_CONFIG: 'VC_MEDIA_ROLLER_CONFIG',
    MEDIA_ROLLER_GET: 'VC_MEDIA_ROLLER_GET',
    APPEARANCE_GET: 'VC_APPEARANCE_GET',
    APPEARANCE_SET: 'VC_APPEARANCE_SET',
  };

  const DEF = {
    VOLUME: 100,
    SPEED: 1,
    NIGHT: 0,
    SEEK_BINDING: { key: 'z', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
  };

  // --- State ---
  let currentTabId = null;
  let seekBinding = { ...DEF.SEEK_BINDING };
  let seekCanUndo = false;
  let capturingKey = false;
  // Per-control sequencing
  let seqVolume = 0;
  let seqSpeed = 0;
  let seqNight = 0;
  let el = {};

  // --- DOM helpers ---
  function $(id) {
    return document.getElementById(id);
  }

  // --- Formatting ---
  function fmtVolume(pct) {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return '\u2014';
    return `${Math.round(pct)}%`;
  }

  function fmtSpeed(spd) {
    if (typeof spd !== 'number' || !Number.isFinite(spd)) return '\u2014';
    return `${spd.toFixed(2)}x`;
  }

  function fmtNight(str) {
    if (typeof str !== 'number' || !Number.isFinite(str)) return '\u2014';
    if (str <= 0) return 'Off';
    return `${Math.round(str)}%`;
  }

  function fmtBinding(b) {
    if (!b) return '\u2014';
    const parts = [];
    if (b.ctrlKey) parts.push('Ctrl');
    if (b.altKey) parts.push('Alt');
    if (b.shiftKey) parts.push('Shift');
    if (b.metaKey) parts.push('Meta');
    parts.push(b.key.length === 1 ? b.key.toUpperCase() : b.key);
    return parts.join('+');
  }

  // --- Send command to background, await response ---
  async function sendCommand(msg) {
    try {
      return await browser.runtime.sendMessage(msg);
    } catch (_) {
      return { error: String(_) };
    }
  }

  // --- Sequenced update per control ---
  async function sequencedVolume(msg, renderFn) {
    seqVolume++;
    const mySeq = seqVolume;
    const resp = await sendCommand(msg);
    if (mySeq === seqVolume) renderFn(resp);
  }

  async function sequencedSpeed(msg, renderFn) {
    seqSpeed++;
    const mySeq = seqSpeed;
    const resp = await sendCommand(msg);
    if (mySeq === seqSpeed) renderFn(resp);
  }

  async function sequencedNight(msg, renderFn) {
    seqNight++;
    const mySeq = seqNight;
    const resp = await sendCommand(msg);
    if (mySeq === seqNight) renderFn(resp);
  }

  // --- Idle status detection: hide "No media", "Off", "—" strips ---
  function isIdleStatus(text) {
    if (!text) return true;
    const t = text.trim();
    return t === 'No media' || t === 'Off' || t === '—' || t === '' || t === '\u2014';
  }

  function updateStatusAreaVisibility() {
    const area = el.statusArea;
    if (!area) return;
    const statuses = [el.volumeStatus, el.peaksStatus, el.speedStatus, el.mrStatus];
    const hasRealContent = statuses.some(
      (s) => s && s.dataset.status !== 'ok' && s.textContent && !isIdleStatus(s.textContent),
    );
    area.hidden = !hasRealContent;
  }

  // --- Render volume response ---
  function renderVolume(resp) {
    const statusEl = el.volumeStatus;
    const slider = el.volumeSlider;
    const valueEl = el.volumeValue;
    const surface = el.volumeSurface;

    if (!resp || resp.error) {
      if (statusEl) {
        statusEl.textContent = resp && resp.error ? `${resp.error}` : 'No media';
        statusEl.dataset.status = resp && resp.error ? 'error' : '';
      }
      updateStatusAreaVisibility();
      return;
    }

    if (resp.status === 'unsupported' || resp.count === 0) {
      if (statusEl) {
        statusEl.textContent = 'No media';
        statusEl.dataset.status = '';
      }
    } else if (resp.status === 'partial') {
      const applied = resp.appliedPercent;
      if (statusEl) {
        statusEl.textContent = applied != null ? `Mixed (${applied}%)` : 'Mixed';
        statusEl.dataset.status = '';
      }
      if (slider && applied != null) slider.value = String(applied);
      if (surface && applied != null)
        surface.style.setProperty('--pct', `${(applied / 300) * 100}%`);
      if (valueEl) valueEl.textContent = fmtVolume(applied);
    } else {
      const applied = resp.appliedPercent != null ? resp.appliedPercent : resp.percent;
      if (statusEl) {
        statusEl.textContent = `Applied: ${applied}%`;
        statusEl.dataset.status = 'ok';
      }
      if (slider && applied != null) slider.value = String(applied);
      if (surface && applied != null)
        surface.style.setProperty('--pct', `${(applied / 300) * 100}%`);
      if (valueEl) valueEl.textContent = fmtVolume(applied);
    }
    updateStatusAreaVisibility();
  }

  // --- Render speed response ---
  function renderSpeed(resp) {
    const statusEl = el.speedStatus;
    const slider = el.speedSlider;
    const valueEl = el.speedValue;
    const surface = el.speedSurface;

    if (!resp || resp.error) {
      if (statusEl) {
        statusEl.textContent = resp && resp.error ? `${resp.error}` : 'No media';
        statusEl.dataset.status = resp && resp.error ? 'error' : '';
      }
      updateStatusAreaVisibility();
      return;
    }

    if (resp.status === 'unsupported' || resp.count === 0) {
      if (statusEl) {
        statusEl.textContent = 'No media';
        statusEl.dataset.status = '';
      }
    } else if (resp.status === 'partial') {
      const applied = resp.appliedSpeed;
      if (statusEl) {
        statusEl.textContent = applied != null ? `Mixed (${fmtSpeed(applied)})` : 'Mixed';
        statusEl.dataset.status = '';
      }
      if (slider && applied != null) slider.value = String(applied);
      if (surface && applied != null) {
        surface.style.setProperty('--pct', `${((applied - 0.25) / (3 - 0.25)) * 100}%`);
      }
      if (valueEl) valueEl.textContent = fmtSpeed(applied);
    } else {
      const applied = resp.appliedSpeed != null ? resp.appliedSpeed : resp.speed;
      if (statusEl) {
        statusEl.textContent = `Applied: ${fmtSpeed(applied)}${resp.clamp ? ' (clamped)' : ''}`;
        statusEl.dataset.status = 'ok';
      }
      if (slider && applied != null) slider.value = String(applied);
      if (surface && applied != null) {
        surface.style.setProperty('--pct', `${((applied - 0.25) / (3 - 0.25)) * 100}%`);
      }
      if (valueEl) valueEl.textContent = fmtSpeed(applied);
    }
    updateStatusAreaVisibility();
  }

  // --- Render peaks (night mode) response ---
  function renderPeaks(resp) {
    const statusEl = el.peaksStatus;
    const slider = el.peaksSlider;
    const valueEl = el.peaksValue;
    const surface = el.peaksSurface;

    if (!resp) {
      if (statusEl) {
        statusEl.textContent = 'Off';
        statusEl.dataset.status = 'error';
      }
      updateStatusAreaVisibility();
      return;
    }

    // Pending activation: needsInteraction without strength applied yet.
    if (resp.needsInteraction && resp.strength > 0) {
      if (statusEl) {
        statusEl.textContent = `Click the video to activate ${resp.strength}%`;
        statusEl.dataset.status = '';
      }
      if (slider) slider.value = String(resp.strength);
      if (surface) surface.style.setProperty('--pct', `${resp.strength}%`);
      if (valueEl) valueEl.textContent = fmtNight(resp.strength);
      updateStatusAreaVisibility();
      return;
    }

    if (resp.error) {
      if (statusEl) {
        statusEl.textContent = resp.error;
        statusEl.dataset.status = 'error';
      }
      updateStatusAreaVisibility();
      return;
    }

    if (resp.status === 'unsupported' || resp.count === 0) {
      if (statusEl) {
        statusEl.textContent = 'Off';
        statusEl.dataset.status = '';
      }
      if (slider && resp.strength != null) slider.value = String(resp.strength);
      if (surface && resp.strength != null) surface.style.setProperty('--pct', `${resp.strength}%`);
      if (valueEl) valueEl.textContent = fmtNight(resp.strength);
    } else if (resp.status === 'partial') {
      if (statusEl) {
        statusEl.textContent = 'Partial';
        statusEl.dataset.status = '';
      }
      if (slider && resp.strength != null) slider.value = String(resp.strength);
      if (surface && resp.strength != null) surface.style.setProperty('--pct', `${resp.strength}%`);
      if (valueEl) valueEl.textContent = fmtNight(resp.strength);
    } else {
      if (statusEl) {
        statusEl.textContent = resp.active ? `Active: ${resp.strength}%` : 'Off';
        statusEl.dataset.status = resp.active ? 'ok' : '';
      }
      if (slider && resp.strength != null) slider.value = String(resp.strength);
      if (surface && resp.strength != null) surface.style.setProperty('--pct', `${resp.strength}%`);
      if (valueEl) valueEl.textContent = fmtNight(resp.strength);
    }
    updateStatusAreaVisibility();
  }

  // --- Render seek response ---
  function renderSeek(resp) {
    if (resp && resp.binding) {
      seekBinding = resp.binding;
    }
    if (resp) {
      seekCanUndo = !!resp.canUndo;
    }
    if (el.seekBinding) el.seekBinding.textContent = fmtBinding(seekBinding);
    if (el.seekUndo) {
      el.seekUndo.disabled = !seekCanUndo;
      el.seekUndo.textContent = seekCanUndo ? '↶ Undo seek' : '↶ Undo seek';
    }
  }

  // --- Disable/enable controls ---
  function setControlsDisabled(disabled) {
    const ctrls = [
      el.volumeSlider,
      el.speedSlider,
      el.peaksSlider,
      el.seekCapture,
      el.resetAll,
      el.settingsToggle,
      el.mrDownload,
      el.mrSave,
    ];
    for (const c of ctrls) {
      if (c) c.disabled = disabled;
    }
    // seekUndo is managed separately by renderSeek based on seekCanUndo
    // Disable step buttons
    const steps = document.querySelectorAll('.step');
    for (const s of steps) {
      s.disabled = disabled;
    }
    // Disable action buttons (except seekUndo which is managed by renderSeek)
    const actionBtns = document.querySelectorAll('.action-btn');
    for (const b of actionBtns) {
      if (b.id !== 'seek-undo') b.disabled = disabled;
    }
  }

  // --- Volume control ---
  function setVolume(v) {
    const p = Math.max(0, Math.min(300, Math.round(v)));
    if (el.volumeValue) el.volumeValue.textContent = fmtVolume(p);
    if (el.volumeSlider) el.volumeSlider.value = String(p);
    if (el.volumeSurface) el.volumeSurface.style.setProperty('--pct', `${(p / 300) * 100}%`);
    return p;
  }

  function onVolumeInput(e) {
    const p = parseInt(e.target.value, 10);
    if (isNaN(p)) return;
    setVolume(p);
    if (currentTabId != null) {
      sequencedVolume({ type: VC.VOLUME_SET, percent: p, tabId: currentTabId }, renderVolume);
    }
  }

  function onVolumeStep(delta) {
    const p = parseInt(el.volumeSlider.value, 10) || DEF.VOLUME;
    const newVal = setVolume(p + delta);
    if (currentTabId != null) {
      sequencedVolume({ type: VC.VOLUME_SET, percent: newVal, tabId: currentTabId }, renderVolume);
    }
  }

  // --- Peaks (night) control ---
  function setPeaks(v) {
    const n = Math.max(0, Math.min(100, Math.round(v)));
    if (el.peaksValue) el.peaksValue.textContent = fmtNight(n);
    if (el.peaksSlider) el.peaksSlider.value = String(n);
    if (el.peaksSurface) el.peaksSurface.style.setProperty('--pct', `${n}%`);
    return n;
  }

  function onPeaksInput(e) {
    const n = parseInt(e.target.value, 10);
    if (isNaN(n)) return;
    setPeaks(n);
    if (currentTabId != null) {
      sequencedNight({ type: VC.NIGHT_SET, strength: n, tabId: currentTabId }, renderPeaks);
    }
  }

  function onPeaksStep(delta) {
    const n = parseInt(el.peaksSlider.value, 10) || DEF.NIGHT;
    const newVal = setPeaks(n + delta);
    if (currentTabId != null) {
      sequencedNight({ type: VC.NIGHT_SET, strength: newVal, tabId: currentTabId }, renderPeaks);
    }
  }

  // --- Speed control ---
  function setSpeed(v) {
    let s = Math.max(0.25, Math.min(3, Math.round(v * 100) / 100));
    if (el.speedValue) el.speedValue.textContent = fmtSpeed(s);
    if (el.speedSlider) el.speedSlider.value = String(s);
    if (el.speedSurface)
      el.speedSurface.style.setProperty('--pct', `${((s - 0.25) / (3 - 0.25)) * 100}%`);
    return s;
  }

  function onSpeedInput(e) {
    const s = parseFloat(e.target.value);
    if (isNaN(s)) return;
    setSpeed(s);
    if (currentTabId != null) {
      sequencedSpeed({ type: VC.SPEED_SET, speed: s, tabId: currentTabId }, renderSpeed);
    }
  }

  function onSpeedStep(delta) {
    const s = parseFloat(el.speedSlider.value) || DEF.SPEED;
    const newVal = setSpeed(s + delta);
    if (currentTabId != null) {
      sequencedSpeed({ type: VC.SPEED_SET, speed: newVal, tabId: currentTabId }, renderSpeed);
    }
  }

  // --- Reset all: volume=100, peaks=0, speed=1 for current tab ---
  function onResetAll() {
    if (currentTabId == null) return;
    setVolume(DEF.VOLUME);
    setPeaks(DEF.NIGHT);
    setSpeed(DEF.SPEED);
    // Send individual resets — background handles cancelling pending safely
    sequencedVolume(
      { type: VC.VOLUME_SET, percent: DEF.VOLUME, tabId: currentTabId },
      renderVolume,
    );
    sequencedSpeed({ type: VC.SPEED_SET, speed: DEF.SPEED, tabId: currentTabId }, renderSpeed);
    sequencedNight({ type: VC.NIGHT_SET, strength: DEF.NIGHT, tabId: currentTabId }, renderPeaks);
  }

  // --- Single-control reset (double-click) ---
  function onResetSingleVolume() {
    if (currentTabId == null) return;
    setVolume(DEF.VOLUME);
    sequencedVolume(
      { type: VC.VOLUME_SET, percent: DEF.VOLUME, tabId: currentTabId },
      renderVolume,
    );
  }

  function onResetSinglePeaks() {
    if (currentTabId == null) return;
    setPeaks(DEF.NIGHT);
    sequencedNight({ type: VC.NIGHT_SET, strength: DEF.NIGHT, tabId: currentTabId }, renderPeaks);
  }

  function onResetSingleSpeed() {
    if (currentTabId == null) return;
    setSpeed(DEF.SPEED);
    sequencedSpeed({ type: VC.SPEED_SET, speed: DEF.SPEED, tabId: currentTabId }, renderSpeed);
  }

  // --- Seek undo ---
  function onSeekUndo() {
    if (currentTabId == null) return;
    sendCommand({ type: VC.SEEK_UNDO, tabId: currentTabId }).then((resp) => {
      if (resp && resp.success) {
        sendCommand({ type: VC.SEEK_GET, tabId: currentTabId }).then(renderSeek);
      }
    });
  }

  // --- Key capture for seek binding ---
  function startKeyCapture() {
    capturingKey = true;
    if (el.seekCapture) {
      el.seekCapture.textContent = 'Press key...';
      el.seekCapture.classList.add('seek-capture');
    }
  }

  function onKeyDownCapture(e) {
    if (!capturingKey) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      capturingKey = false;
      if (el.seekCapture) {
        el.seekCapture.textContent = 'Change';
        el.seekCapture.classList.remove('seek-capture');
      }
      return;
    }

    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const hasModifier = e.ctrlKey || e.altKey || e.metaKey || e.shiftKey;
    if (!hasModifier) {
      if (el.seekCapture) {
        el.seekCapture.textContent = 'Needs Ctrl/Alt/Meta/Shift';
      }
      return;
    }

    const binding = {
      key: e.key,
      ctrlKey: !!e.ctrlKey,
      altKey: !!e.altKey,
      shiftKey: !!e.shiftKey,
      metaKey: !!e.metaKey,
    };

    capturingKey = false;
    if (el.seekCapture) {
      el.seekCapture.textContent = 'Change';
      el.seekCapture.classList.remove('seek-capture');
    }

    seekBinding = binding;
    if (el.seekBinding) el.seekBinding.textContent = fmtBinding(binding);

    if (currentTabId != null) {
      sendCommand({ type: VC.SEEK_CONFIG, binding, enabled: true, tabId: currentTabId });
    }
  }

  // --- Media Roller ---
  async function onMrSave() {
    const url = el.mrBaseurl ? el.mrBaseurl.value.trim() : '';
    const resp = await sendCommand({ type: VC.MEDIA_ROLLER_CONFIG, baseUrl: url });
    if (resp && resp.status === 'ok') {
      if (el.mrConfigStatus)
        el.mrConfigStatus.textContent = resp.url ? `Saved: ${resp.url}` : 'Cleared';
    } else if (resp) {
      if (el.mrConfigStatus) el.mrConfigStatus.textContent = `${resp.error}`;
    }
  }

  async function onMrDownload() {
    if (currentTabId == null) return;
    if (el.mrStatus) el.mrStatus.textContent = 'Starting...';
    if (el.mrDownload) el.mrDownload.disabled = true;

    try {
      const granted = await browser.permissions.request({
        permissions: ['downloads'],
        data_collection: ['browsingActivity'],
      });
      if (!granted) {
        if (el.mrStatus) el.mrStatus.textContent = 'Permission denied';
        if (el.mrDownload) el.mrDownload.disabled = false;
        return;
      }
    } catch (_) {}

    const resp = await sendCommand({ type: VC.MEDIA_ROLLER_DOWNLOAD, tabId: currentTabId });
    if (!resp) {
      if (el.mrStatus) el.mrStatus.textContent = 'Error: no response';
    } else if (resp.status === 'ok') {
      if (el.mrStatus) el.mrStatus.textContent = `Download started (#${resp.id})`;
    } else if (resp.status === 'permission_required') {
      if (el.mrStatus) el.mrStatus.textContent = 'Permission required';
    } else if (resp.status === 'disabled') {
      if (el.mrStatus) el.mrStatus.textContent = 'Not configured';
    } else if (resp.status === 'in_flight') {
      if (el.mrStatus) el.mrStatus.textContent = 'Already downloading';
    } else {
      if (el.mrStatus) el.mrStatus.textContent = `Error: ${resp.error || 'unknown'}`;
    }
    if (el.mrDownload) el.mrDownload.disabled = false;
  }

  // --- Appearance ---
  function applyAppearance(theme) {
    const html = document.documentElement;
    if (theme === 'system') {
      html.removeAttribute('data-theme');
    } else {
      html.setAttribute('data-theme', theme);
    }
  }

  async function onAppearanceChange(e) {
    const value = e.target.value;
    applyAppearance(value);
    try {
      await browser.storage.local.set({ appearance: value });
    } catch (_) {}
  }

  // --- Settings panel toggle (now <details>) ---
  function toggleSettings() {
    const panel = $('settings-panel');
    const toggle = $('settings-toggle');
    if (panel) {
      panel.open = !panel.open;
      if (toggle) toggle.setAttribute('aria-expanded', String(panel.open));
    }
  }

  // --- Drag-to-adjust on surfaces (relative, no click jump) ---
  // Single click: nothing. Drag from current value: relative delta mapped
  // full range over surface width, with a small threshold to avoid jitter.
  // Double-tap resets (pointerup-based, because preventDefault on pointerdown
  // suppresses native dblclick). The dblclick listener is kept as fallback.
  // Native range input kept for keyboard and programmatic tests.
  const DRAG_THRESHOLD_PX = 4;
  const DOUBLETAP_MAX_DIST_PX = 6;
  const DOUBLETAP_MAX_MS = 350;
  function setupSurfaceDrag(surfaceId, sliderId, setValueFn, resetFn, step) {
    const surface = $(surfaceId);
    const slider = $(sliderId);
    if (!surface || !slider) return;

    let drag = null;
    let lastTap = null; // { x, y, time }

    function pointerMove(e) {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      if (!drag.active && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
      // Invalidate double-tap window on move
      lastTap = null;
      const rect = surface.getBoundingClientRect();
      const width = rect.width || 1;
      const min = parseFloat(slider.min);
      const max = parseFloat(slider.max);
      const range = max - min;
      const raw = drag.startValue + (dx / width) * range;
      const stepped = Math.round(raw / step) * step;
      setValueFn(stepped);
    }

    function pointerUp(e) {
      const wasActive = drag && drag.active;
      const pid = drag && drag.pointerId;
      drag = null;
      slider.releasePointerCapture?.(pid);
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerUp);

      if (!wasActive && resetFn) {
        const now = Date.now();
        const dt = now - (lastTap ? lastTap.time : 0);
        const dxTap = e.clientX - (lastTap ? lastTap.x : e.clientX);
        const dyTap = e.clientY - (lastTap ? lastTap.y : e.clientY);
        const tapDist = Math.sqrt(dxTap * dxTap + dyTap * dyTap);
        if (lastTap && dt <= DOUBLETAP_MAX_MS && tapDist <= DOUBLETAP_MAX_DIST_PX) {
          resetFn();
          lastTap = null;
        } else {
          lastTap = { x: e.clientX, y: e.clientY, time: now };
        }
      } else {
        lastTap = null;
      }
      return wasActive;
    }

    // Pointer events hit the native range input (z-index 4) first.
    // preventDefault stops the native jump-to-click + the input event it fires.
    slider.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      surface.focus();
      const startValue = parseFloat(slider.value);
      drag = { pointerId: e.pointerId, startX: e.clientX, startValue, active: false };
      slider.setPointerCapture(e.pointerId);
      // DO NOT call setValueFn here — prevents click-to-jump
      window.addEventListener('pointermove', pointerMove);
      window.addEventListener('pointerup', pointerUp);
    });

    // Native dblclick handler (kept for JSDOM / synthetic dblclick; not fired in
    // real Firefox because pointerdown.preventDefault suppresses it).
    surface.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (resetFn) resetFn();
    });

    // Keyboard: arrows step by step value, Shift = 10x, Home/End = min/max
    surface.addEventListener('keydown', (e) => {
      let handled = true;
      const cur = parseFloat(slider.value);
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          setValueFn(cur + (e.shiftKey ? step * 10 : step));
          break;
        case 'ArrowLeft':
        case 'ArrowDown':
          setValueFn(cur - (e.shiftKey ? step * 10 : step));
          break;
        case 'Home':
          setValueFn(parseFloat(slider.min));
          break;
        case 'End':
          setValueFn(parseFloat(slider.max));
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    });
  }

  // --- Init ---
  function init() {
    el = {
      volumeSlider: $('volume-slider'),
      volumeValue: $('volume-value'),
      volumeStatus: $('volume-status'),
      volumeSurface: $('volume-surface'),
      peaksSlider: $('peaks-slider'),
      peaksValue: $('peaks-value'),
      peaksStatus: $('peaks-status'),
      peaksSurface: $('peaks-surface'),
      speedSlider: $('speed-slider'),
      speedValue: $('speed-value'),
      speedStatus: $('speed-status'),
      speedSurface: $('speed-surface'),
      seekUndo: $('seek-undo'),
      seekBinding: $('seek-binding'),
      seekCapture: $('seek-capture'),
      mrDownload: $('mr-download'),
      mrStatus: $('mr-status'),
      mrConfigStatus: $('mr-config-status'),
      mrBaseurl: $('mr-baseurl'),
      mrSave: $('mr-save'),
      resetAll: $('reset-all'),
      settingsToggle: $('settings-toggle'),
      appearanceSelect: $('appearance-select'),
      statusArea: $('status-area'),
      blockNumberKeys: $('block-number-keys'),
    };

    // Initialize tick positions from slider defaults
    if (el.volumeSurface) {
      const p = parseInt(el.volumeSlider?.value, 10) || DEF.VOLUME;
      el.volumeSurface.style.setProperty('--pct', `${(p / 300) * 100}%`);
    }
    if (el.peaksSurface) {
      const n = parseInt(el.peaksSlider?.value, 10) || DEF.NIGHT;
      el.peaksSurface.style.setProperty('--pct', `${n}%`);
    }
    if (el.speedSurface) {
      const s = parseFloat(el.speedSlider?.value) || DEF.SPEED;
      el.speedSurface.style.setProperty('--pct', `${((s - 0.25) / (3 - 0.25)) * 100}%`);
    }

    // Load saved appearance preference
    try {
      const savedAppearance = localStorage.getItem('appearance');
      if (savedAppearance) {
        applyAppearance(savedAppearance);
        if (el.appearanceSelect) el.appearanceSelect.value = savedAppearance;
      } else if (browser.storage && browser.storage.local) {
        // Check browser.storage.local for persistence
        browser.storage.local
          .get('appearance')
          .then((data) => {
            if (data && data.appearance) {
              applyAppearance(data.appearance);
              if (el.appearanceSelect) el.appearanceSelect.value = data.appearance;
            }
          })
          .catch(() => {});
      }
    } catch (_) {
      // localStorage may not be available; ignore
    }

    // Load saved block-number-keys setting (default ON if unset).
    // browser.storage.local is the sole source of truth. localStorage is never
    // read for this key (stale popup writes / other-popup races are avoided).
    // The async read cannot overwrite the user's click while loading: the change
    // handler awaits this promise before committing.
    const initialBlockLoad = (async () => {
      if (browser.storage && browser.storage.local) {
        try {
          const data = await browser.storage.local.get('blockNumberKeys');
          if (typeof data.blockNumberKeys === 'boolean' && el.blockNumberKeys) {
            el.blockNumberKeys.checked = data.blockNumberKeys;
          }
        } catch (_) {}
      }
    })();

    setControlsDisabled(true);

    // Capture tab target at popup open
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        if (tabs && tabs[0]) {
          currentTabId = tabs[0].id;
        }
        return Promise.all([
          sendCommand({ type: VC.VOLUME_GET, tabId: currentTabId }),
          sendCommand({ type: VC.SPEED_GET, tabId: currentTabId }),
          sendCommand({ type: VC.NIGHT_GET, tabId: currentTabId }),
          sendCommand({ type: VC.SEEK_GET, tabId: currentTabId }),
        ]);
      })
      .then(([volResp, spdResp, peaksResp, seekResp]) => {
        renderVolume(volResp);
        renderSpeed(spdResp);
        renderPeaks(peaksResp);
        renderSeek(seekResp);
        setControlsDisabled(false);
      })
      .catch(() => {
        setControlsDisabled(false);
      });

    // Wire slider input events
    if (el.volumeSlider) el.volumeSlider.addEventListener('input', onVolumeInput);
    if (el.peaksSlider) el.peaksSlider.addEventListener('input', onPeaksInput);
    if (el.speedSlider) el.speedSlider.addEventListener('input', onSpeedInput);

    // Wire step buttons
    document.querySelectorAll('.row').forEach((row) => {
      const control = row.dataset.control;
      const minus = row.querySelector('.minus');
      const plus = row.querySelector('.plus');
      if (!minus || !plus) return;

      if (control === 'volume') {
        minus.addEventListener('click', () => onVolumeStep(-5));
        plus.addEventListener('click', () => onVolumeStep(5));
      } else if (control === 'peaks') {
        minus.addEventListener('click', () => onPeaksStep(-5));
        plus.addEventListener('click', () => onPeaksStep(5));
      } else if (control === 'speed') {
        minus.addEventListener('click', () => onSpeedStep(-0.05));
        plus.addEventListener('click', () => onSpeedStep(0.05));
      }
    });

    // Setup drag-to-adjust on surfaces (drag = relative; double-tap resets)
    setupSurfaceDrag(
      'volume-surface',
      'volume-slider',
      (v) => {
        const p = setVolume(v);
        if (currentTabId != null) {
          sequencedVolume({ type: VC.VOLUME_SET, percent: p, tabId: currentTabId }, renderVolume);
        }
      },
      onResetSingleVolume,
      1,
    );

    setupSurfaceDrag(
      'peaks-surface',
      'peaks-slider',
      (v) => {
        const n = setPeaks(v);
        if (currentTabId != null) {
          sequencedNight({ type: VC.NIGHT_SET, strength: n, tabId: currentTabId }, renderPeaks);
        }
      },
      onResetSinglePeaks,
      1,
    );

    setupSurfaceDrag(
      'speed-surface',
      'speed-slider',
      (v) => {
        const s = setSpeed(v);
        if (currentTabId != null) {
          sequencedSpeed({ type: VC.SPEED_SET, speed: s, tabId: currentTabId }, renderSpeed);
        }
      },
      onResetSingleSpeed,
      0.05,
    );

    // Button handlers
    if (el.seekUndo) el.seekUndo.addEventListener('click', onSeekUndo);
    if (el.seekCapture) el.seekCapture.addEventListener('click', startKeyCapture);
    if (el.mrDownload) el.mrDownload.addEventListener('click', onMrDownload);
    if (el.mrSave) el.mrSave.addEventListener('click', onMrSave);
    if (el.resetAll) el.resetAll.addEventListener('click', onResetAll);
    if (el.settingsToggle) el.settingsToggle.addEventListener('click', toggleSettings);
    if (el.appearanceSelect) el.appearanceSelect.addEventListener('change', onAppearanceChange);
    // Block number-keys toggle. Awaits the initial storage read so a click during
    // the loading window is not clobbered by the async read-back. On write
    // failure, rolls back the checkbox and surfaces the error honestly (no silent
    // swallow).
    if (el.blockNumberKeys) {
      el.blockNumberKeys.addEventListener('change', (e) => {
        const value = e.target.checked;
        const previous = !value;
        const commit = () => {
          browser.storage.local.set({ blockNumberKeys: value }).catch((err) => {
            if (el.blockNumberKeys) el.blockNumberKeys.checked = previous;
            if (el.blockNumberKeys) {
              const row = el.blockNumberKeys.closest('.seek-row');
              if (row) {
                let status = row.querySelector('.save-error');
                if (!status) {
                  status = document.createElement('span');
                  status.className = 'save-error';
                  status.setAttribute('role', 'status');
                  status.setAttribute('aria-live', 'assertive');
                  row.appendChild(status);
                }
                status.textContent = `Save failed: ${err?.message || err}`;
              }
            }
          });
        };
        // Await initial load to finish so it doesn't overwrite this click
        Promise.resolve(initialBlockLoad).then(commit);
      });
    }

    document.addEventListener('keydown', onKeyDownCapture, true);
  }

  if (
    typeof document !== 'undefined' &&
    typeof browser !== 'undefined' &&
    browser.runtime &&
    browser.runtime.id
  ) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
