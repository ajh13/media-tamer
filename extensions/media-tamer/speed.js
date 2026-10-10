/**
 * Video Number Guard — Speed feature.
 *
 * Classic content script (NOT an ES module — no exports).
 * Self-contained IIFE, no public window globals, no DOM expando leaks.
 *
 * Design notes:
 * - Range: 0.25x to 3.0x, step 0.05. Default 1.0 (normal).
 * - Per-document speed only (no storage).
 * - Applied to <video> elements (audio only if no video in same root).
 * - Handles open shadow roots, dynamically inserted media, SPA navigation.
 * - Avoids feedback loops by tagging own changes (__vgOwnChange flag).
 * - Preserves pitch where supported.
 * - Does not override playbackRate/defaultPlaybackRate before extension SET.
 * - Honest reporting: actual applied speed, counts, errors, site clamp.
 * - Backs off when site changes speed — does not fight.
 */
(function () {
  'use strict';

  // --- Constants ---

  var MIN_SPEED = 0.25;
  var MAX_SPEED = 3;
  var SPEED_STEP = 0.05;
  var DEFAULT_SPEED = 1;

  var MSG = {
    SET: 'VC_SPEED_SET',
    GET: 'VC_SPEED_GET',
    RESET: 'VC_SPEED_RESET',
    STATUS: 'VC_SPEED_STATUS',
  };

  // --- Per-document state ---

  var currentSpeed = DEFAULT_SPEED;
  var speedApplied = false;
  var mediaObserver = null;
  var extensionId = null;
  var claimedElements = new WeakSet();

  // --- Pure logic ---

  function roundToStep(value, step) {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
    var stepStr = step.toString();
    var dec = stepStr.indexOf('.') === -1 ? 0 : stepStr.length - stepStr.indexOf('.') - 1;
    var factor = Math.pow(10, dec);
    var intStep = Math.round(step * factor);
    var epsilon = 1e-9;
    var intValue = Math.round(value * factor + epsilon);
    var result = (Math.round(intValue / intStep) * intStep) / factor;
    return parseFloat(result.toFixed(dec));
  }

  function validateSpeed(value) {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= MIN_SPEED &&
      value <= MAX_SPEED
    );
  }

  function buildStatusResponse(params) {
    var r = {
      speed: params.speed,
      appliedSpeed: params.appliedSpeed !== undefined ? params.appliedSpeed : null,
      count: params.count !== undefined ? params.count : 0,
      status: params.status,
    };
    if (params.error !== undefined) r.error = params.error;
    if (params.clamp !== undefined) r.clamp = params.clamp;
    if (params.countUnsupported !== undefined) r.countUnsupported = params.countUnsupported;
    if (params.countSkipped !== undefined) r.countSkipped = params.countSkipped;
    return r;
  }

  function isValidSender(sender) {
    if (!sender || typeof sender !== 'object') return false;
    if (!extensionId) return false;
    return sender.id === extensionId;
  }

  // --- Browser-side ---

  function findMediaElements(root) {
    var results = [];
    try {
      if (!root || !root.querySelectorAll) return results;
      var videos = root.querySelectorAll('video');
      for (var i = 0; i < videos.length; i++) results.push(videos[i]);
      if (videos.length === 0) {
        var audio = root.querySelectorAll('audio');
        for (var j = 0; j < audio.length; j++) results.push(audio[j]);
      }
      var all = root.querySelectorAll('*');
      for (var k = 0; k < all.length; k++) {
        var el = all[k];
        if (el && el.shadowRoot) {
          var shadowResults = findMediaElements(el.shadowRoot);
          for (var m = 0; m < shadowResults.length; m++) {
            results.push(shadowResults[m]);
          }
        }
      }
    } catch (_) {}
    return results;
  }

  function applySpeedToElement(el, speed) {
    try {
      // Preserve pitch
      try {
        if ('preservesPitch' in el) el.preservesPitch = true;
        if ('mozPreservesPitch' in el) el.mozPreservesPitch = true;
        if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = true;
      } catch (_) {}

      // Mark own change to avoid feedback loop
      el.__vgOwnChange = true;
      el.playbackRate = speed;

      // Set defaultPlaybackRate only if still at default (not prechanged by site/user)
      if (el.defaultPlaybackRate === DEFAULT_SPEED || !speedApplied) {
        el.defaultPlaybackRate = speed;
      }

      var actual = el.playbackRate;
      var clamped = Math.abs(actual - speed) >= 0.001;

      return {
        applied: actual,
        status: 'ok',
        clamped: clamped,
      };
    } catch (e) {
      return { applied: null, status: 'error', error: String(e) };
    }
  }

  function applySpeedToDocument(speed) {
    var elements = findMediaElements(document);
    var count = 0;
    var anyClamped = false;
    var anyError = false;
    var lastError = null;
    var unsupportedCount = 0;
    var actualSpeeds = [];

    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var result = applySpeedToElement(el, speed);
      if (result.status === 'ok') {
        count++;
        actualSpeeds.push(result.applied);
        if (result.clamped) anyClamped = true;
      } else if (result.status === 'error') {
        anyError = true;
        lastError = result.error;
        unsupportedCount++;
      }
    }

    // Only report appliedSpeed if all elements share the same rate.
    // Mixed actual rates → null (never invent a mean).
    var appliedSpeed = null;
    if (count > 0) {
      var allSame = true;
      for (var j = 1; j < actualSpeeds.length; j++) {
        if (Math.abs(actualSpeeds[j] - actualSpeeds[0]) >= 0.001) {
          allSame = false;
          break;
        }
      }
      if (allSame) {
        appliedSpeed = Math.round(actualSpeeds[0] * 100) / 100;
      }
    }

    var status = getOverallStatus(count, anyError, anyClamped);

    return buildStatusResponse({
      speed: speed,
      appliedSpeed: appliedSpeed,
      count: count,
      status: status,
      error: lastError !== null ? lastError : undefined,
      clamp: anyClamped || undefined,
      countUnsupported: unsupportedCount || undefined,
      countSkipped: elements.length - count - unsupportedCount || undefined,
    });
  }

  function getOverallStatus(count, hasError, _hasClamp) {
    if (count === 0 && hasError) return 'error';
    if (count === 0) return 'unsupported';
    if (hasError) return 'partial';
    return 'ok';
  }

  function resetSpeed() {
    return applySpeedToDocument(DEFAULT_SPEED);
  }

  function reapplyIfNeeded() {
    if (!speedApplied) return;
    var elements = findMediaElements(document);
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!claimedElements.has(el)) {
        // New element — apply our target speed once
        applySpeedToElement(el, currentSpeed);
        claimedElements.add(el);
      } else {
        // Existing element — check if site changed it
        if (Math.abs(el.playbackRate - currentSpeed) >= 0.001 && !el.__vgOwnChange) {
          // Site changed it — back off, don't fight
          claimedElements.delete(el);
          try {
            browser.runtime
              .sendMessage({
                type: MSG.STATUS,
                speed: currentSpeed,
                appliedSpeed: el.playbackRate,
                count: 0,
                status: 'partial',
                error: 'site changed speed',
              })
              .catch(function () {});
          } catch (_) {}
        }
      }
      // Clear own-change flag after a tick so site changes can be detected
      if (el.__vgOwnChange) {
        setTimeout(
          function (target) {
            target.__vgOwnChange = false;
          },
          0,
          el,
        );
      }
    }
  }

  function ensureMediaObserver() {
    if (mediaObserver) return;
    // Guard: document.documentElement may not exist at document_start
    if (!document.documentElement) return;

    var refresh = debounce(function () {
      reapplyIfNeeded();
    }, 100);
    mediaObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].type === 'childList') {
          refresh();
          return;
        }
      }
    });
    mediaObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
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

  function onMessage(message, sender, sendResponse) {
    if (!isValidSender(sender)) return;
    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case MSG.SET: {
        // Strict validation: must be a finite number in range, no coercion/clamp of invalid
        if (!validateSpeed(message.speed)) {
          sendResponse(
            buildStatusResponse({
              speed: typeof message.speed === 'number' ? message.speed : null,
              appliedSpeed: null,
              count: 0,
              status: 'error',
              error: 'invalid speed value',
            }),
          );
          return true;
        }
        var speed = roundToStep(message.speed, SPEED_STEP);
        currentSpeed = speed;
        speedApplied = true;
        var result = applySpeedToDocument(speed);
        try {
          browser.runtime
            .sendMessage({
              type: MSG.STATUS,
              speed: result.speed,
              appliedSpeed: result.appliedSpeed,
              count: result.count,
              status: result.status,
              tabId: message.tabId,
            })
            .catch(function () {});
        } catch (_) {}
        sendResponse(result);
        return true;
      }

      case MSG.GET: {
        var elements = findMediaElements(document);
        // Report actual live playbackRate, not stale requested speed
        var reportedSpeed = null;
        if (elements.length > 0 && speedApplied) {
          var allSame = true;
          var firstRate = elements[0].playbackRate;
          for (var j = 1; j < elements.length; j++) {
            if (Math.abs(elements[j].playbackRate - firstRate) >= 0.001) {
              allSame = false;
              break;
            }
          }
          reportedSpeed = allSame ? Math.round(firstRate * 100) / 100 : null;
        }
        sendResponse(
          buildStatusResponse({
            speed: speedApplied ? currentSpeed : DEFAULT_SPEED,
            appliedSpeed: speedApplied ? reportedSpeed : null,
            count: elements.length,
            status: elements.length > 0 ? 'ok' : 'unsupported',
          }),
        );
        return true;
      }

      case MSG.RESET: {
        currentSpeed = DEFAULT_SPEED;
        speedApplied = true;
        var result = resetSpeed();
        try {
          browser.runtime
            .sendMessage({
              type: MSG.STATUS,
              speed: result.speed,
              appliedSpeed: result.appliedSpeed,
              count: result.count,
              status: result.status,
            })
            .catch(function () {});
        } catch (_) {}
        sendResponse(result);
        return true;
      }

      default:
        return;
    }
  }

  // --- Init ---

  try {
    extensionId = browser.runtime.id;
  } catch (_) {}

  browser.runtime.onMessage.addListener(onMessage);
  ensureMediaObserver();

  // Re-apply on DOM ready (also re-inits observer if it was deferred)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      ensureMediaObserver();
      reapplyIfNeeded();
    });
  }
})();
