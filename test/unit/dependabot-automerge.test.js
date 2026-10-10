/**
 * Unit tests for scripts/dependabot-automerge.mjs eligibility logic.
 *
 * Tests the pure functions and evaluateEligibility() with mocked inputs.
 * Does NOT test the GitHub API calls (those require network/auth).
 *
 * Security-critical gate for auto-merging Dependabot PRs. Tests verify:
 * - Lockfile changes are validated (7-day cooldown for ALL versions)
 * - Registry URL + integrity are validated
 * - Only devDependencies are allowed (no runtime changes)
 * - Metadata outside devDependencies must be identical
 * - No prerelease, downgrade, or invalid versions
 * - CI must pass on exact head SHA (ci.yml + expected jobs)
 * - allChecksGreen must be true
 * - Same repo, non-draft, mergeable, no CHANGES_REQUESTED
 * - Date validity (NaN fails closed)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSemver,
  semverDiffType,
  isNonRegistryVersion,
  extractLockfileVersions,
  extractPackageJsonChanges,
  detectMetadataChanges,
  evaluateEligibility,
  findLockfileEntry,
} from '../../scripts/dependabot-automerge.mjs';

describe('parseSemver', () => {
  test('parses basic semver', () => {
    assert.deepEqual(parseSemver('1.2.3'), {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
      raw: '1.2.3',
    });
  });

  test('parses prerelease', () => {
    assert.deepEqual(parseSemver('1.2.3-beta.1'), {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: 'beta.1',
      raw: '1.2.3-beta.1',
    });
  });

  test('parses build metadata', () => {
    assert.deepEqual(parseSemver('1.2.3+build.123'), {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
      raw: '1.2.3+build.123',
    });
  });

  test('returns null for invalid', () => {
    assert.equal(parseSemver('not-a-version'), null);
    assert.equal(parseSemver(''), null);
    assert.equal(parseSemver(null), null);
    assert.equal(parseSemver(42), null);
    assert.equal(parseSemver('1.2'), null);
    assert.equal(parseSemver('v1.2.3'), null);
  });
});

describe('semverDiffType', () => {
  test('detects patch bump', () => {
    assert.equal(semverDiffType('1.0.0', '1.0.1'), 'patch');
    assert.equal(semverDiffType('2.3.4', '2.3.10'), 'patch');
  });

  test('detects minor bump', () => {
    assert.equal(semverDiffType('1.0.0', '1.1.0'), 'minor');
    assert.equal(semverDiffType('2.3.4', '2.4.0'), 'minor');
  });

  test('detects major bump', () => {
    assert.equal(semverDiffType('1.0.0', '2.0.0'), 'major');
    assert.equal(semverDiffType('2.3.4', '3.0.0'), 'major');
  });

  test('detects downgrade', () => {
    assert.equal(semverDiffType('2.0.0', '1.0.0'), 'downgrade');
    assert.equal(semverDiffType('1.1.0', '1.0.9'), 'downgrade');
    assert.equal(semverDiffType('1.0.1', '1.0.0'), 'downgrade');
  });

  test('detects equal', () => {
    assert.equal(semverDiffType('1.0.0', '1.0.0'), 'equal');
  });

  test('detects prerelease change', () => {
    assert.equal(semverDiffType('1.0.0', '1.0.1-beta.1'), 'prerelease');
    assert.equal(semverDiffType('1.0.0-alpha.1', '1.0.0-alpha.2'), 'prerelease');
  });

  test('detects invalid', () => {
    assert.equal(semverDiffType('garbage', '1.0.0'), 'invalid');
    assert.equal(semverDiffType('1.0.0', 'garbage'), 'invalid');
    assert.equal(semverDiffType(null, '1.0.0'), 'invalid');
  });
});

describe('isNonRegistryVersion', () => {
  test('rejects git URLs', () => {
    assert.equal(isNonRegistryVersion('git+https://github.com/foo/bar.git'), true);
    assert.equal(isNonRegistryVersion('github:foo/bar'), true);
  });

  test('rejects file/workspace protocols', () => {
    assert.equal(isNonRegistryVersion('file:../local'), true);
    assert.equal(isNonRegistryVersion('workspace:*'), true);
    assert.equal(isNonRegistryVersion('link:../foo'), true);
  });

  test('rejects http and github tarball URLs', () => {
    assert.equal(isNonRegistryVersion('http://example.com/foo.tgz'), true);
    assert.equal(isNonRegistryVersion('https://github.com/foo/bar/archive/v1.0.0.tar.gz'), true);
  });

  test('accepts registry versions', () => {
    assert.equal(isNonRegistryVersion('^1.0.0'), false);
    assert.equal(isNonRegistryVersion('~1.0.0'), false);
    assert.equal(isNonRegistryVersion('1.2.3'), false);
    assert.equal(isNonRegistryVersion('>=1.0.0 <2.0.0'), false);
  });
});

describe('findLockfileEntry', () => {
  test('finds top-level entry by name and version', () => {
    const lockfile = {
      packages: {
        'node_modules/eslint': {
          version: '10.0.1',
          resolved: 'https://registry.npmjs.org/eslint/-/eslint-10.0.1.tgz',
          integrity: 'sha512-abc',
        },
      },
    };
    const entry = findLockfileEntry(lockfile, 'eslint', '10.0.1');
    assert.ok(entry);
    assert.equal(entry.resolved, 'https://registry.npmjs.org/eslint/-/eslint-10.0.1.tgz');
    assert.equal(entry.integrity, 'sha512-abc');
  });

  test('finds nested entry with different version (not top-level)', () => {
    const lockfile = {
      packages: {
        'node_modules/whatwg-mimetype': {
          version: '4.0.0',
          resolved: 'https://registry.npmjs.org/whatwg-mimetype/-/whatwg-mimetype-4.0.0.tgz',
          integrity: 'sha512-v4',
        },
        'node_modules/jsdom/node_modules/whatwg-mimetype': {
          version: '5.0.0',
          resolved: 'https://registry.npmjs.org/whatwg-mimetype/-/whatwg-mimetype-5.0.0.tgz',
          integrity: 'sha512-v5',
        },
      },
    };
    const entry = findLockfileEntry(lockfile, 'whatwg-mimetype', '5.0.0');
    assert.ok(entry);
    assert.equal(
      entry.resolved,
      'https://registry.npmjs.org/whatwg-mimetype/-/whatwg-mimetype-5.0.0.tgz',
    );
    assert.equal(entry.integrity, 'sha512-v5');
  });

  test('returns undefined when version does not match', () => {
    const lockfile = {
      packages: {
        'node_modules/whatwg-mimetype': {
          version: '4.0.0',
          resolved: 'https://registry.npmjs.org/whatwg-mimetype/-/whatwg-mimetype-4.0.0.tgz',
          integrity: 'sha512-v4',
        },
      },
    };
    const entry = findLockfileEntry(lockfile, 'whatwg-mimetype', '5.0.0');
    assert.equal(entry, undefined);
  });

  test('returns undefined for missing package', () => {
    const lockfile = { packages: {} };
    const entry = findLockfileEntry(lockfile, 'missing-pkg', '1.0.0');
    assert.equal(entry, undefined);
  });

  test('handles scoped packages at nested paths', () => {
    const lockfile = {
      packages: {
        'node_modules/@scope/pkg': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz',
          integrity: 'sha512-old',
        },
        'node_modules/parent/node_modules/@scope/pkg': {
          version: '2.0.0',
          resolved: 'https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0.tgz',
          integrity: 'sha512-new',
        },
      },
    };
    const entry = findLockfileEntry(lockfile, '@scope/pkg', '2.0.0');
    assert.ok(entry);
    assert.equal(entry.resolved, 'https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0.tgz');
    assert.equal(entry.integrity, 'sha512-new');
  });

  test('handles null/undefined lockfile', () => {
    assert.equal(findLockfileEntry(null, 'eslint', '1.0.0'), undefined);
    assert.equal(findLockfileEntry(undefined, 'eslint', '1.0.0'), undefined);
    assert.equal(findLockfileEntry({}, 'eslint', '1.0.0'), undefined);
  });

  test('handles deeply nested paths', () => {
    const lockfile = {
      packages: {
        'node_modules/a/node_modules/b/node_modules/c': {
          version: '3.0.0',
          resolved: 'https://registry.npmjs.org/c/-/c-3.0.0.tgz',
          integrity: 'sha512-deep',
        },
      },
    };
    const entry = findLockfileEntry(lockfile, 'c', '3.0.0');
    assert.ok(entry);
    assert.equal(entry.integrity, 'sha512-deep');
  });

  test('direct match takes precedence over nested same-name', () => {
    const lockfile = {
      packages: {
        'node_modules/shared': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/shared/-/shared-1.0.0.tgz',
          integrity: 'sha512-direct',
        },
        'node_modules/parent/node_modules/shared': {
          version: '2.0.0',
          resolved: 'https://registry.npmjs.org/shared/-/shared-2.0.0.tgz',
          integrity: 'sha512-nested',
        },
      },
    };
    const directEntry = findLockfileEntry(lockfile, 'shared', '1.0.0');
    assert.ok(directEntry);
    assert.equal(directEntry.integrity, 'sha512-direct');

    const nestedEntry = findLockfileEntry(lockfile, 'shared', '2.0.0');
    assert.ok(nestedEntry);
    assert.equal(nestedEntry.integrity, 'sha512-nested');
  });
});

describe('extractLockfileVersions', () => {
  test('extracts top-level and nested versions', () => {
    const lockfile = {
      packages: {
        'node_modules/eslint': { version: '10.0.1' },
        'node_modules/prettier': { version: '3.0.0' },
        '': { name: 'test' },
      },
    };
    const versions = extractLockfileVersions(lockfile);
    assert.equal(versions.length, 2);
    assert.ok(versions.find((v) => v.name === 'eslint' && v.version === '10.0.1'));
    assert.ok(versions.find((v) => v.name === 'prettier' && v.version === '3.0.0'));
  });

  test('extracts nested transitive dependencies', () => {
    const lockfile = {
      packages: {
        'node_modules/eslint': { version: '10.0.1' },
        'node_modules/eslint/node_modules/some-transitive': { version: '2.5.0' },
      },
    };
    const versions = extractLockfileVersions(lockfile);
    assert.equal(versions.length, 2);
    assert.ok(versions.find((v) => v.name === 'eslint' && v.version === '10.0.1'));
    assert.ok(versions.find((v) => v.name === 'some-transitive' && v.version === '2.5.0'));
  });

  test('handles scoped packages', () => {
    const lockfile = {
      packages: {
        'node_modules/@scope/pkg': { version: '1.0.0' },
      },
    };
    const versions = extractLockfileVersions(lockfile);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].name, '@scope/pkg');
    assert.equal(versions[0].version, '1.0.0');
  });

  test('skips root entry', () => {
    const lockfile = { packages: { '': { name: 'test' } } };
    const versions = extractLockfileVersions(lockfile);
    assert.equal(versions.length, 0);
  });

  test('skips entries without version', () => {
    const lockfile = { packages: { 'node_modules/eslint': {} } };
    const versions = extractLockfileVersions(lockfile);
    assert.equal(versions.length, 0);
  });
});

describe('extractPackageJsonChanges', () => {
  test('detects patch bump in devDependencies', () => {
    const before = { devDependencies: { eslint: '10.0.0' } };
    const after = { devDependencies: { eslint: '10.0.1' } };
    const changes = extractPackageJsonChanges(before, after);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].name, 'eslint');
    assert.equal(changes[0].from, '10.0.0');
    assert.equal(changes[0].to, '10.0.1');
    assert.equal(changes[0].type, 'patch');
  });

  test('detects minor bump', () => {
    const before = { devDependencies: { eslint: '10.0.0' } };
    const after = { devDependencies: { eslint: '10.1.0' } };
    const changes = extractPackageJsonChanges(before, after);
    assert.equal(changes[0].type, 'minor');
  });

  test('detects added dependency', () => {
    const before = { devDependencies: {} };
    const after = { devDependencies: { 'new-pkg': '1.0.0' } };
    const changes = extractPackageJsonChanges(before, after);
    assert.equal(changes[0].type, 'added');
  });

  test('detects removed dependency', () => {
    const before = { devDependencies: { 'old-pkg': '1.0.0' } };
    const after = { devDependencies: {} };
    const changes = extractPackageJsonChanges(before, after);
    assert.equal(changes[0].type, 'removed');
  });

  test('detects major bump', () => {
    const before = { devDependencies: { foo: '1.0.0' } };
    const after = { devDependencies: { foo: '2.0.0' } };
    const changes = extractPackageJsonChanges(before, after);
    assert.equal(changes[0].type, 'major');
  });

  test('detects downgrade', () => {
    const before = { devDependencies: { foo: '2.0.0' } };
    const after = { devDependencies: { foo: '1.0.0' } };
    const changes = extractPackageJsonChanges(before, after);
    assert.equal(changes[0].type, 'downgrade');
  });

  test('detects prerelease bump', () => {
    const before = { devDependencies: { foo: '1.0.0' } };
    const after = { devDependencies: { foo: '1.0.1-beta.1' } };
    const changes = extractPackageJsonChanges(before, after);
    assert.equal(changes[0].type, 'prerelease');
  });

  test('returns empty for no changes', () => {
    const before = { devDependencies: { foo: '1.0.0' } };
    const after = { devDependencies: { foo: '1.0.0' } };
    const changes = extractPackageJsonChanges(before, after);
    assert.equal(changes.length, 0);
  });

  test('flags runtime dependency changes', () => {
    const before = { dependencies: { express: '4.0.0' }, devDependencies: {} };
    const after = { dependencies: { express: '4.1.0' }, devDependencies: {} };
    const changes = extractPackageJsonChanges(before, after);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].name, 'express');
    assert.equal(changes[0].type, 'runtime-change');
  });

  test('handles range prefixes', () => {
    const before = { devDependencies: { eslint: '^10.0.0' } };
    const after = { devDependencies: { eslint: '^10.0.1' } };
    const changes = extractPackageJsonChanges(before, after);
    assert.equal(changes[0].type, 'patch');
  });
});

describe('detectMetadataChanges', () => {
  test('returns empty when only devDependencies change', () => {
    const before = {
      name: 'test',
      version: '1.0.0',
      scripts: { test: 'node --test' },
      devDependencies: { eslint: '10.0.0' },
    };
    const after = {
      name: 'test',
      version: '1.0.0',
      scripts: { test: 'node --test' },
      devDependencies: { eslint: '10.0.1' },
    };
    const changes = detectMetadataChanges(before, after);
    assert.equal(changes.length, 0);
  });

  test('detects scripts change', () => {
    const before = { scripts: { test: 'node --test' }, devDependencies: {} };
    const after = { scripts: { test: 'node --test', extra: 'echo hi' }, devDependencies: {} };
    const changes = detectMetadataChanges(before, after);
    assert.ok(changes.some((c) => c.includes('scripts')));
  });

  test('detects name change', () => {
    const before = { name: 'old-name', devDependencies: {} };
    const after = { name: 'new-name', devDependencies: {} };
    const changes = detectMetadataChanges(before, after);
    assert.ok(changes.some((c) => c.includes('name')));
  });

  test('detects version change', () => {
    const before = { version: '1.0.0', devDependencies: {} };
    const after = { version: '1.0.1', devDependencies: {} };
    const changes = detectMetadataChanges(before, after);
    assert.ok(changes.some((c) => c.includes('version')));
  });

  test('detects engines change', () => {
    const before = { engines: { node: '>=20' }, devDependencies: {} };
    const after = { engines: { node: '>=22' }, devDependencies: {} };
    const changes = detectMetadataChanges(before, after);
    assert.ok(changes.some((c) => c.includes('engines')));
  });

  test('detects peerDependencies change', () => {
    const before = { peerDependencies: { react: '^18' }, devDependencies: {} };
    const after = { peerDependencies: { react: '^19' }, devDependencies: {} };
    const changes = detectMetadataChanges(before, after);
    assert.ok(changes.some((c) => c.includes('peerDependencies')));
  });

  test('ignores dependencies key (runtime changes caught elsewhere)', () => {
    const before = { dependencies: { express: '4.0.0' }, devDependencies: {} };
    const after = { dependencies: { express: '4.1.0' }, devDependencies: {} };
    const changes = detectMetadataChanges(before, after);
    assert.equal(changes.length, 0);
  });
});

describe('evaluateEligibility', () => {
  const basePr = {
    user: { login: 'dependabot[bot]' },
    base: { ref: 'main', repo: { full_name: 'example-owner/media-tamer' } },
    state: 'open',
    draft: false,
    mergeable: true,
    head: { sha: 'abc123' },
    repository: { full_name: 'example-owner/media-tamer' },
  };

  const baseParams = ({
    pr = basePr,
    changedFiles = ['package.json', 'package-lock.json'],
    packageJsonBefore = { devDependencies: { eslint: '10.0.0' } },
    packageJsonAfter = { devDependencies: { eslint: '10.0.1' } },
    lockfileBefore = { packages: {} },
    lockfileAfter = { packages: { 'node_modules/eslint': { version: '10.0.1' } } },
    ciStatus = {
      passing: true,
      latestHeadSha: 'abc123',
      allChecksGreen: true,
      ciWorkflowSuccess: true,
      expectedJobsPassing: true,
    },
    registryValidation = new Map([
      ['eslint@10.0.1', { valid: true, ageOk: true, urlMatch: true, integrityMatch: true }],
    ]),
    reviews = [],
    sameRepo = true,
    cooldownDays = 7,
  } = {}) => ({
    pr,
    changedFiles,
    packageJsonBefore,
    packageJsonAfter,
    lockfileBefore,
    lockfileAfter,
    ciStatus,
    registryValidation,
    reviews,
    sameRepo,
    cooldownDays,
  });

  test('eligible: basic patch bump, CI green, old version', () => {
    const result = evaluateEligibility(baseParams());
    assert.equal(result.eligible, true);
    assert.equal(result.reasons.length, 0);
  });

  test('eligible: minor bump', () => {
    const result = evaluateEligibility(
      baseParams({
        packageJsonAfter: { devDependencies: { eslint: '10.1.0' } },
        lockfileAfter: { packages: { 'node_modules/eslint': { version: '10.1.0' } } },
        registryValidation: new Map([
          ['eslint@10.1.0', { valid: true, ageOk: true, urlMatch: true, integrityMatch: true }],
        ]),
      }),
    );
    assert.equal(result.eligible, true);
  });

  // --- Author checks ---
  test('reject: wrong author', () => {
    const result = evaluateEligibility(
      baseParams({ pr: { ...basePr, user: { login: 'evil-bot' } } }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('dependabot')));
  });

  test('reject: author missing', () => {
    const result = evaluateEligibility(baseParams({ pr: { ...basePr, user: null } }));
    assert.equal(result.eligible, false);
  });

  // --- Base branch checks ---
  test('reject: base not main', () => {
    const result = evaluateEligibility(
      baseParams({
        pr: {
          ...basePr,
          base: { ref: 'feature-branch', repo: { full_name: 'example-owner/media-tamer' } },
        },
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('main')));
  });

  // --- State checks ---
  test('reject: not open', () => {
    const result = evaluateEligibility(baseParams({ pr: { ...basePr, state: 'closed' } }));
    assert.equal(result.eligible, false);
  });

  test('reject: draft PR', () => {
    const result = evaluateEligibility(baseParams({ pr: { ...basePr, draft: true } }));
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('draft')));
  });

  // --- Mergeable checks ---
  test('reject: not mergeable', () => {
    const result = evaluateEligibility(baseParams({ pr: { ...basePr, mergeable: false } }));
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('mergeable')));
  });

  test('reject: mergeable unknown (null)', () => {
    const result = evaluateEligibility(baseParams({ pr: { ...basePr, mergeable: null } }));
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('mergeable')));
  });

  // --- Review checks ---
  test('reject: CHANGES_REQUESTED review', () => {
    const result = evaluateEligibility(
      baseParams({ reviews: [{ author: { login: 'reviewer1' }, state: 'CHANGES_REQUESTED' }] }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('CHANGES_REQUESTED')));
  });

  test('no rejection: APPROVED review', () => {
    const result = evaluateEligibility(
      baseParams({ reviews: [{ author: { login: 'reviewer1' }, state: 'APPROVED' }] }),
    );
    assert.ok(!result.reasons.some((r) => r.includes('CHANGES_REQUESTED')));
  });

  test('no rejection: COMMENTED review', () => {
    const result = evaluateEligibility(
      baseParams({ reviews: [{ author: { login: 'reviewer1' }, state: 'COMMENTED' }] }),
    );
    assert.ok(!result.reasons.some((r) => r.includes('CHANGES_REQUESTED')));
  });

  test('reject: latest CHANGES_REQUESTED overrides earlier APPROVED (same reviewer)', () => {
    const result = evaluateEligibility(
      baseParams({
        reviews: [
          {
            author: { login: 'reviewer1' },
            state: 'APPROVED',
            submitted_at: '2024-01-01T00:00:00Z',
          },
          {
            author: { login: 'reviewer1' },
            state: 'CHANGES_REQUESTED',
            submitted_at: '2024-01-02T00:00:00Z',
          },
        ],
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('CHANGES_REQUESTED')));
  });

  // --- Changed files checks ---
  test('reject: unexpected file changes', () => {
    const result = evaluateEligibility(
      baseParams({ changedFiles: ['package.json', 'package-lock.json', 'evil.js'] }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('unexpected')));
  });

  test('reject: missing package.json', () => {
    const result = evaluateEligibility(baseParams({ changedFiles: ['package-lock.json'] }));
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('missing')));
  });

  test('reject: missing package-lock.json', () => {
    const result = evaluateEligibility(baseParams({ changedFiles: ['package.json'] }));
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('missing')));
  });

  test('reject: only unexpected files', () => {
    const result = evaluateEligibility(baseParams({ changedFiles: ['README.md'] }));
    assert.equal(result.eligible, false);
  });

  // --- CI checks ---
  test('reject: CI not passing', () => {
    const result = evaluateEligibility(
      baseParams({
        ciStatus: {
          passing: false,
          latestHeadSha: 'abc123',
          allChecksGreen: true,
          ciWorkflowSuccess: true,
          expectedJobsPassing: true,
        },
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('CI')));
  });

  test('reject: CI SHA mismatch', () => {
    const result = evaluateEligibility(
      baseParams({
        ciStatus: {
          passing: true,
          latestHeadSha: 'wrong_sha',
          allChecksGreen: true,
          ciWorkflowSuccess: true,
          expectedJobsPassing: true,
        },
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('SHA')));
  });

  test('reject: allChecksGreen false', () => {
    const result = evaluateEligibility(
      baseParams({
        ciStatus: {
          passing: true,
          latestHeadSha: 'abc123',
          allChecksGreen: false,
          ciWorkflowSuccess: true,
          expectedJobsPassing: true,
        },
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('allChecksGreen')));
  });

  test('reject: ci.yml workflow not successful', () => {
    const result = evaluateEligibility(
      baseParams({
        ciStatus: {
          passing: true,
          latestHeadSha: 'abc123',
          allChecksGreen: true,
          ciWorkflowSuccess: false,
          expectedJobsPassing: true,
        },
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('ci.yml')));
  });

  test('reject: expected CI jobs not passing', () => {
    const result = evaluateEligibility(
      baseParams({
        ciStatus: {
          passing: true,
          latestHeadSha: 'abc123',
          allChecksGreen: true,
          ciWorkflowSuccess: true,
          expectedJobsPassing: false,
        },
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('jobs')));
  });

  // --- Version bump type checks ---
  test('reject: major version bump', () => {
    const result = evaluateEligibility(
      baseParams({
        packageJsonAfter: { devDependencies: { eslint: '11.0.0' } },
        lockfileAfter: { packages: { 'node_modules/eslint': { version: '11.0.0' } } },
        registryValidation: new Map([
          ['eslint@11.0.0', { valid: true, ageOk: true, urlMatch: true, integrityMatch: true }],
        ]),
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('major')));
  });

  test('reject: dependency added', () => {
    const result = evaluateEligibility(
      baseParams({
        packageJsonBefore: { devDependencies: {} },
        packageJsonAfter: { devDependencies: { 'new-pkg': '1.0.0' } },
        lockfileAfter: { packages: { 'node_modules/new-pkg': { version: '1.0.0' } } },
        registryValidation: new Map([
          ['new-pkg@1.0.0', { valid: true, ageOk: true, urlMatch: true, integrityMatch: true }],
        ]),
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('added')));
  });

  test('reject: dependency removed', () => {
    const result = evaluateEligibility(
      baseParams({
        packageJsonBefore: { devDependencies: { 'old-pkg': '1.0.0' } },
        packageJsonAfter: { devDependencies: {} },
        lockfileBefore: { packages: { 'node_modules/old-pkg': { version: '1.0.0' } } },
        lockfileAfter: { packages: {} },
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('removed')));
  });

  test('reject: non-registry version', () => {
    const result = evaluateEligibility(
      baseParams({
        packageJsonAfter: { devDependencies: { eslint: 'git+https://github.com/foo/eslint.git' } },
        lockfileAfter: {
          packages: { 'node_modules/eslint': { version: 'git+https://github.com/foo/eslint.git' } },
        },
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('non-registry')));
  });

  test('reject: runtime dependency change', () => {
    const result = evaluateEligibility(
      baseParams({
        packageJsonBefore: { dependencies: { express: '4.0.0' }, devDependencies: {} },
        packageJsonAfter: { dependencies: { express: '4.1.0' }, devDependencies: {} },
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('runtime')));
  });

  test('reject: downgrade', () => {
    const result = evaluateEligibility(
      baseParams({
        packageJsonBefore: { devDependencies: { eslint: '10.0.1' } },
        packageJsonAfter: { devDependencies: { eslint: '10.0.0' } },
        lockfileAfter: { packages: { 'node_modules/eslint': { version: '10.0.0' } } },
        registryValidation: new Map([
          ['eslint@10.0.0', { valid: true, ageOk: true, urlMatch: true, integrityMatch: true }],
        ]),
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('downgrade')));
  });

  test('reject: prerelease version', () => {
    const result = evaluateEligibility(
      baseParams({
        packageJsonAfter: { devDependencies: { eslint: '10.0.1-beta.1' } },
        lockfileAfter: { packages: { 'node_modules/eslint': { version: '10.0.1-beta.1' } } },
        registryValidation: new Map([
          [
            'eslint@10.0.1-beta.1',
            { valid: true, ageOk: true, urlMatch: true, integrityMatch: true },
          ],
        ]),
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('prerelease')));
  });

  test('reject: invalid semver', () => {
    const result = evaluateEligibility(
      baseParams({
        packageJsonAfter: { devDependencies: { eslint: 'not-a-version' } },
        lockfileAfter: { packages: { 'node_modules/eslint': { version: 'not-a-version' } } },
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('invalid')));
  });

  // --- Metadata change checks ---
  test('reject: scripts changed in package.json', () => {
    const result = evaluateEligibility(
      baseParams({
        packageJsonBefore: {
          scripts: { test: 'node --test' },
          devDependencies: { eslint: '10.0.0' },
        },
        packageJsonAfter: {
          scripts: { test: 'node --test', postinstall: 'echo pwned' },
          devDependencies: { eslint: '10.0.1' },
        },
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('metadata')));
  });

  test('reject: name changed in package.json', () => {
    const result = evaluateEligibility(
      baseParams({
        packageJsonBefore: { name: 'original', devDependencies: { eslint: '10.0.0' } },
        packageJsonAfter: { name: 'malicious', devDependencies: { eslint: '10.0.1' } },
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('metadata')));
  });

  // --- Registry validation checks ---
  test('reject: registry validation failed (integrity mismatch)', () => {
    const result = evaluateEligibility(
      baseParams({
        registryValidation: new Map([
          ['eslint@10.0.1', { valid: false, ageOk: true, urlMatch: true, integrityMatch: false }],
        ]),
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('integrity')));
  });

  test('reject: registry validation failed (URL mismatch)', () => {
    const result = evaluateEligibility(
      baseParams({
        registryValidation: new Map([
          ['eslint@10.0.1', { valid: false, ageOk: true, urlMatch: false, integrityMatch: true }],
        ]),
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('registry URL')));
  });

  test('reject: registry validation failed (version too recent)', () => {
    const result = evaluateEligibility(
      baseParams({
        registryValidation: new Map([
          ['eslint@10.0.1', { valid: true, ageOk: false, urlMatch: true, integrityMatch: true }],
        ]),
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('7')));
  });

  test('reject: registry validation missing (fail closed)', () => {
    const result = evaluateEligibility(baseParams({ registryValidation: new Map() }));
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('fail closed')));
  });

  // --- Lockfile version checks ---
  test('reject: lockfile version too recent', () => {
    const result = evaluateEligibility(
      baseParams({
        lockfileAfter: {
          packages: {
            'node_modules/eslint': { version: '10.0.1' },
            'node_modules/eslint/node_modules/some-pkg': { version: '2.0.0' },
          },
        },
        registryValidation: new Map([
          ['eslint@10.0.1', { valid: true, ageOk: true, urlMatch: true, integrityMatch: true }],
          ['some-pkg@2.0.0', { valid: true, ageOk: false, urlMatch: true, integrityMatch: true }],
        ]),
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('some-pkg')));
  });

  test('reject: lockfile version missing from registry (fail closed)', () => {
    const result = evaluateEligibility(
      baseParams({
        lockfileAfter: {
          packages: {
            'node_modules/eslint': { version: '10.0.1' },
            'node_modules/eslint/node_modules/some-pkg': { version: '2.0.0' },
          },
        },
        registryValidation: new Map([
          ['eslint@10.0.1', { valid: true, ageOk: true, urlMatch: true, integrityMatch: true }],
          // some-pkg missing
        ]),
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('some-pkg') && r.includes('fail closed')));
  });

  // --- Date validity checks ---
  test('reject: invalid date (NaN) in registry validation', () => {
    const result = evaluateEligibility(
      baseParams({
        registryValidation: new Map([
          ['eslint@10.0.1', { valid: true, ageOk: false, urlMatch: true, integrityMatch: true }],
        ]),
      }),
    );
    assert.equal(result.eligible, false);
  });

  // --- Same repo check ---
  test('reject: PR from different repo (fork)', () => {
    const result = evaluateEligibility(
      baseParams({
        pr: {
          ...basePr,
          base: { ref: 'main', repo: { full_name: 'evil-fork/media-tamer' } },
          repository: { full_name: 'evil-fork/media-tamer' },
        },
        sameRepo: false,
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('repo')));
  });

  // --- Edge cases ---
  test('reject: empty changed files', () => {
    const result = evaluateEligibility(baseParams({ changedFiles: [] }));
    assert.equal(result.eligible, false);
  });

  test('reject: duplicate file entries still pass', () => {
    const result = evaluateEligibility(
      baseParams({ changedFiles: ['package.json', 'package-lock.json', 'package.json'] }),
    );
    assert.equal(result.eligible, true);
  });

  test('eligible: scoped package patch bump', () => {
    const result = evaluateEligibility(
      baseParams({
        packageJsonBefore: { devDependencies: { '@scope/pkg': '1.0.0' } },
        packageJsonAfter: { devDependencies: { '@scope/pkg': '1.0.1' } },
        lockfileAfter: { packages: { 'node_modules/@scope/pkg': { version: '1.0.1' } } },
        registryValidation: new Map([
          ['@scope/pkg@1.0.1', { valid: true, ageOk: true, urlMatch: true, integrityMatch: true }],
        ]),
      }),
    );
    assert.equal(result.eligible, true);
  });

  test('reject: package in both deps and devDeps (runtime change)', () => {
    const result = evaluateEligibility(
      baseParams({
        packageJsonBefore: {
          dependencies: { shared: '1.0.0' },
          devDependencies: { shared: '1.0.0' },
        },
        packageJsonAfter: {
          dependencies: { shared: '1.0.1' },
          devDependencies: { shared: '1.0.1' },
        },
        lockfileAfter: { packages: { 'node_modules/shared': { version: '1.0.1' } } },
        registryValidation: new Map([
          ['shared@1.0.1', { valid: true, ageOk: true, urlMatch: true, integrityMatch: true }],
        ]),
      }),
    );
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.includes('runtime')));
  });
});
