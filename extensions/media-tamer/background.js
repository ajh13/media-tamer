/**
 * Media Tamer — Background script (IIFE, classic script, no ES modules).
 *
 * Firefox MV2 page_action extension. Routes popup commands to content scripts,
 * awaits real responses, reports actual applied state. Per-tab in-memory state
 * only (volume=100, speed=1, night=0). Resets on navigation/tab close.
 *
 * Frame support: uses browser.webNavigation.getAllFrames (preferred) or
 * tabs.sendMessage broadcast fallback. Aggregates per-frame responses.
 *
 * Permissions required: menus, storage, webNavigation, pageAction, tabs, activeTab.
 */
(function () {
  'use strict';

  // --- Protocol constants ---
  const VC = {
    VOLUME_SET: 'VC_VOLUME_SET',
    VOLUME_GET: 'VC_VOLUME_GET',
    VOLUME_STATUS: 'VC_VOLUME_STATUS',
    SPEED_SET: 'VC_SPEED_SET',
    SPEED_GET: 'VC_SPEED_GET',
    SPEED_STATUS: 'VC_SPEED_STATUS',
    NIGHT_SET: 'VC_NIGHT_SET',
    NIGHT_GET: 'VC_NIGHT_GET',
    NIGHT_STATUS: 'VC_NIGHT_STATUS',
    SEEK_CONFIG: 'VC_SEEK_CONFIG',
    SEEK_GET: 'VC_SEEK_GET',
    SEEK_UNDO: 'VC_SEEK_UNDO',
    MEDIA_ROLLER_DOWNLOAD: 'VC_MEDIA_ROLLER_DOWNLOAD',
    MEDIA_ROLLER_CONFIG: 'VC_MEDIA_ROLLER_CONFIG',
    MEDIA_ROLLER_GET: 'VC_MEDIA_ROLLER_GET',
    RESET_ALL: 'VC_RESET_ALL',
  };

  // --- Defaults ---
  const DEF = {
    VOLUME: 100,
    SPEED: 1,
    NIGHT: 0,
    SEEK_BINDING: { key: 'z', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
  };

  // --- Validation ranges ---
  const RANGE = {
    VOLUME: { min: 0, max: 300 },
    SPEED: { min: 0.25, max: 3 },
    NIGHT: { min: 0, max: 100 },
  };

  // --- Per-tab in-memory state ---
  const tabState = new Map();

  function getState(tabId) {
    if (!tabState.has(tabId)) {
      tabState.set(tabId, { volume: DEF.VOLUME, speed: DEF.SPEED, night: DEF.NIGHT });
    }
    return tabState.get(tabId);
  }

  function cleanupTab(tabId) {
    tabState.delete(tabId);
  }

  // --- Sender validation ---
  // Popup: must have matching id, exact URL, and NOT have sender.tab
  function isPopup(sender) {
    return (
      sender &&
      sender.id === browser.runtime.id &&
      sender.url === browser.runtime.getURL('popup.html') &&
      !sender.tab
    );
  }

  // Content: must have matching id and a tab reference
  function isContent(sender) {
    return (
      sender && sender.id === browser.runtime.id && sender.tab && typeof sender.tab.id === 'number'
    );
  }

  // --- Frame discovery ---
  async function getFrames(tabId) {
    try {
      if (browser.webNavigation && browser.webNavigation.getAllFrames) {
        const frames = await browser.webNavigation.getAllFrames({ tabId });
        if (frames && frames.length > 0) return frames;
      }
    } catch (_) {}
    return [{ frameId: 0, url: '' }];
  }

  // --- Broadcast to all frames, collect responses ---
  async function broadcast(tabId, msg) {
    const frames = await getFrames(tabId);
    const results = [];
    for (const f of frames) {
      try {
        // Keep exact frameId so seek undo can't target wrong frame
        const opts = f.frameId !== undefined ? { frameId: f.frameId } : {};
        const r = await browser.tabs.sendMessage(tabId, msg, opts);
        if (r) results.push({ ...r, frameId: f.frameId });
        else results.push({ count: 0, status: 'unsupported', frameId: f.frameId });
      } catch (e) {
        const msg = String(e);
        // Ignore unreachable frames (no content script / no media) — these are
        // "Receiving end does not exist" and must NOT count as errors that poison
        // aggregation when other frames succeeded. Only genuine media failures
        // (e.g. AudioContext errors) should surface as errors.
        if (/receiving end does not exist|could not establish connection/i.test(msg)) {
          results.push({ count: 0, status: 'unsupported', frameId: f.frameId });
        } else {
          results.push({ error: msg, frameId: f.frameId, count: 0, status: 'unsupported' });
        }
      }
    }
    return results;
  }

  // --- Aggregation helpers (honest: aggregate ALL, do not pick first) --
  function aggregateStates(results, requested) {
    let totalCount = 0;
    const allApplied = [];
    let anyOk = false;
    let anyError = false;
    let lastError = null;
    let needsInteraction = false;

    for (const r of results) {
      if (!r) continue;
      if (r.needsInteraction) {
        needsInteraction = true;
      }
      if (r.error) {
        anyError = true;
        lastError = r.error;
        continue;
      }
      if (r.count > 0 && r.status === 'ok') {
        totalCount += r.count;
        anyOk = true;
        if (r.appliedPercent != null) allApplied.push(r.appliedPercent);
        else if (r.percent != null) allApplied.push(r.percent);
        else if (r.appliedSpeed != null) allApplied.push(r.appliedSpeed);
        else if (r.speed != null) allApplied.push(r.speed);
        else allApplied.push(requested);
      } else if (r.status === 'unsupported' || r.count === 0) {
        // unsupported — no count added
      } else if (r.status === 'partial') {
        anyOk = true;
        totalCount += r.count || 0;
      }
    }

    let status;
    if (anyOk && anyError) status = 'partial';
    else if (anyOk) status = 'ok';
    else if (anyError) status = 'error';
    else status = 'unsupported';

    return {
      count: totalCount,
      status,
      error: lastError,
      allApplied,
      needsInteraction,
    };
  }

  function aggVolume(results, requested) {
    const agg = aggregateStates(results, requested);
    let appliedPercent = null;
    if (agg.allApplied.length > 0) {
      const allSame = agg.allApplied.every((v) => v === agg.allApplied[0]);
      appliedPercent = allSame ? agg.allApplied[0] : null;
    }
    return {
      percent: requested,
      appliedPercent,
      count: agg.count,
      status: agg.status,
      error: agg.error,
      needsInteraction: agg.needsInteraction || undefined,
    };
  }

  function aggSpeed(results, requested) {
    const agg = aggregateStates(results, requested);
    let appliedSpeed = null;
    if (agg.allApplied.length > 0) {
      const allSame = agg.allApplied.every((v) => Math.abs(v - agg.allApplied[0]) < 0.001);
      appliedSpeed = allSame ? agg.allApplied[0] : null;
    }
    const clamp = results.some((r) => r && r.clamp);
    return {
      speed: requested,
      appliedSpeed,
      count: agg.count,
      status: agg.status,
      error: agg.error,
      clamp,
    };
  }

  function aggNight(results, requested) {
    const agg = aggregateStates(results, requested);
    const anyActive = results.some((r) => r && r.active);
    const reduction = results.find((r) => r && r.reduction != null)?.reduction;
    return {
      strength: requested,
      active: anyActive,
      count: agg.count,
      status: agg.status,
      error: agg.error,
      reduction,
      needsInteraction: agg.needsInteraction || undefined,
    };
  }

  // --- Validation ---
  function validVolume(v) {
    return (
      typeof v === 'number' &&
      Number.isFinite(v) &&
      Number.isInteger(v) &&
      v >= RANGE.VOLUME.min &&
      v <= RANGE.VOLUME.max
    );
  }

  function validSpeed(v) {
    return (
      typeof v === 'number' && Number.isFinite(v) && v >= RANGE.SPEED.min && v <= RANGE.SPEED.max
    );
  }

  function validNight(v) {
    return (
      typeof v === 'number' && Number.isFinite(v) && v >= RANGE.NIGHT.min && v <= RANGE.NIGHT.max
    );
  }

  // --- Page action ---
  function updateActionTitle(tabId, percent) {
    try {
      browser.pageAction.setTitle({ tabId, title: `Media Tamer \u2014 ${percent}%` });
    } catch (_) {}
  }

  function showPageAction(tabId, url) {
    if (!url) return;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      try {
        browser.pageAction.show(tabId);
      } catch (_) {}
    } else {
      try {
        browser.pageAction.hide(tabId);
      } catch (_) {}
    }
  }

  // --- Theme-aware icon swapping ---
  // page_action does not natively support theme_icons (Bug 1409107), so we
  // detect the active theme via browser.theme.getCurrent() and swap the icon
  // per-tab using pageAction.setIcon(). The "dark" variant (dark strokes) is
  // used on light themes; the "light" variant (light strokes) on dark themes.
  const THEME_ICONS = {
    dark: { 16: 'icon-16-dark.png', 32: 'icon-32-dark.png' },
    light: { 16: 'icon-16-light.png', 32: 'icon-32-light.png' },
  };

  function parseCSSColor(str) {
    if (!str || typeof str !== 'string') return null;
    const s = str.trim();

    // rgb() / rgba()
    const rgbMatch = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
    if (rgbMatch) {
      return [parseInt(rgbMatch[1], 10), parseInt(rgbMatch[2], 10), parseInt(rgbMatch[3], 10)];
    }

    // hex: #rgb or #rrggbb
    if (s.startsWith('#')) {
      let hex = s.slice(1);
      if (hex.length === 3)
        hex = hex
          .split('')
          .map((c) => c + c)
          .join('');
      if (hex.length === 6) {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return [r, g, b];
      }
    }

    // Named colors: common Firefox toolbar/address-bar backgrounds.
    // Only map colors we know are definitively light or dark to avoid
    // misclassifying ambiguous names. CSS has 140+ named colors; we
    // explicitly handle the small set Firefox themes actually use.
    const named = {
      // Light / neutral
      white: [255, 255, 255],
      transparent: null, // cannot determine luminance — skip
      // Dark
      black: [0, 0, 0],
    };
    const lower = s.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(named, lower)) {
      return named[lower];
    }

    return null;
  }

  function colorLuminance(rgb) {
    if (!rgb) return null;
    return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  }

  function isDarkTheme(theme) {
    // Firefox 63+ returns theme.colors as CSS strings (rgb()/hex/named),
    // NOT [r,g,b] arrays. Prioritize toolbar_field (address-bar background)
    // since page_action icons live in the address bar.
    let colorStr = null;
    if (theme && theme.colors) {
      colorStr =
        theme.colors.toolbar_field ||
        theme.colors.toolbar ||
        theme.colors.toolbar_background_tinted ||
        theme.colors.tab_background_text ||
        theme.colors.toolbar_text ||
        theme.colors.frame ||
        null;
    }

    if (colorStr) {
      const rgb = parseCSSColor(colorStr);
      const lum = colorLuminance(rgb);
      if (lum !== null) return lum < 0.5;
    }

    // Fallback: system prefers-color-scheme when built-in theme has no
    // toolbar colors (e.g. default Firefox theme on some platforms).
    try {
      if (typeof window !== 'undefined' && window.matchMedia) {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
      }
    } catch (_) {}

    return false;
  }

  async function applyThemeIcon(tabId) {
    try {
      const theme = await browser.theme.getCurrent();
      const variant = isDarkTheme(theme) ? 'light' : 'dark';
      await browser.pageAction.setIcon({
        tabId,
        path: THEME_ICONS[variant],
      });
    } catch (_) {}
  }

  // Apply theme icon to all tabs when theme changes
  if (browser.theme && browser.theme.onUpdated) {
    browser.theme.onUpdated.addListener(async () => {
      try {
        const tabs = await browser.tabs.query({});
        for (const tab of tabs) {
          applyThemeIcon(tab.id).catch(() => {});
        }
      } catch (_) {}
    });
  }

  // Apply theme icon when tab is updated (complete)
  // We hook into the existing onUpdated listener below

  // --- Seek binding persistence ---
  async function loadSeekBinding() {
    try {
      const data = await browser.storage.local.get('seekBinding');
      return data.seekBinding || { ...DEF.SEEK_BINDING };
    } catch (_) {
      return { ...DEF.SEEK_BINDING };
    }
  }

  async function saveSeekBinding(binding) {
    try {
      await browser.storage.local.set({ seekBinding: binding });
    } catch (_) {}
  }

  // --- Broadcast seek binding to ALL current tabs ---
  async function broadcastSeekBindingToAll(binding, enabled) {
    try {
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        broadcast(tab.id, { type: VC.SEEK_CONFIG, binding, enabled }).catch(() => {});
      }
    } catch (_) {}
  }

  // --- Message handlers ---
  async function handleVolumeSet(msg) {
    const tabId = msg.tabId;
    if (tabId == null) return { error: 'no tab' };
    if (!validVolume(msg.percent)) return { error: 'invalid percent', requested: msg.percent };

    getState(tabId).volume = msg.percent;
    const results = await broadcast(tabId, {
      type: VC.VOLUME_SET,
      percent: msg.percent,
      tabId,
    });
    const agg = aggVolume(results, msg.percent);
    updateActionTitle(tabId, msg.percent);
    return agg;
  }

  async function handleVolumeGet(msg) {
    const tabId = msg.tabId;
    if (tabId == null) return { error: 'no tab' };
    const state = getState(tabId);
    const results = await broadcast(tabId, { type: VC.VOLUME_GET, tabId });
    return aggVolume(results, state.volume);
  }

  async function handleSpeedSet(msg) {
    const tabId = msg.tabId;
    if (tabId == null) return { error: 'no tab' };
    if (!validSpeed(msg.speed)) return { error: 'invalid speed', requested: msg.speed };

    getState(tabId).speed = msg.speed;
    const results = await broadcast(tabId, {
      type: VC.SPEED_SET,
      speed: msg.speed,
      tabId,
    });
    return aggSpeed(results, msg.speed);
  }

  async function handleSpeedGet(msg) {
    const tabId = msg.tabId;
    if (tabId == null) return { error: 'no tab' };
    const state = getState(tabId);
    const results = await broadcast(tabId, { type: VC.SPEED_GET, tabId });
    return aggSpeed(results, state.speed);
  }

  async function handleNightSet(msg) {
    const tabId = msg.tabId;
    if (tabId == null) return { error: 'no tab' };
    if (!validNight(msg.strength))
      return { error: 'invalid night strength', requested: msg.strength };

    getState(tabId).night = msg.strength;
    const results = await broadcast(tabId, {
      type: VC.NIGHT_SET,
      strength: msg.strength,
      tabId,
    });
    return aggNight(results, msg.strength);
  }

  async function handleNightGet(msg) {
    const tabId = msg.tabId;
    if (tabId == null) return { error: 'no tab' };
    const state = getState(tabId);
    const results = await broadcast(tabId, { type: VC.NIGHT_GET, tabId });
    return aggNight(results, state.night);
  }

  async function handleSeekConfig(msg) {
    const binding = msg.binding || { ...DEF.SEEK_BINDING };
    const enabled = msg.enabled !== false;

    await saveSeekBinding(binding);

    // Broadcast to all current tabs
    await broadcastSeekBindingToAll(binding, enabled);

    // Also broadcast to the target tab if specified
    const tabId = msg.tabId;
    if (tabId != null) {
      await broadcast(tabId, { type: VC.SEEK_CONFIG, binding, enabled });
    }

    return { ok: true, binding, enabled };
  }

  async function handleSeekGet(msg) {
    const tabId = msg.tabId;
    if (tabId == null) return { error: 'no tab' };

    const binding = await loadSeekBinding();
    const results = await broadcast(tabId, { type: VC.SEEK_GET, tabId });

    const withHistory = results.filter((r) => r && r.historyCount > 0);
    const best =
      withHistory.length > 0 ? withHistory[0] : results.find((r) => r && r.binding) || null;

    return {
      binding: best ? best.binding : binding,
      enabled: best ? best.enabled : true,
      historyCount: best ? best.historyCount : 0,
      canUndo: withHistory.length > 0,
    };
  }

  async function handleSeekUndo(msg) {
    const tabId = msg.tabId;
    if (tabId == null) return { error: 'no tab' };

    const getStateResults = await broadcast(tabId, { type: VC.SEEK_GET, tabId });
    const frames = await getFrames(tabId);

    for (let i = 0; i < frames.length; i++) {
      const r = getStateResults[i];
      if (r && r.historyCount > 0) {
        try {
          // Use exact frameId for the undo target
          const undoResult = await browser.tabs.sendMessage(
            tabId,
            { type: VC.SEEK_UNDO, tabId },
            { frameId: frames[i].frameId },
          );
          return undoResult || { success: false };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      }
    }

    return { success: false, error: 'no history' };
  }

  // --- Reset all tab controls to defaults ---
  async function handleResetAll(msg) {
    const tabId = msg.tabId;
    if (tabId == null) return { error: 'no tab' };

    const state = getState(tabId);
    state.volume = DEF.VOLUME;
    state.speed = DEF.SPEED;
    state.night = DEF.NIGHT;

    // Broadcast all three resets to content scripts
    const volResults = await broadcast(tabId, {
      type: VC.VOLUME_SET,
      percent: DEF.VOLUME,
      tabId,
    });
    const speedResults = await broadcast(tabId, {
      type: VC.SPEED_SET,
      speed: DEF.SPEED,
      tabId,
    });
    const nightResults = await broadcast(tabId, {
      type: VC.NIGHT_SET,
      strength: DEF.NIGHT,
      tabId,
    });

    updateActionTitle(tabId, DEF.VOLUME);

    return {
      volume: aggVolume(volResults, DEF.VOLUME),
      speed: aggSpeed(speedResults, DEF.SPEED),
      night: aggNight(nightResults, DEF.NIGHT),
    };
  }

  // --- Runtime message listener ---
  browser.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg !== 'object') return;

    // Content STATUS messages — update pageAction title, no response routed back
    if (isContent(sender)) {
      if (msg.type === VC.VOLUME_STATUS) {
        const state = getState(sender.tab.id);
        const pct = msg.percent != null ? msg.percent : state.volume;
        updateActionTitle(sender.tab.id, pct);
      }
      return;
    }

    // Only accept commands from popup origin
    if (!isPopup(sender)) return;

    switch (msg.type) {
      case VC.VOLUME_SET:
        return handleVolumeSet(msg);
      case VC.VOLUME_GET:
        return handleVolumeGet(msg);
      case VC.SPEED_SET:
        return handleSpeedSet(msg);
      case VC.SPEED_GET:
        return handleSpeedGet(msg);
      case VC.NIGHT_SET:
        return handleNightSet(msg);
      case VC.NIGHT_GET:
        return handleNightGet(msg);
      case VC.SEEK_CONFIG:
        return handleSeekConfig(msg);
      case VC.SEEK_GET:
        return handleSeekGet(msg);
      case VC.SEEK_UNDO:
        return handleSeekUndo(msg);
      case VC.MEDIA_ROLLER_DOWNLOAD:
        if (typeof VC_MEDIA_ROLLER !== 'undefined') {
          return VC_MEDIA_ROLLER.downloadTab(msg.tabId);
        }
        return { error: 'Media Roller not loaded' };
      case VC.MEDIA_ROLLER_CONFIG:
        if (typeof VC_MEDIA_ROLLER !== 'undefined') {
          return VC_MEDIA_ROLLER.configure(msg.baseUrl);
        }
        return { error: 'Media Roller not loaded' };
      case VC.MEDIA_ROLLER_GET:
        if (typeof VC_MEDIA_ROLLER !== 'undefined') {
          return VC_MEDIA_ROLLER.getConfig();
        }
        return { enabled: false, baseUrl: null };
      case VC.RESET_ALL:
        return handleResetAll(msg);
      default:
        return;
    }
  });

  // --- Tab lifecycle ---
  browser.tabs.onRemoved.addListener((tabId) => cleanupTab(tabId));

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading') {
      cleanupTab(tabId);
      // Do NOT imperative-hide here: show_matches in the manifest handles
      // show/hide based on URL. Hiding on loading races with show_matches
      // and causes the action to vanish on newly opened video tabs.
    }
    if (changeInfo.status === 'complete' && tab) {
      showPageAction(tabId, tab.url);
      applyThemeIcon(tabId).catch(() => {});
      loadSeekBinding()
        .then((binding) =>
          broadcast(tabId, { type: VC.SEEK_CONFIG, binding, enabled: true }).catch(() => {}),
        )
        .catch(() => {});
    }
  });

  // --- Context menus (right-click tab) --
  // Consolidated under a single "Media Tamer" parent submenu for a cleaner
  // native tab menu. Native menus accept no CSS, so we improve hierarchy only.
  const VOLUME_PRESETS = [0, 50, 100, 150, 200, 300];
  const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];
  const NIGHT_PRESETS = [0, 35, 70];

  function createMenus() {
    try {
      // Single parent submenu
      browser.menus.create({ id: 'vg-root', title: 'Media Tamer', contexts: ['tab'] });

      // Volume submenu with current value in parent title
      browser.menus.create({
        id: 'vg-volume',
        parentId: 'vg-root',
        title: `Volume — ${DEF.VOLUME}%`,
        contexts: ['tab'],
      });
      for (const p of VOLUME_PRESETS) {
        browser.menus.create({
          id: `vg-volume-${p}`,
          parentId: 'vg-volume',
          title: `${p}%`,
          contexts: ['tab'],
          type: 'checkbox',
          checked: p === DEF.VOLUME,
        });
      }

      // Speed submenu with current value in parent title
      browser.menus.create({
        id: 'vg-speed',
        parentId: 'vg-root',
        title: `Speed — ${DEF.SPEED}x`,
        contexts: ['tab'],
      });
      for (const s of SPEED_PRESETS) {
        browser.menus.create({
          id: `vg-speed-${s}`,
          parentId: 'vg-speed',
          title: `${s}x`,
          contexts: ['tab'],
          type: 'checkbox',
          checked: Math.abs(s - DEF.SPEED) < 0.001,
        });
      }

      // Night mode submenu — radio group for presets, custom shown in parent title
      browser.menus.create({
        id: 'vg-night',
        parentId: 'vg-root',
        title: 'Night mode — Off',
        contexts: ['tab'],
      });
      browser.menus.create({
        id: 'vg-night-0',
        parentId: 'vg-night',
        title: 'Off',
        contexts: ['tab'],
        type: 'radio',
        checked: true,
      });
      browser.menus.create({
        id: 'vg-night-35',
        parentId: 'vg-night',
        title: 'Light',
        contexts: ['tab'],
        type: 'radio',
        checked: false,
      });
      browser.menus.create({
        id: 'vg-night-70',
        parentId: 'vg-night',
        title: 'Strong',
        contexts: ['tab'],
        type: 'radio',
        checked: false,
      });

      // Separator before undo
      browser.menus.create({
        id: 'vg-sep',
        parentId: 'vg-root',
        type: 'separator',
        contexts: ['tab'],
      });

      // Undo seek — enabled only when target tab has seek history
      browser.menus.create({
        id: 'vg-seek-undo',
        parentId: 'vg-root',
        title: 'Undo seek',
        contexts: ['tab'],
        enabled: false,
      });
    } catch (_) {}
  }

  // Check if the target tab has seek history (for undo enable/disable)
  async function canUndoSeek(tabId) {
    try {
      const results = await broadcast(tabId, { type: VC.SEEK_GET, tabId });
      return results.some((r) => r && r.historyCount > 0);
    } catch (_) {
      return false;
    }
  }

  browser.menus.onClicked.addListener((info, tab) => {
    const targetTabId = info.tabId != null ? info.tabId : tab ? tab.id : null;
    if (targetTabId == null) return;

    if (info.menuItemId.startsWith('vg-volume-')) {
      const p = parseInt(info.menuItemId.replace('vg-volume-', ''), 10);
      if (!isNaN(p)) {
        getState(targetTabId).volume = p;
        broadcast(targetTabId, { type: VC.VOLUME_SET, percent: p, tabId: targetTabId }).catch(
          () => {},
        );
        updateActionTitle(targetTabId, p);
      }
    } else if (info.menuItemId.startsWith('vg-speed-')) {
      const s = parseFloat(info.menuItemId.replace('vg-speed-', ''));
      if (!isNaN(s)) {
        getState(targetTabId).speed = s;
        broadcast(targetTabId, { type: VC.SPEED_SET, speed: s, tabId: targetTabId }).catch(
          () => {},
        );
      }
    } else if (info.menuItemId.startsWith('vg-night-')) {
      const n = parseInt(info.menuItemId.replace('vg-night-', ''), 10);
      if (!isNaN(n)) {
        getState(targetTabId).night = n;
        broadcast(targetTabId, { type: VC.NIGHT_SET, strength: n, tabId: targetTabId }).catch(
          () => {},
        );
      }
    } else if (info.menuItemId === 'vg-seek-undo') {
      handleSeekUndo({ tabId: targetTabId }).catch(() => {});
    }
  });

  browser.menus.onShown.addListener(async (info, tab) => {
    const targetTabId = info.tabId != null ? info.tabId : tab ? tab.id : null;
    if (targetTabId == null) return;

    const state = getState(targetTabId);
    const capturedTabId = targetTabId;

    try {
      const updatePromises = [];

      // Volume presets — checkbox checked only if exact match (no false checked)
      for (const p of VOLUME_PRESETS) {
        updatePromises.push(
          browser.menus.update(`vg-volume-${p}`, { checked: p === state.volume }).catch(() => {}),
        );
      }

      // Speed presets — checkbox checked only if exact match
      for (const s of SPEED_PRESETS) {
        updatePromises.push(
          browser.menus
            .update(`vg-speed-${s}`, { checked: Math.abs(s - state.speed) < 0.001 })
            .catch(() => {}),
        );
      }

      // Night presets — radio checked only if exact match (custom = none checked)
      for (const n of NIGHT_PRESETS) {
        updatePromises.push(
          browser.menus.update(`vg-night-${n}`, { checked: n === state.night }).catch(() => {}),
        );
      }

      // Parent titles show current values concisely
      updatePromises.push(
        browser.menus.update('vg-volume', { title: `Volume — ${state.volume}%` }).catch(() => {}),
      );
      updatePromises.push(
        browser.menus.update('vg-speed', { title: `Speed — ${state.speed}x` }).catch(() => {}),
      );

      const nightLabel =
        state.night === 0
          ? 'Off'
          : state.night === 35
            ? 'Light'
            : state.night === 70
              ? 'Strong'
              : `Custom ${state.night}%`;
      updatePromises.push(
        browser.menus.update('vg-night', { title: `Night mode — ${nightLabel}` }).catch(() => {}),
      );

      // Undo seek enabled only when target tab has seek history
      const canUndo = await canUndoSeek(capturedTabId);
      updatePromises.push(
        browser.menus.update('vg-seek-undo', { enabled: canUndo }).catch(() => {}),
      );

      // Await all updates before refresh to avoid partial menu state
      await Promise.all(updatePromises);

      browser.menus.refresh().catch(() => {});
    } catch (_) {}
  });

  // --- Init ---
  createMenus();

  browser.tabs
    .query({})
    .then((tabs) => {
      for (const tab of tabs) showPageAction(tab.id, tab.url);
    })
    .catch(() => {});
})();
