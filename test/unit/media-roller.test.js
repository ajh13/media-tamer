/**
 * Media Roller integration helper — unit tests.
 *
 * TDD: tests the VC_MEDIA_ROLLER namespace reachable from Node.
 * Uses mocked browser.* APIs (storage, permissions, tabs, downloads).
 *
 * Two layers:
 *   1. Pure logic tests — URL validation/normalization (no browser mocks).
 *   2. Integration tests — configure/getConfig/downloadTab with mocked browser APIs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(
  __dirname,
  '..',
  '..',
  'extensions',
  'media-tamer',
  'media-roller.js',
);

function urlWithCredentials(host = 'host') {
  const url = new URL(`http://${host}`);
  url.username = 'test-user';
  url.password = 'test-password';
  return url.href;
}

// =============================================================================
// Load script into a vm context with mocked browser.* APIs
// =============================================================================

/**
 * Create a fresh vm context with VC_MEDIA_ROLLER loaded.
 * Returns { context, browser, VC_MEDIA_ROLLER }.
 *
 * The browser mock tracks:
 *   - storage.local.get/set
 *   - permissions.contains
 *   - tabs.get
 *   - downloads.download
 */
function createContext(overrides = {}) {
  const storageData = overrides.storageData || {};
  const permissionsState = overrides.permissionsState || {};
  const tabsState = overrides.tabsState || {};
  const downloadBehavior = overrides.downloadBehavior || { id: 1 };

  const browserMock = {
    storage: {
      local: {
        get: async (key) => {
          if (typeof key === 'string') {
            const result = {};
            result[key] = storageData[key] !== undefined ? storageData[key] : undefined;
            return result;
          }
          return { ...storageData };
        },
        set: async (obj) => {
          Object.assign(storageData, obj);
        },
      },
    },
    permissions: {
      contains: async (perm) => {
        if (perm && perm.permissions) {
          return (
            perm.permissions.every((p) => permissionsState[p] === true) &&
            (!perm.data_collection || permissionsState.browsingActivity !== false)
          );
        }
        return false;
      },
    },
    tabs: {
      get: async (tabId) => {
        if (tabsState[tabId] !== undefined) {
          return tabsState[tabId];
        }
        throw new Error('Tab not found: ' + tabId);
      },
    },
    downloads: {
      download: async (_opts) => {
        if (downloadBehavior.throw) {
          throw new Error(downloadBehavior.throw);
        }
        return downloadBehavior.id;
      },
    },
  };

  const context = vm.createContext({
    browser: browserMock,
    URLSearchParams: URLSearchParams,
    URL: URL,
    console: console,
  });

  const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
  vm.runInContext(code, context);

  return {
    context,
    browser: browserMock,
    storageData,
    permissionsState,
    tabsState,
    downloadBehavior,
  };
}

// =============================================================================
// Slice 1: Base URL validation — pure logic
// =============================================================================

test('clearing the configured URL disables downloads without network activity', async () => {
  const { context, storageData } = createContext({
    storageData: { mediaRollerBaseUrl: 'https://roller.test/' },
  });
  assert.equal((await context.VC_MEDIA_ROLLER.configure('')).status, 'ok');
  assert.equal((await context.VC_MEDIA_ROLLER.getConfig()).enabled, false);
  assert.equal(storageData.mediaRollerBaseUrl, null);
});
test('empty query and fragment markers cannot corrupt the fixed endpoint', () => {
  const { context } = createContext();
  for (const base of ['https://roller.test/?', 'https://roller.test/#']) {
    const result = context.VC_MEDIA_ROLLER._validateAndNormalizeBaseUrl(base);
    assert.equal(result.ok, false);
  }
});
test('revoked URL-transmission consent prevents any download', async () => {
  const { context } = createContext({
    storageData: { mediaRollerBaseUrl: 'https://roller.test/' },
    permissionsState: { downloads: true, browsingActivity: false },
    tabsState: { 1: { url: 'https://video.test/watch' } },
  });
  assert.equal((await context.VC_MEDIA_ROLLER.downloadTab(1)).status, 'permission_required');
});

describe('validateAndNormalizeBaseUrl', () => {
  test('accepts a simple http:// URL and normalizes trailing slash', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validateAndNormalizeBaseUrl('http://127.0.0.1:8080');
    assert.equal(result.ok, true);
    assert.equal(result.url, 'http://127.0.0.1:8080/');
  });

  test('accepts a simple https:// URL and normalizes trailing slash', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validateAndNormalizeBaseUrl(
      'https://media.example.com',
    );
    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://media.example.com/');
  });

  test('preserves existing trailing slash', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validateAndNormalizeBaseUrl('https://host/path/');
    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://host/path/');
  });

  test('accepts a path prefix', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validateAndNormalizeBaseUrl('https://host/prefix');
    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://host/prefix/');
  });

  test('rejects empty string', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validateAndNormalizeBaseUrl('');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'empty');
  });

  test('rejects non-string input', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validateAndNormalizeBaseUrl(12345);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'empty');
  });

  test('rejects ftp:// scheme', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validateAndNormalizeBaseUrl('ftp://host');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'bad_scheme');
  });

  test('rejects file:// scheme', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validateAndNormalizeBaseUrl('file:///etc/passwd');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'bad_scheme');
  });

  test('rejects URL with credentials', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validateAndNormalizeBaseUrl(urlWithCredentials());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'has_credentials');
  });

  test('rejects URL with query string', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validateAndNormalizeBaseUrl('http://host?foo=bar');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'has_query');
  });

  test('rejects URL with fragment', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validateAndNormalizeBaseUrl('http://host#section');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'has_hash');
  });

  test('rejects malformed URL', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validateAndNormalizeBaseUrl('http://[invalid');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'parse_error');
  });
});

// =============================================================================
// Slice 2: Page URL validation — pure logic
// =============================================================================

describe('validatePageUrl', () => {
  test('accepts a standard http URL with query string', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validatePageUrl('https://youtube.com/watch?v=abc123');
    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://youtube.com/watch?v=abc123');
  });

  test('trims fragment but preserves query', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validatePageUrl(
      'https://example.com/page?foo=bar#section',
    );
    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://example.com/page?foo=bar');
  });

  test('rejects about:blank', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validatePageUrl('about:blank');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'restricted_scheme');
  });

  test('rejects file:// URL', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validatePageUrl('file:///home/user/video.mp4');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'restricted_scheme');
  });

  test('rejects blob: URL', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validatePageUrl('blob:https://example.com/uuid');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'restricted_scheme');
  });

  test('rejects data: URL', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validatePageUrl('data:text/html,<h1>hi</h1>');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'restricted_scheme');
  });

  test('rejects javascript: URL', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validatePageUrl('javascript:alert(1)');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'restricted_scheme');
  });

  test('rejects URL with credentials', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validatePageUrl(urlWithCredentials('example.invalid'));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'has_credentials');
  });

  test('rejects empty string', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validatePageUrl('');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'empty');
  });

  test('rejects non-http scheme', () => {
    const { context } = createContext();
    const result = context.VC_MEDIA_ROLLER._validatePageUrl('ftp://host/file');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'bad_scheme');
  });
});

// =============================================================================
// Slice 3: configure() — storage integration
// =============================================================================

describe('configure', () => {
  test('stores a valid base URL', async () => {
    const ctx = createContext();
    const result = await ctx.context.VC_MEDIA_ROLLER.configure('http://127.0.0.1:8080');
    assert.equal(result.status, 'ok');
    assert.equal(result.url, 'http://127.0.0.1:8080/');
    assert.equal(ctx.storageData.mediaRollerBaseUrl, 'http://127.0.0.1:8080/');
  });

  test('rejects invalid URL without storing', async () => {
    const ctx = createContext();
    const result = await ctx.context.VC_MEDIA_ROLLER.configure('not-a-url');
    assert.equal(result.status, 'error');
    assert.equal(ctx.storageData.mediaRollerBaseUrl, undefined);
  });

  test('rejects URL with credentials', async () => {
    const ctx = createContext();
    const result = await ctx.context.VC_MEDIA_ROLLER.configure(urlWithCredentials());
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'has_credentials');
  });

  test('handles storage failure gracefully', async () => {
    const ctx = createContext();
    // Override set to throw
    ctx.browser.storage.local.set = async () => {
      throw new Error('Storage quota exceeded');
    };
    const result = await ctx.context.VC_MEDIA_ROLLER.configure('http://host');
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'storage_error');
  });
});

// =============================================================================
// Slice 4: getConfig() — read configuration state
// =============================================================================

describe('getConfig', () => {
  test('returns disabled when no URL stored', async () => {
    const ctx = createContext();
    const result = await ctx.context.VC_MEDIA_ROLLER.getConfig();
    assert.equal(result.enabled, false);
    assert.equal(result.baseUrl, null);
  });

  test('returns enabled with URL when stored', async () => {
    const ctx = createContext({ storageData: { mediaRollerBaseUrl: 'http://host/' } });
    const result = await ctx.context.VC_MEDIA_ROLLER.getConfig();
    assert.equal(result.enabled, true);
    assert.equal(result.baseUrl, 'http://host/');
  });
});

// =============================================================================
// Slice 5: downloadTab() — full orchestration
// =============================================================================

describe('downloadTab', () => {
  test('returns disabled when no base URL configured', async () => {
    const ctx = createContext();
    const result = await ctx.context.VC_MEDIA_ROLLER.downloadTab(1);
    assert.equal(result.status, 'disabled');
    assert.equal(result.code, 'not_configured');
  });

  test('returns permission_required when downloads permission missing', async () => {
    const ctx = createContext({
      storageData: { mediaRollerBaseUrl: 'http://host/' },
      permissionsState: { downloads: false },
    });
    const result = await ctx.context.VC_MEDIA_ROLLER.downloadTab(1);
    assert.equal(result.status, 'permission_required');
    assert.equal(result.code, 'permission_required');
  });

  test('returns invalid_url for restricted tab URL', async () => {
    const ctx = createContext({
      storageData: { mediaRollerBaseUrl: 'http://host/' },
      permissionsState: { downloads: true },
      tabsState: { 1: { id: 1, url: 'about:blank' } },
    });
    const result = await ctx.context.VC_MEDIA_ROLLER.downloadTab(1);
    assert.equal(result.status, 'restricted_url');
  });

  test('returns error for nonexistent tab', async () => {
    const ctx = createContext({
      storageData: { mediaRollerBaseUrl: 'http://host/' },
      permissionsState: { downloads: true },
      // tabsState empty — browser.tabs.get will throw
    });
    const result = await ctx.context.VC_MEDIA_ROLLER.downloadTab(999);
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'tab_not_found');
  });

  test('returns error for invalid tab ID', async () => {
    const ctx = createContext();
    const result = await ctx.context.VC_MEDIA_ROLLER.downloadTab(-1);
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'bad_tab');
  });

  test('returns in_flight when same tab already downloading', async () => {
    const ctx = createContext({
      storageData: { mediaRollerBaseUrl: 'http://host/' },
      permissionsState: { downloads: true },
      tabsState: { 1: { id: 1, url: 'https://youtube.com/watch?v=abc' } },
      downloadBehavior: { id: 42 },
    });

    // Start two downloads on the same tab without awaiting
    const p1 = ctx.context.VC_MEDIA_ROLLER.downloadTab(1);
    const p2 = ctx.context.VC_MEDIA_ROLLER.downloadTab(1);

    const r2 = await p2;
    assert.equal(r2.status, 'in_flight');

    // First one should complete normally
    const r1 = await p1;
    assert.equal(r1.status, 'ok');
    assert.equal(r1.id, 42);
  });

  test('builds correct download URL with URLSearchParams', async () => {
    let capturedUrl = null;
    const ctx = createContext({
      storageData: { mediaRollerBaseUrl: 'http://127.0.0.1:8080/' },
      permissionsState: { downloads: true },
      tabsState: { 1: { id: 1, url: 'https://youtube.com/watch?v=abc123' } },
      downloadBehavior: { id: 7 },
    });
    // Capture the URL passed to downloads.download
    ctx.browser.downloads.download = async (opts) => {
      capturedUrl = opts.url;
      return 7;
    };

    const result = await ctx.context.VC_MEDIA_ROLLER.downloadTab(1);
    assert.equal(result.status, 'ok');
    assert.equal(result.id, 7);

    // Verify URL structure
    assert.ok(capturedUrl.startsWith('http://127.0.0.1:8080/api/download?url='));
    const parsed = new URL(capturedUrl);
    assert.equal(parsed.pathname, '/api/download');
    assert.equal(parsed.searchParams.get('url'), 'https://youtube.com/watch?v=abc123');
  });

  test('trims fragment from page URL before download', async () => {
    let capturedUrl = null;
    const ctx = createContext({
      storageData: { mediaRollerBaseUrl: 'http://host/' },
      permissionsState: { downloads: true },
      tabsState: { 1: { id: 1, url: 'https://example.com/page?foo=bar#section' } },
      downloadBehavior: { id: 1 },
    });
    ctx.browser.downloads.download = async (opts) => {
      capturedUrl = opts.url;
      return 1;
    };

    await ctx.context.VC_MEDIA_ROLLER.downloadTab(1);
    const parsed = new URL(capturedUrl);
    assert.equal(parsed.searchParams.get('url'), 'https://example.com/page?foo=bar');
  });

  test('passes conflictAction uniquify and omits saveAs', async () => {
    let capturedOpts = null;
    const ctx = createContext({
      storageData: { mediaRollerBaseUrl: 'http://host/' },
      permissionsState: { downloads: true },
      tabsState: { 1: { id: 1, url: 'https://example.com' } },
      downloadBehavior: { id: 1 },
    });
    ctx.browser.downloads.download = async (opts) => {
      capturedOpts = opts;
      return 1;
    };

    await ctx.context.VC_MEDIA_ROLLER.downloadTab(1);
    assert.equal(capturedOpts.conflictAction, 'uniquify');
    assert.equal(capturedOpts.saveAs, undefined);
    assert.equal(capturedOpts.filename, undefined);
  });

  test('does NOT make a HEAD request before download — relies on Content-Disposition from server response', async () => {
    let capturedOpts = null;
    let fetchCallCount = 0;
    const ctx = createContext({
      storageData: { mediaRollerBaseUrl: 'http://127.0.0.1:8080/' },
      permissionsState: { downloads: true },
      tabsState: { 1: { id: 1, url: 'https://example.com/video' } },
      downloadBehavior: { id: 7 },
    });
    ctx.browser.downloads.download = async (opts) => {
      capturedOpts = opts;
      return 7;
    };
    // Inject a fetch mock to detect HEAD requests
    ctx.context.fetch = async (_url, _opts) => {
      fetchCallCount++;
      return { headers: { get: () => null } };
    };

    const result = await ctx.context.VC_MEDIA_ROLLER.downloadTab(1);
    assert.equal(result.status, 'ok');
    assert.equal(fetchCallCount, 0, 'fetch must NOT be called (no HEAD request)');
    assert.equal(
      capturedOpts.filename,
      undefined,
      'filename must come from Content-Disposition, not client-side extraction',
    );
  });

  test('does NOT add filename from unsanitized regex — browser handles Content-Disposition', async () => {
    // Regression test: a server supplying Content-Disposition with special chars
    // in filename must NOT be parsed by a client-side regex. The browser's
    // native downloader handles Content-Disposition correctly.
    let capturedOpts = null;
    const ctx = createContext({
      storageData: { mediaRollerBaseUrl: 'http://host/' },
      permissionsState: { downloads: true },
      tabsState: { 1: { id: 1, url: 'https://example.com/video' } },
      downloadBehavior: { id: 1 },
    });
    ctx.browser.downloads.download = async (opts) => {
      capturedOpts = opts;
      return 1;
    };

    await ctx.context.VC_MEDIA_ROLLER.downloadTab(1);
    assert.equal(capturedOpts.filename, undefined);
    // Verify the download URL is the api/download endpoint (not a custom path)
    assert.ok(capturedOpts.url.includes('/api/download?url='));
  });

  test('surfaces download errors', async () => {
    const ctx = createContext({
      storageData: { mediaRollerBaseUrl: 'http://host/' },
      permissionsState: { downloads: true },
      tabsState: { 1: { id: 1, url: 'https://example.com' } },
      downloadBehavior: { throw: 'Network error' },
    });
    const result = await ctx.context.VC_MEDIA_ROLLER.downloadTab(1);
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'download_failed');
  });

  test('surfaces permission errors distinctly', async () => {
    const ctx = createContext({
      storageData: { mediaRollerBaseUrl: 'http://host/' },
      permissionsState: { downloads: true },
      tabsState: { 1: { id: 1, url: 'https://example.com' } },
      downloadBehavior: { throw: 'Permission denied for downloads' },
    });
    const result = await ctx.context.VC_MEDIA_ROLLER.downloadTab(1);
    assert.equal(result.status, 'permission_required');
    assert.equal(result.code, 'permission_denied');
  });

  test('clears in-flight state after download completes', async () => {
    const ctx = createContext({
      storageData: { mediaRollerBaseUrl: 'http://host/' },
      permissionsState: { downloads: true },
      tabsState: { 1: { id: 1, url: 'https://example.com' } },
      downloadBehavior: { id: 1 },
    });

    await ctx.context.VC_MEDIA_ROLLER.downloadTab(1);

    // Now a second download should succeed (not in_flight)
    const result2 = await ctx.context.VC_MEDIA_ROLLER.downloadTab(1);
    assert.equal(result2.status, 'ok');
  });
});

// =============================================================================
// Slice 6: STATUS constants
// =============================================================================

describe('STATUS constants', () => {
  test('exposes all required status codes', () => {
    const { context } = createContext();
    const STATUS = context.VC_MEDIA_ROLLER.STATUS;
    assert.equal(STATUS.OK, 'ok');
    assert.equal(STATUS.ERROR, 'error');
    assert.equal(STATUS.DISABLED, 'disabled');
    assert.equal(STATUS.PERMISSION_REQUIRED, 'permission_required');
    assert.equal(STATUS.INVALID_URL, 'invalid_url');
    assert.equal(STATUS.RESTRICTED_URL, 'restricted_url');
    assert.equal(STATUS.IN_FLIGHT, 'in_flight');
  });
});

// =============================================================================
// Slice 7: No ES module exports (classic script)
// =============================================================================

describe('script structure', () => {
  test('has no ES module exports', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    assert.ok(!code.includes('export '), 'classic script should not use ES exports');
    assert.ok(!code.includes('export{'), 'classic script should not use ES exports');
    assert.ok(!code.includes('export default'), 'classic script should not use ES default export');
  });

  test('assigns VC_MEDIA_ROLLER as a var global', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    assert.ok(code.includes('var VC_MEDIA_ROLLER'), 'should declare VC_MEDIA_ROLLER as var');
  });

  test('uses IIFE pattern', () => {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    assert.ok(code.includes('(function ()'), 'should use IIFE');
    assert.ok(code.includes('})();'), 'should close IIFE');
  });
});
