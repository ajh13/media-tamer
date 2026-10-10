/* Frame-local seek undo. No page messaging or page-visible debug API. */
(() => {
  'use strict';
  let binding = { key: 'z', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };
  let enabled = true;
  const states = new WeakMap();
  const videos = new Set();
  const roots = new WeakSet();
  const observers = [];
  let stopped = false;
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    stopped = true;
    for (const observer of observers) observer.disconnect();
  });
  let active = null;
  let refreshQueued = false;
  function attach(video) {
    if (states.has(video)) return;
    videos.add(video);
    const s = { stable: null, from: null, undo: null, history: [] };
    states.set(video, s);
    video.addEventListener('timeupdate', () => {
      if (!video.seeking && s.from === null && s.undo === null) s.stable = video.currentTime;
    });
    video.addEventListener('seeking', () => {
      if (s.undo !== null) return;
      if (s.from === null) s.from = s.stable;
    });
    video.addEventListener('seeked', () => {
      if (s.undo !== null) {
        s.undo = null;
        s.from = null;
        s.stable = video.currentTime;
        return;
      }
      const from = s.from;
      s.from = null;
      if (Number.isFinite(from) && Math.abs(video.currentTime - from) >= 2) {
        s.history.push(from);
        if (s.history.length > 30) s.history.shift();
        active = video;
      }
      s.stable = video.currentTime;
    });
    for (const type of ['play', 'pointerdown'])
      video.addEventListener(type, () => {
        active = video;
      });
    for (const type of ['loadstart', 'emptied'])
      video.addEventListener(type, () => {
        s.stable = null;
        s.from = null;
        s.undo = null;
        s.history = [];
      });
  }
  function scan(root) {
    if (!roots.has(root)) {
      roots.add(root);
      const observer = new MutationObserver(() => {
        if (refreshQueued || stopped) return;
        refreshQueued = true;
        queueMicrotask(() => {
          refreshQueued = false;
          if (!stopped) scan(document);
        });
      });
      observers.push(observer);
      observer.observe(root, { childList: true, subtree: true });
    }
    for (const video of root.querySelectorAll('video')) attach(video);
    for (const node of root.querySelectorAll('*')) if (node.shadowRoot) scan(node.shadowRoot);
    for (const video of videos)
      if (!video.isConnected) {
        videos.delete(video);
        if (active === video) active = null;
      }
  }
  function target() {
    scan(document);
    if (active?.isConnected) return active;
    const playing = [...videos].find((v) => !v.paused);
    return playing || [...videos].find((v) => states.get(v).history.length) || [...videos][0];
  }
  function getState() {
    const video = target(),
      historyCount = video ? states.get(video).history.length : 0;
    return {
      binding: { ...binding },
      enabled,
      historyCount,
      canUndo: enabled && historyCount > 0,
      threshold: 2,
      count: videos.size,
    };
  }
  function undo() {
    const video = target();
    if (!enabled || !video) return { success: false };
    const s = states.get(video),
      to = s.history.at(-1);
    if (to === undefined || s.undo !== null) return { success: false };
    const from = video.currentTime;
    if (Number.isFinite(video.duration) && to > video.duration)
      return { success: false, error: 'Previous position no longer exists.' };
    try {
      s.undo = to;
      video.currentTime = to;
      s.history.pop();
      s.stable = to;
      return { success: true, restoredFrom: from, restoredTo: to };
    } catch (error) {
      s.undo = null;
      return { success: false, error: String(error.message || error) };
    }
  }
  window.addEventListener(
    'keydown',
    (event) => {
      if (
        !enabled ||
        event.repeat ||
        event.isComposing ||
        document.designMode?.toLowerCase() === 'on'
      )
        return;
      if (event.key.toLowerCase() !== binding.key.toLowerCase()) return;
      for (const mod of ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'])
        if (!!event[mod] !== binding[mod]) return;
      for (const node of event.composedPath()) {
        if (node.nodeType !== 1) continue;
        const ce = node.getAttribute('contenteditable');
        if (
          node.matches('input,textarea,select') ||
          node.isContentEditable ||
          ce === '' ||
          ce === 'true' ||
          ce === 'plaintext-only' ||
          /^(textbox|searchbox|combobox|spinbutton)$/.test(node.getAttribute('role') || '')
        )
          return;
      }
      if (undo().success) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  browser.runtime.onMessage.addListener((message, sender) => {
    if (sender?.id !== browser.runtime.id || !message) return undefined;
    if (message.type === 'VC_SEEK_CONFIG') {
      const b = message.binding;
      if (
        b &&
        (typeof b.key !== 'string' ||
          !b.key ||
          b.key.length > 30 ||
          ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'].some((k) => typeof b[k] !== 'boolean') ||
          !(b.ctrlKey || b.altKey || b.metaKey))
      )
        return Promise.resolve({ error: 'Use a key with Ctrl, Alt, or Meta.' });
      if (b)
        binding = {
          key: b.key,
          ctrlKey: b.ctrlKey,
          altKey: b.altKey,
          shiftKey: b.shiftKey,
          metaKey: b.metaKey,
        };
      if (typeof message.enabled === 'boolean') enabled = message.enabled;
      return Promise.resolve(getState());
    }
    if (message.type === 'VC_SEEK_GET' || message.type === 'VC_SEEK_GET_STATE')
      return Promise.resolve(getState());
    if (message.type === 'VC_SEEK_UNDO') return Promise.resolve(undo());
    return undefined;
  });
  scan(document);
})();
