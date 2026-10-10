/**
 * Media Roller integration helper — classic background script (IIFE).
 *
 * Loaded BEFORE background.js in the manifest background scripts array.
 * Provides the VC_MEDIA_ROLLER namespace for optional remote video download
 * via a self-hosted media-roller server (https://github.com/rroller/media-roller).
 *
 * This is a PURE HELPER. It does NOT:
 *   - Register runtime message listeners or commands
 *   - Register context menus or browser action handlers
 *   - Make automatic network requests on startup, config save, or browsing
 *   - Request permissions without a user gesture (parent handles gesture)
 *
 * Parent (background.js) routes trusted popup/menu messages to these methods.
 *
 * Security constraints:
 *   - Base URL validated: http/https only, no credentials/query/hash
 *   - Page URL obtained ONLY from browser.tabs.get(tabId).url (never page messages)
 *   - Rejects about/file/blob/data/javascript URLs and URLs with credentials
 *   - Uses URLSearchParams to prevent query argument injection
 *   - Endpoint is ALWAYS the fixed "api/download"; no custom yt-dlp options
 *   - No custom headers, no cookies, no arbitrary backend probes
 *   - Persists only baseURL in storage.local (not sync)
 *
 * Known limitation:
 *   Firefox's browser.downloads.download extension API does NOT use the server's
 *   Content-Disposition filename when saving the file to disk. When no `filename`
 *   option is passed, Firefox derives the basename from the URL path
 *   (/api/download → "download"). This is NOT a Content-Disposition failure — the
 *   header is correctly sent and received, but the extension API simply ignores it
 *   for naming. media-roller.js intentionally omits the `filename` option so the
 *   browser honors its default download behavior, including server-suggested
 *   filenames via Content-Disposition when the browser's native download handler
 *   processes the response (e.g., when a user clicks a link directly).
 */
/* exported VC_MEDIA_ROLLER */
var VC_MEDIA_ROLLER = (function () {
  'use strict';

  const STORAGE_KEY = 'mediaRollerBaseUrl';
  const ENDPOINT = 'api/download';
  const REQUIRED_PERMISSION = 'downloads';

  const STATUS = Object.freeze({
    OK: 'ok',
    ERROR: 'error',
    DISABLED: 'disabled',
    PERMISSION_REQUIRED: 'permission_required',
    INVALID_URL: 'invalid_url',
    RESTRICTED_URL: 'restricted_url',
    IN_FLIGHT: 'in_flight',
  });

  const RESTRICTED_SCHEMES = Object.freeze(['about:', 'file:', 'blob:', 'data:', 'javascript:']);

  // In-flight downloads: tabId -> Promise (cleaned up when settled).
  const inFlight = new Map();

  // ---------------------------------------------------------------------------
  // Base URL validation
  // ---------------------------------------------------------------------------

  /**
   * Validate and normalize a media-roller base URL.
   *
   * Rules:
   *   - Must be a non-empty string parseable as a URL
   *   - Protocol must be http:// or https://
   *   - No credentials (user:pass@host)
   *   - No query string (?key=value)
   *   - No fragment (#hash)
   *   - Path prefix is allowed (e.g., https://host/prefix/)
   *   - Trailing slash is normalized (always present)
   *
   * @param {string} baseUrl
   * @returns {{ ok: boolean, url?: string, error?: string, code?: string }}
   */
  function validateAndNormalizeBaseUrl(baseUrl) {
    if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
      return { ok: false, error: 'Base URL must be a non-empty string', code: 'empty' };
    }

    var parsed;
    try {
      parsed = new URL(baseUrl);
    } catch (e) {
      return { ok: false, error: 'Invalid URL format: ' + String(e), code: 'parse_error' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        error: 'Base URL must use http:// or https:// (got "' + parsed.protocol + '")',
        code: 'bad_scheme',
      };
    }

    if (parsed.username || parsed.password) {
      return {
        ok: false,
        error: 'Base URL must not contain credentials (user:pass@host)',
        code: 'has_credentials',
      };
    }

    if (baseUrl.includes('?')) {
      return {
        ok: false,
        error: 'Base URL must not contain a query string (?key=value)',
        code: 'has_query',
      };
    }

    if (baseUrl.includes('#')) {
      return {
        ok: false,
        error: 'Base URL must not contain a fragment (#hash)',
        code: 'has_hash',
      };
    }

    // Normalize trailing slash so baseUrl + ENDPOINT concatenates correctly.
    var url = parsed.href;
    if (!url.endsWith('/')) {
      url = url + '/';
    }

    return { ok: true, url: url };
  }

  // ---------------------------------------------------------------------------
  // Page URL validation
  // ---------------------------------------------------------------------------

  /**
   * Validate a page URL for download eligibility.
   *
   * Rules:
   *   - Reject restricted schemes (about/file/blob/data/javascript)
   *   - Reject URLs with credentials
   *   - Fragment (#...) is trimmed
   *   - Query string (?...) is preserved
   *
   * @param {string} pageURL
   * @returns {{ ok: boolean, url?: string, error?: string, code?: string }}
   */
  function validatePageUrl(pageURL) {
    if (typeof pageURL !== 'string' || pageURL.trim().length === 0) {
      return { ok: false, error: 'Page URL must be a non-empty string', code: 'empty' };
    }

    var trimmed = pageURL.trim();
    var lower = trimmed.toLowerCase();

    // Check restricted schemes (case-insensitive).
    for (var i = 0; i < RESTRICTED_SCHEMES.length; i++) {
      if (lower.startsWith(RESTRICTED_SCHEMES[i])) {
        return {
          ok: false,
          error: 'Cannot download from ' + RESTRICTED_SCHEMES[i] + ' URLs',
          code: 'restricted_scheme',
        };
      }
    }

    var parsed;
    try {
      parsed = new URL(trimmed);
    } catch (e) {
      return { ok: false, error: 'Invalid page URL format: ' + String(e), code: 'parse_error' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        error: 'Page URL must use http:// or https:// (got "' + parsed.protocol + '")',
        code: 'bad_scheme',
      };
    }

    if (parsed.username || parsed.password) {
      return {
        ok: false,
        error: 'Page URL must not contain credentials',
        code: 'has_credentials',
      };
    }

    // Trim fragment, preserve query string.
    parsed.hash = '';
    var cleanUrl = parsed.toString();

    return { ok: true, url: cleanUrl };
  }

  // ---------------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------------

  /**
   * Read the stored base URL from browser.storage.local.
   * @returns {Promise<string|null>} The stored URL, or null if unset.
   */
  async function getStoredBaseUrl() {
    try {
      var data = await browser.storage.local.get(STORAGE_KEY);
      return data[STORAGE_KEY] || null;
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Download orchestration
  // ---------------------------------------------------------------------------

  /**
   * Configure the media-roller base URL.
   *
   * Validates and normalizes the URL, then persists to browser.storage.local.
   * Does NOT make any network requests. Does NOT probe the server.
   *
   * @param {string} baseUrl
   * @returns {Promise<{ status: string, url?: string, error?: string, code?: string }>}
   */
  async function configure(baseUrl) {
    if (typeof baseUrl === 'string' && baseUrl.trim() === '') {
      try {
        await browser.storage.local.set({ [STORAGE_KEY]: null });
        return { status: STATUS.OK, url: null };
      } catch (error) {
        return {
          status: STATUS.ERROR,
          error: 'Could not clear server configuration: ' + String(error),
        };
      }
    }
    var result = validateAndNormalizeBaseUrl(baseUrl);
    if (!result.ok) {
      return { status: STATUS.ERROR, error: result.error, code: result.code };
    }

    try {
      var payload = {};
      payload[STORAGE_KEY] = result.url;
      await browser.storage.local.set(payload);
    } catch (e) {
      return {
        status: STATUS.ERROR,
        error: 'Failed to save configuration: ' + String(e),
        code: 'storage_error',
      };
    }

    return { status: STATUS.OK, url: result.url };
  }

  /**
   * Get the current configuration state.
   *
   * @returns {Promise<{ enabled: boolean, baseUrl: string|null }>}
   */
  async function getConfig() {
    var baseUrl = await getStoredBaseUrl();
    return { enabled: baseUrl !== null, baseUrl: baseUrl };
  }

  /**
   * Download the current tab's video via the configured media-roller server.
   *
   * Flow:
   *   1. Verify config is present (base URL stored)
   *   2. Verify 'downloads' permission is granted
   *   3. Check for in-flight download on the same tab
   *   4. Get tab URL from browser.tabs.get (trusted source)
   *   5. Validate page URL (reject restricted/credential URLs)
   *   6. Build download URL with URLSearchParams (prevents arg injection)
   *   7. Start download via browser.downloads.download (native progress)
   *
   * @param {number} tabId - The browser tab whose page URL to download
   * @returns {Promise<{ status: string, id?: number, error?: string, code?: string }>}
   */
  async function downloadTab(tabId) {
    if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) {
      return {
        status: STATUS.ERROR,
        error: 'Invalid tab ID: ' + JSON.stringify(tabId),
        code: 'bad_tab',
      };
    }

    // 1. Config check.
    var baseUrl = await getStoredBaseUrl();
    if (!baseUrl) {
      return {
        status: STATUS.DISABLED,
        error: 'Media Roller is not configured. Set a base URL in settings.',
        code: 'not_configured',
      };
    }

    // 2. Permission check.
    var hasPermission;
    try {
      hasPermission = await browser.permissions.contains({
        permissions: [REQUIRED_PERMISSION],
        data_collection: ['browsingActivity'],
      });
    } catch (e) {
      return {
        status: STATUS.ERROR,
        error: 'Failed to check downloads permission: ' + String(e),
        code: 'perm_check_failed',
      };
    }

    if (!hasPermission) {
      return {
        status: STATUS.PERMISSION_REQUIRED,
        error: 'The "downloads" permission is required to save videos.',
        code: 'permission_required',
      };
    }

    // 3. In-flight check (same tab).
    if (inFlight.has(tabId)) {
      return {
        status: STATUS.IN_FLIGHT,
        error: 'A download is already in progress for this tab.',
        code: 'in_flight',
      };
    }

    var downloadPromise = performDownload(tabId, baseUrl);
    inFlight.set(tabId, downloadPromise);

    try {
      var result = await downloadPromise;
      return result;
    } finally {
      inFlight.delete(tabId);
    }
  }

  /**
   * Internal: perform the download once preconditions are met.
   * @param {number} tabId
   * @param {string} baseUrl
   * @returns {Promise<{ status: string, id?: number, error?: string, code?: string }>}
   */
  async function performDownload(tabId, baseUrl) {
    // 4. Get tab URL from browser API (trusted source, never page messages).
    var tab;
    try {
      tab = await browser.tabs.get(tabId);
    } catch (e) {
      return { status: STATUS.ERROR, error: 'Tab not found: ' + String(e), code: 'tab_not_found' };
    }

    if (!tab || !tab.url) {
      return { status: STATUS.ERROR, error: 'Tab has no navigable URL', code: 'no_tab_url' };
    }

    // 5. Validate page URL.
    var pageResult = validatePageUrl(tab.url);
    if (!pageResult.ok) {
      if (pageResult.code === 'restricted_scheme') {
        return { status: STATUS.RESTRICTED_URL, error: pageResult.error, code: pageResult.code };
      }
      return { status: STATUS.INVALID_URL, error: pageResult.error, code: pageResult.code };
    }

    // 6. Build download URL with URLSearchParams to prevent argument injection.
    //    The endpoint is ALWAYS the fixed "api/download" — never arbitrary paths.
    var params = new URLSearchParams();
    params.set('url', pageResult.url);
    var downloadUrl = baseUrl + ENDPOINT + '?' + params.toString();

    // 7. Start native download. Returns the download ID immediately (started, not completed).
    //    - conflictAction 'uniquify' avoids overwriting existing files.
    //    - saveAs omitted: honors browser default download behavior.
    //    - filename omitted: server should supply via Content-Disposition.
    //    - No fetch/blob buffering: browser handles the transfer natively.
    try {
      var downloadId = await browser.downloads.download({
        url: downloadUrl,
        conflictAction: 'uniquify',
      });

      if (downloadId === undefined || downloadId === null) {
        return {
          status: STATUS.ERROR,
          error: 'Download did not start (no ID returned)',
          code: 'no_download_id',
        };
      }

      return { status: STATUS.OK, id: downloadId };
    } catch (e) {
      var msg = String(e);
      // Surface permission-related errors distinctly.
      if (/access|permission|denied/i.test(msg)) {
        return { status: STATUS.PERMISSION_REQUIRED, error: msg, code: 'permission_denied' };
      }
      return { status: STATUS.ERROR, error: msg, code: 'download_failed' };
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    configure: configure,
    getConfig: getConfig,
    downloadTab: downloadTab,
    STATUS: STATUS,
    // Exposed for unit testing only (not part of the stable runtime API).
    _validateAndNormalizeBaseUrl: validateAndNormalizeBaseUrl,
    _validatePageUrl: validatePageUrl,
  };
})();
