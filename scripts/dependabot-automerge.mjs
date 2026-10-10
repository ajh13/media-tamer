#!/usr/bin/env node
/**
 * dependabot-automerge.mjs
 *
 * Standalone gate script for auto-merging Dependabot npm patch/minor PRs.
 *
 * SAFETY MODEL:
 *   - Runs in a GitHub Actions job with NO checkout of PR code and NO
 *     secrets/PAT. Only the GitHub API token (GITHUB_TOKEN) with minimal
 *     scopes (contents:read, pull-requests:write, actions:read, checks:read).
 *   - Never installs, builds, or executes any dependency.
 *   - Only merges PRs authored by dependabot[bot] from the SAME repo.
 *   - Only merges PRs that change EXACTLY package.json + package-lock.json.
 *   - Only merges patch/minor version bumps of EXISTING devDependencies.
 *   - Requires every changed npm package version (including nested/transitive
 *     in the lockfile) to have been published >= COOLDOWN_DAYS ago.
 *   - Validates registry URL + integrity hash for every changed version.
 *   - Requires the ci.yml workflow to be successful on the exact head SHA.
 *   - Requires all named CI jobs to pass.
 *   - Uses the merge API with sha=headSha to prevent race conditions.
 *   - Verifies merge succeeded by reading back PR state.
 *
 * Usage:
 *   node scripts/dependabot-automerge.mjs            # live merge
 *   node scripts/dependabot-automerge.mjs --dry-run  # report only
 *
 * Environment:
 *   GITHUB_TOKEN (required in live mode) — repo-scoped token.
 *   GITHUB_REPOSITORY (required) — owner/repo.
 *   GITHUB_API_URL (optional) — defaults to https://api.github.com.
 *   PR_NUMBER (optional) — if set, only evaluate that PR.
 *   COOLDOWN_DAYS (optional) — defaults to 7.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(import.meta.url);
const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS ?? 7);
const DRY_RUN = process.argv.includes('--dry-run');
const GITHUB_API = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const TARGET_PR = process.env.PR_NUMBER;

// ---------------------------------------------------------------------------
// Pure eligibility logic (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Parse a semver string into { major, minor, patch, prerelease, raw }.
 * Returns null if not a valid semver.
 */
export function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?(?:\+([a-zA-Z0-9.-]+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || null,
    raw: version,
  };
}

/**
 * Determine the semver bump type between two versions.
 * Returns 'major' | 'minor' | 'patch' | 'prerelease' | 'downgrade' | 'equal' | 'invalid'.
 * Any version with a prerelease tag is classified as 'prerelease'.
 */
export function semverDiffType(from, to) {
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (!a || !b) return 'invalid';
  if (a.prerelease || b.prerelease) return 'prerelease';
  if (a.major !== b.major) return b.major > a.major ? 'major' : 'downgrade';
  if (a.minor !== b.minor) return b.minor > a.minor ? 'minor' : 'downgrade';
  if (a.patch !== b.patch) return b.patch > a.patch ? 'patch' : 'downgrade';
  return 'equal';
}

/**
 * Check if a version string looks like a non-npm registry reference.
 * Git URLs, file paths, and workspace protocols are rejected.
 */
export function isNonRegistryVersion(version) {
  if (typeof version !== 'string') return true;
  if (version.startsWith('git+') || version.startsWith('github:')) return true;
  if (version.startsWith('file:') || version.startsWith('workspace:')) return true;
  if (version.startsWith('link:') || version.startsWith('http://')) return true;
  if (version.startsWith('https://github.com/')) return true;
  return false;
}

/**
 * Extract all versions from a parsed lockfile (single snapshot).
 * Returns array of { name, version } for all node_modules/ entries.
 */
export function extractLockfileVersions(lockfileJson) {
  const versions = [];
  const packages = lockfileJson?.packages ?? {};
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.startsWith('node_modules/')) continue;
    const path = key.slice('node_modules/'.length);
    const parts = path.split('/node_modules/');
    const name = parts[parts.length - 1];
    if (!entry?.version) continue;
    versions.push({ name, version: entry.version });
  }
  return versions;
}

/**
 * Extract changed versions by comparing before/after lockfiles.
 * Returns array of { name, from, to, resolved, integrity, changeType }.
 * changeType is 'added' | 'removed' | 'changed'.
 */
export function extractLockfileChanges(beforeLockfile, afterLockfile) {
  const changes = [];
  const before = beforeLockfile?.packages ?? {};
  const after = afterLockfile?.packages ?? {};

  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    if (!key.startsWith('node_modules/')) continue;
    const path = key.slice('node_modules/'.length);
    const parts = path.split('/node_modules/');
    const name = parts[parts.length - 1];

    const beforeEntry = before[key];
    const afterEntry = after[key];

    if (!beforeEntry && afterEntry) {
      changes.push({
        name,
        from: null,
        to: afterEntry.version,
        resolved: afterEntry.resolved,
        integrity: afterEntry.integrity,
        changeType: 'added',
      });
    } else if (beforeEntry && !afterEntry) {
      changes.push({
        name,
        from: beforeEntry.version,
        to: null,
        resolved: beforeEntry.resolved,
        integrity: beforeEntry.integrity,
        changeType: 'removed',
      });
    } else if (beforeEntry?.version !== afterEntry?.version) {
      changes.push({
        name,
        from: beforeEntry.version,
        to: afterEntry.version,
        resolved: afterEntry.resolved,
        integrity: afterEntry.integrity,
        changeType: 'changed',
      });
    }
  }

  return changes;
}

/**
 * Extract dependency bumps from a parsed package.json diff.
 * Only devDependencies are allowed. Runtime dependency changes are rejected.
 * Returns array of { name, from, to, type }.
 */
export function extractPackageJsonChanges(beforeJson, afterJson) {
  const changes = [];
  const beforeDev = beforeJson?.devDependencies ?? {};
  const afterDev = afterJson?.devDependencies ?? {};
  const beforeRuntime = beforeJson?.dependencies ?? {};
  const afterRuntime = afterJson?.dependencies ?? {};

  // All runtime dependency names (before and after)
  const runtimeNames = new Set([...Object.keys(beforeRuntime), ...Object.keys(afterRuntime)]);

  // Check runtime changes first (any package in dependencies is a runtime change)
  for (const name of runtimeNames) {
    const from = beforeRuntime[name];
    const to = afterRuntime[name];
    if (!from && to) {
      changes.push({ name, from: null, to, type: 'runtime-change' });
    } else if (from && !to) {
      changes.push({ name, from, to: null, type: 'runtime-change' });
    } else if (from !== to) {
      changes.push({ name, from, to, type: 'runtime-change' });
    }
  }

  // Check dev dependency changes (only for names NOT in runtime)
  const devNames = new Set([...Object.keys(beforeDev), ...Object.keys(afterDev)]);
  for (const name of devNames) {
    if (runtimeNames.has(name)) continue; // already flagged as runtime-change
    const from = beforeDev[name];
    const to = afterDev[name];
    if (!from && to) {
      changes.push({ name, from: null, to, type: 'added' });
    } else if (from && !to) {
      changes.push({ name, from, to: null, type: 'removed' });
    } else if (from !== to) {
      const diffType = semverDiffType(cleanSemver(from), cleanSemver(to));
      changes.push({ name, from, to, type: diffType });
    }
  }

  return changes;
}

function cleanSemver(v) {
  if (typeof v !== 'string') return v;
  return v.replace(/^[^\d]*/, '');
}

/**
 * Detect metadata changes in package.json outside devDependencies.
 * Returns array of strings describing changes.
 */
export function detectMetadataChanges(beforeJson, afterJson) {
  const changes = [];
  const before = beforeJson ?? {};
  const after = afterJson ?? {};

  const metadataKeys = [
    'name',
    'version',
    'description',
    'main',
    'type',
    'scripts',
    'engines',
    'os',
    'cpu',
    'private',
    'publishConfig',
    'workspaces',
    'exports',
    'imports',
    'config',
    'peerDependencies',
    'peerDependenciesMeta',
    'optionalDependencies',
    'bundledDependencies',
  ];

  for (const key of metadataKeys) {
    const beforeVal = before[key];
    const afterVal = after[key];
    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      changes.push(`metadata changed: ${key}`);
    }
  }

  return changes;
}

/**
 * Get the latest review per reviewer.
 * Returns Map<login, review>.
 */
function getLatestReviewByReviewer(reviews) {
  const latest = new Map();
  for (const review of reviews) {
    const author = review.user?.login ?? review.author?.login;
    if (!author) continue;
    const submittedAt = review.submitted_at ? new Date(review.submitted_at) : new Date(0);
    const existing = latest.get(author);
    if (!existing || submittedAt > new Date(existing.submitted_at ?? 0)) {
      latest.set(author, review);
    }
  }
  return latest;
}

/**
 * Core eligibility decision.
 *
 * @param {Object} params
 * @param {Object} params.pr — PR object from GitHub API
 * @param {string[]} params.changedFiles — list of filenames from PR
 * @param {Object} params.packageJsonBefore — parsed package.json before
 * @param {Object} params.packageJsonAfter — parsed package.json after
 * @param {Object} params.lockfileBefore — parsed package-lock.json before
 * @param {Object} params.lockfileAfter — parsed package-lock.json after
 * @param {Object} params.ciStatus — { passing, latestHeadSha, allChecksGreen, ciWorkflowSuccess, expectedJobsPassing }
 * @param {Map<string, Object>} params.registryValidation — map of "name@version" -> { valid, ageOk, urlMatch, integrityMatch }
 * @param {Array} params.reviews — array of review objects
 * @param {boolean} params.sameRepo — whether PR base repo matches GITHUB_REPOSITORY
 * @param {number} params.cooldownDays
 * @returns {{ eligible: boolean, reasons: string[] }}
 */
export function evaluateEligibility({
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
}) {
  const reasons = [];

  // 1. Author must be dependabot[bot]
  if (pr.user?.login !== 'dependabot[bot]') {
    reasons.push(`author is ${pr.user?.login ?? 'unknown'}, not dependabot[bot]`);
  }

  // 2. Base branch must be main
  if (pr.base?.ref !== 'main') {
    reasons.push(`base branch is ${pr.base?.ref}, not main`);
  }

  // 3. PR must be open
  if (pr.state !== 'open') {
    reasons.push(`PR state is ${pr.state}, not open`);
  }

  // 4. PR must not be a draft
  if (pr.draft) {
    reasons.push('PR is a draft');
  }

  // 5. PR must be mergeable (true, not just not-false)
  if (pr.mergeable !== true) {
    reasons.push(`PR is not mergeable (mergeable=${pr.mergeable})`);
  }

  // 6. PR must be from the same repo (not a fork)
  if (!sameRepo) {
    reasons.push(`PR from different repository (${pr.base?.repo?.full_name ?? 'unknown'})`);
  }

  // 7. No CHANGES_REQUESTED review (latest per reviewer)
  const latestReviews = getLatestReviewByReviewer(reviews);
  for (const [author, review] of latestReviews) {
    if (review.state === 'CHANGES_REQUESTED') {
      reasons.push(`review CHANGES_REQUESTED by ${author}`);
    }
  }

  // 8. Changed files must be EXACTLY package.json + package-lock.json
  const allowedFiles = new Set(['package.json', 'package-lock.json']);
  const unexpected = changedFiles.filter((f) => !allowedFiles.has(f));
  if (unexpected.length > 0) {
    reasons.push(`unexpected file changes: ${unexpected.join(', ')}`);
  }
  const hasPackageJson = changedFiles.includes('package.json');
  const hasLockfile = changedFiles.includes('package-lock.json');
  if (!hasPackageJson || !hasLockfile) {
    reasons.push(
      `missing expected file changes (package.json: ${hasPackageJson}, lockfile: ${hasLockfile})`,
    );
  }

  // 9. CI must be green on exact head SHA
  if (!ciStatus.passing) {
    reasons.push('CI not passing on exact head SHA');
  }
  if (ciStatus.latestHeadSha !== pr.head?.sha) {
    reasons.push(`CI run SHA ${ciStatus.latestHeadSha} != PR head SHA ${pr.head?.sha}`);
  }
  if (!ciStatus.allChecksGreen) {
    reasons.push('allChecksGreen is false (some check runs not successful)');
  }
  if (!ciStatus.ciWorkflowSuccess) {
    reasons.push('ci.yml workflow not successful on head SHA');
  }
  if (!ciStatus.expectedJobsPassing) {
    reasons.push('expected CI jobs not all passing');
  }

  // 10. All dependency changes must be patch/minor in devDependencies
  const pkgChanges = extractPackageJsonChanges(packageJsonBefore, packageJsonAfter);
  for (const change of pkgChanges) {
    if (change.type === 'added') {
      reasons.push(`dependency added: ${change.name}`);
    } else if (change.type === 'removed') {
      reasons.push(`dependency removed: ${change.name}`);
    } else if (change.type === 'runtime-change') {
      reasons.push(`runtime dependency change: ${change.name} ${change.from} -> ${change.to}`);
    } else if (change.type === 'major') {
      reasons.push(`major version bump: ${change.name} ${change.from} -> ${change.to}`);
    } else if (change.type === 'downgrade') {
      reasons.push(`version downgrade: ${change.name} ${change.from} -> ${change.to}`);
    } else if (change.type === 'prerelease') {
      reasons.push(`prerelease version: ${change.name} ${change.from} -> ${change.to}`);
    } else if (change.type === 'invalid') {
      reasons.push(`invalid semver: ${change.name} ${change.from} -> ${change.to}`);
    }
    if (change.to && isNonRegistryVersion(change.to)) {
      reasons.push(`non-registry version: ${change.name}@${change.to}`);
    }
  }

  // 11. Metadata outside devDependencies must be identical
  const metadataChanges = detectMetadataChanges(packageJsonBefore, packageJsonAfter);
  for (const change of metadataChanges) {
    reasons.push(change);
  }

  // 12. Lockfile changes: validate registry URL + integrity + age for ALL changed versions
  const lockfileChanges = extractLockfileChanges(lockfileBefore, lockfileAfter);
  for (const change of lockfileChanges) {
    if (!change.to || change.changeType === 'removed') continue;
    const key = `${change.name}@${change.to}`;
    const validation = registryValidation.get(key);
    if (!validation) {
      reasons.push(`cannot verify registry for ${key} (fail closed)`);
      continue;
    }
    if (!validation.urlMatch) {
      reasons.push(`registry URL mismatch for ${key}`);
    }
    if (!validation.integrityMatch) {
      reasons.push(`integrity mismatch for ${key}`);
    }
    if (!validation.ageOk) {
      reasons.push(`${key} fails ${cooldownDays}d cooldown`);
    }
  }

  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// GitHub API helpers (only used in live mode)
// ---------------------------------------------------------------------------

async function ghApi(path, { method = 'GET', body } = {}) {
  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${method} ${path} -> ${res.status}: ${text}`);
  }
  return res.json();
}

async function fetchPr(prNumber) {
  return ghApi(`/repos/${REPO}/pulls/${prNumber}`);
}

async function fetchPrFiles(prNumber) {
  const files = [];
  let page = 1;
  while (true) {
    const batch = await ghApi(`/repos/${REPO}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return files.map((f) => f.filename);
}

async function fetchFileAtRef(ref, path) {
  const url = `/repos/${REPO}/contents/${path}?ref=${ref}`;
  const res = await ghApi(url);
  if (res.encoding === 'base64' && res.content) {
    return JSON.parse(Buffer.from(res.content, 'base64').toString('utf8'));
  }
  return null;
}

async function fetchReviews(prNumber) {
  const reviews = [];
  let page = 1;
  while (true) {
    const batch = await ghApi(`/repos/${REPO}/pulls/${prNumber}/reviews?per_page=100&page=${page}`);
    if (!batch.length) break;
    reviews.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return reviews;
}

async function fetchCiStatus(headSha, expectedJobs = ['quality', 'unit-tests', 'browser-tests']) {
  // Find the ci.yml workflow run for the exact head SHA
  const runs = await ghApi(`/repos/${REPO}/actions/runs?head_sha=${headSha}&per_page=10`);
  const ciRun = runs.workflow_runs?.find((r) => r.path === '.github/workflows/ci.yml');

  if (!ciRun) {
    return {
      passing: false,
      latestHeadSha: null,
      allChecksGreen: false,
      ciWorkflowSuccess: false,
      expectedJobsPassing: false,
    };
  }

  const ciWorkflowSuccess = ciRun.conclusion === 'success' && ciRun.status === 'completed';

  // Fetch jobs for the ci.yml run
  const jobsRes = await ghApi(`/repos/${REPO}/actions/runs/${ciRun.id}/jobs?per_page=100`);
  const jobs = jobsRes.jobs ?? [];
  const expectedJobsPassing = expectedJobs.every((name) =>
    jobs.some((j) => j.name.startsWith(name) && j.conclusion === 'success'),
  );

  // Fetch check runs for the head SHA
  const checkRunsRes = await ghApi(`/repos/${REPO}/commits/${headSha}/check-runs?per_page=100`);
  const checkRuns = checkRunsRes.check_runs ?? [];
  const allChecksGreen =
    checkRuns.length > 0 &&
    checkRuns.every((r) => r.conclusion === 'success' || r.conclusion === 'skipped');

  return {
    passing: ciWorkflowSuccess,
    latestHeadSha: ciRun.head_sha,
    allChecksGreen,
    ciWorkflowSuccess,
    expectedJobsPassing,
  };
}

/**
 * Find the lockfile entry matching both package name and version.
 * Crucially, the entry must match the version being validated, because
 * the same package can appear at multiple paths with different versions
 * (e.g. `whatwg-mimetype@4` top-level, `whatwg-mimetype@5` nested under jsdom).
 * Returns { resolved, integrity } or undefined if not found.
 */
export function findLockfileEntry(lockfile, name, version) {
  const packages = lockfile?.packages ?? {};
  // First check the direct path for the name
  const direct = packages[`node_modules/${name}`];
  if (direct?.version === version) return direct;

  // Search nested entries for one matching both name and version
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.startsWith('node_modules/')) continue;
    const path = key.slice('node_modules/'.length);
    const parts = path.split('/node_modules/');
    const entryName = parts[parts.length - 1];
    if (entryName === name && entry?.version === version) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Fetch registry metadata and validate URL + integrity + publication age.
 * Uses the full packument to get time[version] and version-specific dist info.
 *
 * @param {string} name - package name
 * @param {string} version - package version
 * @param {string} lockfileResolved - resolved URL from lockfile (already extracted)
 * @param {string} lockfileIntegrity - integrity hash from lockfile (already extracted)
 */
async function fetchRegistryValidation(
  name,
  version,
  lockfileResolved = '',
  lockfileIntegrity = '',
) {
  const encodedName = name.startsWith('@')
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);

  const url = `https://registry.npmjs.org/${encodedName}`;

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return { valid: false, ageOk: false, urlMatch: false, integrityMatch: false };
    }
    const data = await res.json();
    const versionData = data.versions?.[version];
    if (!versionData) {
      return { valid: false, ageOk: false, urlMatch: false, integrityMatch: false };
    }

    const dist = versionData.dist ?? {};
    const registryUrl = dist.tarball ?? '';
    const registryIntegrity = dist.integrity ?? '';

    // URL must be from registry.npmjs.org and match exactly
    const urlMatch =
      lockfileResolved === registryUrl && registryUrl.startsWith('https://registry.npmjs.org/');
    // Integrity must match exactly
    const integrityMatch = lockfileIntegrity === registryIntegrity && lockfileIntegrity !== '';

    // Publication age check
    const timeStr = data.time?.[version];
    const publishedAt = timeStr ? new Date(timeStr) : null;
    const now = Date.now();
    const ageOk = publishedAt
      ? !isNaN(publishedAt.getTime()) &&
        (now - publishedAt.getTime()) / (1000 * 60 * 60 * 24) >= COOLDOWN_DAYS
      : false;

    return {
      valid: urlMatch && integrityMatch,
      ageOk,
      urlMatch,
      integrityMatch,
      publishedAt,
    };
  } catch {
    return { valid: false, ageOk: false, urlMatch: false, integrityMatch: false };
  }
}

async function mergePr(prNumber, headSha) {
  const result = await ghApi(`/repos/${REPO}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    body: {
      merge_method: 'squash',
      sha: headSha,
    },
  });

  // Verify merge succeeded
  const pr = await fetchPr(prNumber);
  if (!pr.merged) {
    throw new Error(`Merge verification failed: PR #${prNumber} not merged`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main live execution
// ---------------------------------------------------------------------------

async function processPr(prNumber) {
  console.log(`\n--- Evaluating PR #${prNumber} ---`);

  const pr = await fetchPr(prNumber);
  const changedFiles = await fetchPrFiles(prNumber);
  const reviews = await fetchReviews(prNumber);

  console.log(`Title: ${pr.title}`);
  console.log(`Author: ${pr.user?.login}`);
  console.log(`Head SHA: ${pr.head?.sha}`);
  console.log(`Changed files: ${changedFiles.join(', ')}`);

  // Fetch file contents at base and head
  const [pkgBefore, pkgAfter, lockBefore, lockAfter] = await Promise.all([
    fetchFileAtRef(pr.base?.sha, 'package.json'),
    fetchFileAtRef(pr.head?.sha, 'package.json'),
    fetchFileAtRef(pr.base?.sha, 'package-lock.json'),
    fetchFileAtRef(pr.head?.sha, 'package-lock.json'),
  ]);

  // Fetch CI status
  const ciStatus = await fetchCiStatus(pr.head?.sha);

  // Build registry validation map for all changed lockfile versions
  const lockfileChanges = extractLockfileChanges(lockBefore, lockAfter);
  const registryValidation = new Map();
  for (const change of lockfileChanges) {
    if (!change.to || change.changeType === 'removed') continue;
    const key = `${change.name}@${change.to}`;
    // Find the lockfile entry that matches BOTH name and version
    const lockfileEntry = findLockfileEntry(lockAfter, change.name, change.to);
    const validation = await fetchRegistryValidation(
      change.name,
      change.to,
      lockfileEntry?.resolved ?? '',
      lockfileEntry?.integrity ?? '',
    );
    registryValidation.set(key, validation);
    console.log(
      `  ${key}: valid=${validation.valid} ageOk=${validation.ageOk} urlMatch=${validation.urlMatch} integrityMatch=${validation.integrityMatch}`,
    );
  }

  const sameRepo = pr.base?.repo?.full_name === REPO;

  const result = evaluateEligibility({
    pr,
    changedFiles,
    packageJsonBefore: pkgBefore,
    packageJsonAfter: pkgAfter,
    lockfileBefore: lockBefore,
    lockfileAfter: lockAfter,
    ciStatus,
    registryValidation,
    reviews,
    sameRepo,
    cooldownDays: COOLDOWN_DAYS,
  });

  console.log(`Eligible: ${result.eligible}`);
  if (result.reasons.length) {
    console.log(`Reasons:\n${result.reasons.map((r) => '  - ' + r).join('\n')}`);
  }

  if (result.eligible && !DRY_RUN) {
    // Re-fetch PR to get latest head SHA (race safety)
    const latestPr = await fetchPr(prNumber);
    if (!latestPr.mergeable || latestPr.state !== 'open') {
      console.log(`PR #${prNumber} state changed, skipping merge`);
      return { eligible: false, reasons: ['PR state changed before merge'] };
    }
    console.log(`Merging PR #${prNumber}...`);
    await mergePr(prNumber, latestPr.head.sha);
    console.log(`✓ Merged PR #${prNumber}`);
  } else if (result.eligible && DRY_RUN) {
    console.log('[DRY RUN] Would merge PR #' + prNumber);
  }

  return result;
}

async function main() {
  if (!REPO) {
    console.error('GITHUB_REPOSITORY required');
    process.exit(2);
  }
  if (!DRY_RUN && !TOKEN) {
    console.error('GITHUB_TOKEN required for live merge');
    process.exit(2);
  }
  if (TARGET_PR) {
    await processPr(TARGET_PR);
    process.exit(0); // never fail CI, just report
  }

  // Find all open Dependabot PRs from this repo
  const prs = await ghApi(`/repos/${REPO}/pulls?state=open&per_page=100`);
  const candidates = prs.filter(
    (p) => p.user?.login === 'dependabot[bot]' && /bump/i.test(p.title ?? ''),
  );

  console.log(`Found ${candidates.length} open Dependabot npm PR(s)`);

  for (const pr of candidates) {
    await processPr(pr.number);
  }
}

// Only run main() when invoked directly as a CLI (not imported for tests).
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  !process.env.NODE_OPTIONS?.includes('--test') &&
  !process.argv[1]?.includes('/test/') &&
  !process.argv[1]?.includes('\\test\\');

if (isMain) {
  main().catch((e) => {
    console.error('Fatal error:', e.message);
    process.exit(1);
  });
}
