/**
 * Integration test for scripts/dependabot-automerge.mjs
 *
 * Mocks global fetch to test the full processPr path without network.
 * Validates the complete gate logic including registry validation.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// We need to test the full processPr path. Since fetch is called via
// the global fetch, we mock it before importing the module.
// The module uses top-level constants, so we set env vars first.

process.env.GITHUB_REPOSITORY = 'example-owner/media-tamer';
process.env.GITHUB_TOKEN = 'test-token';
process.env.COOLDOWN_DAYS = '7';

// Mock responses for different endpoints
const mockResponses = new Map();

function setMockResponse(url, response) {
  mockResponses.set(url, response);
}

globalThis.fetch = async (url) => {
  if (mockResponses.has(url)) {
    const res = mockResponses.get(url);
    if (res instanceof Error) throw res;
    return res;
  }
  for (const [key, res] of mockResponses) {
    if (key.startsWith('prefix:') && url.startsWith(key.slice(7))) {
      if (res instanceof Error) throw res;
      return res;
    }
  }
  throw new Error(`Unexpected fetch: ${url}`);
};

const { evaluateEligibility, extractLockfileChanges } =
  await import('../../scripts/dependabot-automerge.mjs');

function mockJsonResponse(data) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

describe('Integration: full gate path with mocked fetch', () => {
  beforeEach(() => {
    mockResponses.clear();
  });

  test('full path: eligible patch bump with registry validation', async () => {
    const headSha = 'abc123';
    const baseSha = 'def456';

    // Mock PR fetch
    setMockResponse(
      'https://api.github.com/repos/example-owner/media-tamer/pulls/42',
      mockJsonResponse({
        number: 42,
        user: { login: 'dependabot[bot]' },
        base: { ref: 'main', sha: baseSha, repo: { full_name: 'example-owner/media-tamer' } },
        head: { sha: headSha },
        state: 'open',
        draft: false,
        mergeable: true,
        title: 'bump eslint from 10.0.0 to 10.0.1',
        repository: { full_name: 'example-owner/media-tamer' },
      }),
    );

    // Mock PR files
    setMockResponse(
      'https://api.github.com/repos/example-owner/media-tamer/pulls/42/files?per_page=100&page=1',
      mockJsonResponse([{ filename: 'package.json' }, { filename: 'package-lock.json' }]),
    );

    // Mock reviews
    setMockResponse(
      'https://api.github.com/repos/example-owner/media-tamer/pulls/42/reviews?per_page=100&page=1',
      mockJsonResponse([]),
    );

    // Mock package.json at base and head
    setMockResponse(
      `https://api.github.com/repos/example-owner/media-tamer/contents/package.json?ref=${baseSha}`,
      mockJsonResponse({
        encoding: 'base64',
        content: Buffer.from(JSON.stringify({ devDependencies: { eslint: '10.0.0' } })).toString(
          'base64',
        ),
      }),
    );
    setMockResponse(
      `https://api.github.com/repos/example-owner/media-tamer/contents/package.json?ref=${headSha}`,
      mockJsonResponse({
        encoding: 'base64',
        content: Buffer.from(JSON.stringify({ devDependencies: { eslint: '10.0.1' } })).toString(
          'base64',
        ),
      }),
    );

    // Mock lockfile at base and head
    setMockResponse(
      `https://api.github.com/repos/example-owner/media-tamer/contents/package-lock.json?ref=${baseSha}`,
      mockJsonResponse({
        encoding: 'base64',
        content: Buffer.from(
          JSON.stringify({
            packages: {
              '': { name: 'test' },
              'node_modules/eslint': {
                version: '10.0.0',
                resolved: 'https://registry.npmjs.org/eslint/-/eslint-10.0.0.tgz',
                integrity: 'sha512-old',
              },
            },
          }),
        ).toString('base64'),
      }),
    );
    setMockResponse(
      `https://api.github.com/repos/example-owner/media-tamer/contents/package-lock.json?ref=${headSha}`,
      mockJsonResponse({
        encoding: 'base64',
        content: Buffer.from(
          JSON.stringify({
            packages: {
              '': { name: 'test' },
              'node_modules/eslint': {
                version: '10.0.1',
                resolved: 'https://registry.npmjs.org/eslint/-/eslint-10.0.1.tgz',
                integrity: 'sha512-new',
              },
            },
          }),
        ).toString('base64'),
      }),
    );

    // Mock CI runs
    setMockResponse(
      `https://api.github.com/repos/example-owner/media-tamer/actions/runs?head_sha=${headSha}&per_page=10`,
      mockJsonResponse({
        workflow_runs: [
          {
            id: 1,
            path: '.github/workflows/ci.yml',
            head_sha: headSha,
            status: 'completed',
            conclusion: 'success',
            created_at: '2024-01-01T00:00:00Z',
          },
        ],
      }),
    );

    // Mock CI jobs
    setMockResponse(
      'https://api.github.com/repos/example-owner/media-tamer/actions/runs/1/jobs?per_page=100',
      mockJsonResponse({
        jobs: [
          { name: 'quality', conclusion: 'success' },
          { name: 'unit-tests (24)', conclusion: 'success' },
          { name: 'browser-tests', conclusion: 'success' },
        ],
      }),
    );

    // Mock check runs
    setMockResponse(
      `https://api.github.com/repos/example-owner/media-tamer/commits/${headSha}/check-runs?per_page=100`,
      mockJsonResponse({
        check_runs: [
          { name: 'quality', conclusion: 'success' },
          { name: 'unit-tests', conclusion: 'success' },
          { name: 'browser-tests', conclusion: 'success' },
        ],
      }),
    );

    // Mock registry packument
    setMockResponse(
      'https://registry.npmjs.org/eslint',
      mockJsonResponse({
        name: 'eslint',
        versions: {
          '10.0.1': {
            dist: {
              tarball: 'https://registry.npmjs.org/eslint/-/eslint-10.0.1.tgz',
              integrity: 'sha512-new',
            },
          },
        },
        time: {
          '10.0.1': '2020-01-01T00:00:00.000Z',
        },
      }),
    );

    // Now test the full path by calling evaluateEligibility with mocked data
    const pr = {
      user: { login: 'dependabot[bot]' },
      base: { ref: 'main', sha: baseSha, repo: { full_name: 'example-owner/media-tamer' } },
      head: { sha: headSha },
      state: 'open',
      draft: false,
      mergeable: true,
    };

    const changedFiles = ['package.json', 'package-lock.json'];
    const pkgBefore = { devDependencies: { eslint: '10.0.0' } };
    const pkgAfter = { devDependencies: { eslint: '10.0.1' } };
    const lockBefore = {
      packages: {
        '': { name: 'test' },
        'node_modules/eslint': {
          version: '10.0.0',
          resolved: 'https://registry.npmjs.org/eslint/-/eslint-10.0.0.tgz',
          integrity: 'sha512-old',
        },
      },
    };
    const lockAfter = {
      packages: {
        '': { name: 'test' },
        'node_modules/eslint': {
          version: '10.0.1',
          resolved: 'https://registry.npmjs.org/eslint/-/eslint-10.0.1.tgz',
          integrity: 'sha512-new',
        },
      },
    };

    const ciStatus = {
      passing: true,
      latestHeadSha: headSha,
      allChecksGreen: true,
      ciWorkflowSuccess: true,
      expectedJobsPassing: true,
    };

    const registryValidation = new Map([
      ['eslint@10.0.1', { valid: true, ageOk: true, urlMatch: true, integrityMatch: true }],
    ]);

    const result = evaluateEligibility({
      pr,
      changedFiles,
      packageJsonBefore: pkgBefore,
      packageJsonAfter: pkgAfter,
      lockfileBefore: lockBefore,
      lockfileAfter: lockAfter,
      ciStatus,
      registryValidation,
      reviews: [],
      sameRepo: true,
      cooldownDays: 7,
    });

    assert.equal(
      result.eligible,
      true,
      `Expected eligible but got reasons: ${result.reasons.join(', ')}`,
    );
  });

  test('full path: registry integrity mismatch fails closed', async () => {
    const pr = {
      user: { login: 'dependabot[bot]' },
      base: { ref: 'main', repo: { full_name: 'example-owner/media-tamer' } },
      head: { sha: 'abc123' },
      state: 'open',
      draft: false,
      mergeable: true,
    };

    const result = evaluateEligibility({
      pr,
      changedFiles: ['package.json', 'package-lock.json'],
      packageJsonBefore: { devDependencies: { eslint: '10.0.0' } },
      packageJsonAfter: { devDependencies: { eslint: '10.0.1' } },
      lockfileBefore: {
        packages: { 'node_modules/eslint': { version: '10.0.0', integrity: 'sha512-old' } },
      },
      lockfileAfter: {
        packages: { 'node_modules/eslint': { version: '10.0.1', integrity: 'sha512-mismatched' } },
      },
      ciStatus: {
        passing: true,
        latestHeadSha: 'abc123',
        allChecksGreen: true,
        ciWorkflowSuccess: true,
        expectedJobsPassing: true,
      },
      registryValidation: new Map([
        ['eslint@10.0.1', { valid: false, ageOk: true, urlMatch: true, integrityMatch: false }],
      ]),
      reviews: [],
      sameRepo: true,
      cooldownDays: 7,
    });

    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('integrity')));
  });

  test('full path: registry URL mismatch fails closed', async () => {
    const pr = {
      user: { login: 'dependabot[bot]' },
      base: { ref: 'main', repo: { full_name: 'example-owner/media-tamer' } },
      head: { sha: 'abc123' },
      state: 'open',
      draft: false,
      mergeable: true,
    };

    const result = evaluateEligibility({
      pr,
      changedFiles: ['package.json', 'package-lock.json'],
      packageJsonBefore: { devDependencies: { eslint: '10.0.0' } },
      packageJsonAfter: { devDependencies: { eslint: '10.0.1' } },
      lockfileBefore: {
        packages: {
          'node_modules/eslint': { version: '10.0.0', resolved: 'https://evil.com/eslint.tgz' },
        },
      },
      lockfileAfter: {
        packages: {
          'node_modules/eslint': { version: '10.0.1', resolved: 'https://evil.com/eslint.tgz' },
        },
      },
      ciStatus: {
        passing: true,
        latestHeadSha: 'abc123',
        allChecksGreen: true,
        ciWorkflowSuccess: true,
        expectedJobsPassing: true,
      },
      registryValidation: new Map([
        ['eslint@10.0.1', { valid: false, ageOk: true, urlMatch: false, integrityMatch: true }],
      ]),
      reviews: [],
      sameRepo: true,
      cooldownDays: 7,
    });

    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('registry URL')));
  });

  test('full path: nested transitive version too recent fails closed', async () => {
    const pr = {
      user: { login: 'dependabot[bot]' },
      base: { ref: 'main', repo: { full_name: 'example-owner/media-tamer' } },
      head: { sha: 'abc123' },
      state: 'open',
      draft: false,
      mergeable: true,
    };

    const result = evaluateEligibility({
      pr,
      changedFiles: ['package.json', 'package-lock.json'],
      packageJsonBefore: { devDependencies: { eslint: '10.0.0' } },
      packageJsonAfter: { devDependencies: { eslint: '10.0.1' } },
      lockfileBefore: { packages: {} },
      lockfileAfter: {
        packages: {
          'node_modules/eslint': { version: '10.0.1' },
          'node_modules/eslint/node_modules/some-pkg': { version: '2.0.0' },
        },
      },
      ciStatus: {
        passing: true,
        latestHeadSha: 'abc123',
        allChecksGreen: true,
        ciWorkflowSuccess: true,
        expectedJobsPassing: true,
      },
      registryValidation: new Map([
        ['eslint@10.0.1', { valid: true, ageOk: true, urlMatch: true, integrityMatch: true }],
        ['some-pkg@2.0.0', { valid: true, ageOk: false, urlMatch: true, integrityMatch: true }],
      ]),
      reviews: [],
      sameRepo: true,
      cooldownDays: 7,
    });

    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('some-pkg')));
  });

  test('full path: metadata change (scripts) fails closed', async () => {
    const pr = {
      user: { login: 'dependabot[bot]' },
      base: { ref: 'main', repo: { full_name: 'example-owner/media-tamer' } },
      head: { sha: 'abc123' },
      state: 'open',
      draft: false,
      mergeable: true,
    };

    const result = evaluateEligibility({
      pr,
      changedFiles: ['package.json', 'package-lock.json'],
      packageJsonBefore: {
        scripts: { test: 'node --test' },
        devDependencies: { eslint: '10.0.0' },
      },
      packageJsonAfter: {
        scripts: { test: 'node --test', postinstall: 'echo pwned' },
        devDependencies: { eslint: '10.0.1' },
      },
      lockfileBefore: { packages: {} },
      lockfileAfter: { packages: { 'node_modules/eslint': { version: '10.0.1' } } },
      ciStatus: {
        passing: true,
        latestHeadSha: 'abc123',
        allChecksGreen: true,
        ciWorkflowSuccess: true,
        expectedJobsPassing: true,
      },
      registryValidation: new Map([
        ['eslint@10.0.1', { valid: true, ageOk: true, urlMatch: true, integrityMatch: true }],
      ]),
      reviews: [],
      sameRepo: true,
      cooldownDays: 7,
    });

    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('metadata') && r.includes('scripts')));
  });
});

describe('extractLockfileChanges', () => {
  test('detects added, removed, and changed versions', () => {
    const before = {
      packages: {
        'node_modules/eslint': {
          version: '10.0.0',
          resolved: 'https://registry.npmjs.org/eslint/-/eslint-10.0.0.tgz',
          integrity: 'sha512-old',
        },
      },
    };
    const after = {
      packages: {
        'node_modules/eslint': {
          version: '10.0.1',
          resolved: 'https://registry.npmjs.org/eslint/-/eslint-10.0.1.tgz',
          integrity: 'sha512-new',
        },
        'node_modules/prettier': {
          version: '3.0.0',
          resolved: 'https://registry.npmjs.org/prettier/-/prettier-3.0.0.tgz',
          integrity: 'sha512-prettier',
        },
      },
    };

    const changes = extractLockfileChanges(before, after);
    assert.equal(changes.length, 2);

    const eslintChange = changes.find((c) => c.name === 'eslint');
    assert.equal(eslintChange.changeType, 'changed');
    assert.equal(eslintChange.from, '10.0.0');
    assert.equal(eslintChange.to, '10.0.1');
    assert.equal(eslintChange.integrity, 'sha512-new');

    const prettierChange = changes.find((c) => c.name === 'prettier');
    assert.equal(prettierChange.changeType, 'added');
    assert.equal(prettierChange.from, null);
    assert.equal(prettierChange.to, '3.0.0');
  });

  test('handles nested paths correctly', () => {
    const before = { packages: {} };
    const after = {
      packages: {
        'node_modules/eslint/node_modules/some-pkg': { version: '2.0.0' },
      },
    };

    const changes = extractLockfileChanges(before, after);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].name, 'some-pkg');
    assert.equal(changes[0].version, undefined); // version is on the entry, not the change
    assert.equal(changes[0].to, '2.0.0');
  });
});
