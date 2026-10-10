/* Runs in the extension's isolated world, before page keyboard handlers. */
(() => {
  'use strict';
  // Setting: block number-key seeking (0–9). Default ON preserves existing behavior.
  // OFF lets sites handle number keys natively. Live-updated via storage.onChanged.
  let blockNumberKeys = true;
  // Revision guard: loadSetting's async read-back cannot overwrite a newer value
  // pushed by storage.onChanged (or an interim change). Each update bumps the
  // guard; stale callbacks see a mismatched guard and discard their value.
  let settingRevision = 0;
  function loadSetting() {
    if (typeof browser !== 'undefined' && browser?.storage?.local) {
      const myRevision = settingRevision;
      browser.storage.local
        .get('blockNumberKeys')
        .then((data) => {
          // Discard if a newer change arrived while this read was in flight
          if (myRevision !== settingRevision) return;
          if (typeof data.blockNumberKeys === 'boolean') {
            blockNumberKeys = data.blockNumberKeys;
          }
        })
        .catch(() => {});
    }
  }
  if (typeof browser !== 'undefined' && browser?.storage?.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.blockNumberKeys) {
        settingRevision++; // invalidate any in-flight loadSetting read
        const v = changes.blockNumberKeys.newValue;
        if (typeof v === 'boolean') blockNumberKeys = v;
        // If newValue is undefined (key removed), fall back to default ON
        else if (v === undefined) blockNumberKeys = true;
      }
    });
  }
  loadSetting();
  // Scan only on an eligible digit, so dynamic/open-shadow players need no polling.
  function hasVideo(root) {
    if (root.querySelector('video')) return true;
    for (const node of root.querySelectorAll('*')) {
      if (node.shadowRoot && hasVideo(node.shadowRoot)) return true;
    }
    return false;
  }
  function onKey(event) {
    if (
      !/^[0-9]$/.test(event.key) ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey ||
      event.isComposing
    )
      return;
    if (!blockNumberKeys) return;
    if (document.designMode?.toLowerCase() === 'on') return;
    for (const node of event.composedPath()) {
      if (node.nodeType !== 1) continue;
      const editable = node.getAttribute('contenteditable');
      if (
        node.matches('input, textarea, select') ||
        node.isContentEditable ||
        editable === '' ||
        editable === 'true' ||
        editable === 'plaintext-only' ||
        /^(textbox|searchbox|combobox|spinbutton)$/.test(node.getAttribute('role') || '')
      )
        return;
    }
    if (!hasVideo(document)) return;
    event.stopImmediatePropagation();
  }
  for (const type of ['keydown', 'keypress', 'keyup']) {
    window.addEventListener(type, onKey, { capture: true });
  }
})();
