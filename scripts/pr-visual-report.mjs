#!/usr/bin/env node
/**
 * pr-visual-report.mjs
 *
 * Trusted reporter for PR visual capture. Runs in a workflow_run-triggered
 * workflow from main with pull-requests:write and actions:read.
 *
 * SAFETY MODEL:
 *   - Never checks out PR code (only sparse-checkouts its own script from main).
 *   - Validates the capture workflow run via API before trusting anything:
 *     - Correct repo (full_name exact match)
 *     - Correct workflow identity (path match)
 *     - Event is pull_request
 *     - Conclusion is success
 *   - Fetches the associated PR and validates:
 *     - PR is still open (not closed/merged)
 *     - PR head SHA matches the run head SHA (no stale report)
 *   - Validates artifact name via API (never downloads artifact contents).
 *   - Posts/updates a comment identified by a unique marker; only touches
 *     its own marker, never other bots' comments.
 *   - Fork support: falls back to searching open PRs by head_sha when the
 *     workflow_run payload's pull_requests array is empty (first-time forks).
 *
 * Usage:
 *   GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=*** CAPTURE_RUN_ID=123 \
 *     node scripts/pr-visual-report.mjs
 *
 * Environment:
 *   GITHUB_REPOSITORY (required) — owner/repo
 *   GITHUB_TOKEN (required) — repo-scoped token with pull-requests:write
 *   GITHUB_API_URL (optional) — defaults to https://api.github.com
 *   CAPTURE_RUN_ID (required) — workflow run ID that produced the artifact
 *   CAPTURE_WORKFLOW_PATH (optional) — defaults to .github/workflows/pr-visual-capture.yml
 *   EXPECTED_ARTIFACT_PREFIX (optional) — defaults to pr-visuals-
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(import.meta.url);
const GITHUB_API = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const CAPTURE_WORKFLOW_PATH =
  process.env.CAPTURE_WORKFLOW_PATH ?? '.github/workflows/pr-visual-capture.yml';
const EXPECTED_ARTIFACT_PREFIX = process.env.EXPECTED_ARTIFACT_PREFIX ?? 'pr-visuals-';

// Maximum pagination pages — fail closed after this bound to prevent infinite loops.
const MAX_PAGES = 10;

// Exported for unit testing and reuse.
export const COMMENT_MARKER = '<!-- pr-visual-report -->';
export const BOT_ID = 'pr-visual-bot';

// ---------------------------------------------------------------------------
// Pure validation functions (no I/O — exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Validate that a workflow run matches the expected trusted identity.
 *
 * @param {Object} run — workflow run object from GitHub API
 * @param {string} expectedRepo — expected "owner/repo"
 * @param {string} expectedWorkflowPath — expected workflow file path
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateRunIdentity(run, expectedRepo, expectedWorkflowPath) {
  if (!run || typeof run !== 'object') {
    return { valid: false, reason: 'run is null/undefined or not an object' };
  }
  if (run.repository?.full_name !== expectedRepo) {
    return {
      valid: false,
      reason: `repo mismatch: expected ${expectedRepo}, got ${run.repository?.full_name ?? 'null'}`,
    };
  }
  if (run.path !== expectedWorkflowPath) {
    return {
      valid: false,
      reason: `workflow path mismatch: expected ${expectedWorkflowPath}, got ${run.path ?? 'null'}`,
    };
  }
  if (run.event !== 'pull_request') {
    return {
      valid: false,
      reason: `event is ${run.event}, not pull_request`,
    };
  }
  if (run.conclusion !== 'success') {
    return {
      valid: false,
      reason: `conclusion is ${run.conclusion}, not success`,
    };
  }
  return { valid: true };
}

/**
 * Validate that a PR is in the expected state for reporting.
 *
 * @param {Object} pr — PR object from GitHub API
 * @param {string} expectedHeadSha — expected head SHA (must match exactly)
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validatePrState(pr, expectedHeadSha) {
  if (!pr || typeof pr !== 'object') {
    return { valid: false, reason: 'PR is null/undefined or not an object' };
  }
  if (pr.state !== 'open') {
    return { valid: false, reason: `PR state is ${pr.state}, not open` };
  }
  if (pr.merged === true) {
    return { valid: false, reason: 'PR is already merged' };
  }
  if (pr.head?.sha !== expectedHeadSha) {
    return {
      valid: false,
      reason: `head SHA mismatch: expected ${expectedHeadSha}, got ${pr.head?.sha ?? 'null'}`,
    };
  }
  return { valid: true };
}

/**
 * Validate that an artifact name matches the expected trusted prefix.
 * Never inspects artifact contents — name-only check.
 *
 * @param {string} artifactName
 * @param {string} expectedPrefix
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateArtifactName(artifactName, expectedPrefix) {
  if (!artifactName || typeof artifactName !== 'string') {
    return { valid: false, reason: 'artifact name is empty or not a string' };
  }
  if (!artifactName.startsWith(expectedPrefix)) {
    return {
      valid: false,
      reason: `artifact name "${artifactName}" does not start with "${expectedPrefix}"`,
    };
  }
  return { valid: true };
}

/**
 * Validate artifact name against exact expected name.
 *
 * The capture workflow names artifacts as `pr-visuals-<head_sha>` (no prefix
 * ambiguity). This rejects any artifact whose full name does not match,
 * preventing stale/duplicate artifact confusion.
 *
 * @param {string} artifactName
 * @param {string} expectedName — exact expected name (e.g. "pr-visuals-abc123...")
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateArtifactNameExact(artifactName, expectedName) {
  if (!artifactName || typeof artifactName !== 'string') {
    return { valid: false, reason: 'artifact name is empty or not a string' };
  }
  if (artifactName !== expectedName) {
    return {
      valid: false,
      reason: `artifact name \"${artifactName}\" does not match expected \"${expectedName}\"`,
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/**
 * Call the GitHub REST API. Uses global fetch (Node 18+).
 *
 * @param {string} path — API path or full URL
 * @param {Object} [options]
 * @param {string} [options.method]
 * @param {Object} [options.body]
 * @returns {Promise<any>}
 */
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

// ---------------------------------------------------------------------------
// PR finding (with fork support)
// ---------------------------------------------------------------------------

/**
 * Find the PR associated with a capture workflow run.
 *
 * Strategy:
 *   1. If workflow_run.pull_requests is populated (same-repo or approved fork),
 *      use the first entry.
 *   2. Otherwise, search open PRs by head_sha (covers same-repo PRs whose
 *      payload was truncated; fork PRs from unapproved first-time contributors
 *      won't appear here — that's a GitHub platform limitation).
 *
 * @param {Object} workflowRun — workflow run object from API
 * @param {Function} apiClient — async (path, options?) => data  (injectable for tests)
 * @returns {Promise<Object|null>} minimal PR object or null
 */
export async function findAssociatedPR(workflowRun, apiClient, repoFullName = REPO) {
  // Path 1: pull_requests array (same-repo or approved fork)
  if (Array.isArray(workflowRun.pull_requests) && workflowRun.pull_requests.length > 0) {
    const prInfo = workflowRun.pull_requests[0];
    return {
      number: prInfo.number,
      head: { sha: prInfo.head_sha, ref: prInfo.head_ref },
      base: { sha: prInfo.base_sha, ref: prInfo.base_ref },
      state: prInfo.state || 'open',
      merged: false,
    };
  }

  // Path 2: search open PRs by head_sha
  const headSha = workflowRun.head_sha;
  if (!headSha) return null;

  if (!repoFullName) return null;
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) return null;
  const prs = await apiClient(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`);
  if (!Array.isArray(prs)) return null;
  return prs.find((p) => p.head?.sha === headSha) || null;
}

// ---------------------------------------------------------------------------
// Comment finding (paginated, marker-based)
// ---------------------------------------------------------------------------

/**
 * Find an existing comment on the PR that contains our marker.
 * Paginates through all comments. Only matches our own marker — never
 * touches other bots' comments.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @param {string} marker — unique marker string to identify our comment
 * @param {Function} apiClient — injectable for tests
 * @returns {Promise<Object|null>} comment object or null
 */
export async function findExistingComment(owner, repo, prNumber, marker, apiClient) {
  let page = 1;
  while (page <= MAX_PAGES) {
    const comments = await apiClient(
      `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    );
    if (!Array.isArray(comments) || comments.length === 0) break;
    const found = comments.find(
      (c) =>
        c.user?.login === 'github-actions[bot]' &&
        c.user?.type === 'Bot' &&
        c.body &&
        c.body.includes(marker),
    );
    if (found) return found;
    if (comments.length < 100) break;
    page++;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Artifact listing (paginated, name-only — never downloads contents)
// ---------------------------------------------------------------------------

/**
 * List all artifacts for a workflow run. Paginates. Never downloads
 * artifact contents — only metadata (name, size, etc.).
 *
 * @param {string} owner
 * @param {string} repo
 * @param {number} runId
 * @param {Function} apiClient — injectable for tests
 * @returns {Promise<Array<{id, name, size_in_bytes, ...}>>}
 */
export async function listArtifacts(owner, repo, runId, apiClient) {
  const all = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const res = await apiClient(
      `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
    );
    const artifacts = res.artifacts ?? [];
    if (!Array.isArray(artifacts) || artifacts.length === 0) break;
    all.push(...artifacts);
    if (artifacts.length < 100) break;
    page++;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Comment body builder
// ---------------------------------------------------------------------------

/**
 * Build the PR comment body. Includes the marker as the first line so
 * future runs can find and update this comment.
 *
 * @param {Object} captureRun — workflow run object (needs .id, .head_sha)
 * @param {Object} pr — PR object (needs .number, .head.sha)
 * @param {string} artifactName — validated artifact name
 * @param {string} repo — "owner/repo" for links
 * @returns {string} markdown comment body
 */
export function buildCommentBody(captureRun, pr, artifactName, repo) {
  const captureRunId = captureRun.id;
  const prNumber = pr.number;
  const headSha = pr.head?.sha || captureRun.head_sha || 'unknown';

  return [
    COMMENT_MARKER,
    '',
    '## 🎨 Popup Visual Report',
    '',
    'Rendered production popup in real Firefox via Playwright.',
    '',
    '**States captured:** light/dark x collapsed/expanded (settings + Media Roller).',
    '',
    '> ⚠️ **Inline image limitation:** GitHub does not natively embed private-repo artifact PNGs inline without an authenticated external host. Screenshots are attached as downloadable artifacts on the capture workflow run.',
    '',
    `[Download artifacts](https://github.com/${repo}/actions/runs/${captureRunId}/artifacts)`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| PR | #${prNumber} |`,
    `| Head SHA | \`${headSha.slice(0, 7)}\` |`,
    `| Artifact | \`${artifactName}\` |`,
    `| Capture run | [${captureRunId}](https://github.com/${repo}/actions/runs/${captureRunId}) |`,
    '',
    `_Updated by ${BOT_ID} at ${new Date().toISOString().replace('T', ' ').slice(0, 19)}Z_`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main execution (live mode only — guarded so importing for tests skips this)
// ---------------------------------------------------------------------------

async function main() {
  if (!REPO) {
    console.error('GITHUB_REPOSITORY required');
    process.exit(2);
  }
  if (!TOKEN) {
    console.error('GITHUB_TOKEN required');
    process.exit(2);
  }
  const captureRunId = process.env.CAPTURE_RUN_ID;
  if (!captureRunId) {
    console.error('CAPTURE_RUN_ID required');
    process.exit(2);
  }

  const [owner, repo] = REPO.split('/');

  // 1. Fetch and validate the capture run via API (don't trust the payload).
  const captureRun = await ghApi(`/repos/${owner}/${repo}/actions/runs/${captureRunId}`);
  const runCheck = validateRunIdentity(captureRun, REPO, CAPTURE_WORKFLOW_PATH);
  if (!runCheck.valid) {
    console.error(`Run validation failed: ${runCheck.reason}`);
    process.exit(0); // Advisory — never fail CI
  }

  // 2. Find associated PR (fork-aware).
  const pr = await findAssociatedPR(captureRun, ghApi);
  if (!pr) {
    console.error('No associated PR found for this workflow run');
    process.exit(0);
  }

  // 3. Fetch full PR details for stale-guard validation.
  const fullPr = await ghApi(`/repos/${owner}/${repo}/pulls/${pr.number}`);
  const prCheck = validatePrState(fullPr, captureRun.head_sha);
  if (!prCheck.valid) {
    console.error(`PR validation failed: ${prCheck.reason}`);
    process.exit(0);
  }

  // 4. Validate artifact name via API (never download contents).
  //    Expect exact name `pr-visuals-<head_sha>` from the capture workflow.
  const expectedArtifactName = `${EXPECTED_ARTIFACT_PREFIX}${captureRun.head_sha}`;
  const artifacts = await listArtifacts(owner, repo, captureRunId, ghApi);
  const matchedArtifact = artifacts.find((a) => {
    const check = validateArtifactNameExact(a.name, expectedArtifactName);
    return check.valid;
  });
  if (!matchedArtifact) {
    console.error(`Expected artifact \"${expectedArtifactName}\" not found in run's artifacts`);
    process.exit(0);
  }
  const artifactName = matchedArtifact.name;

  // 5. Find existing comment by marker (paginated).
  const existing = await findExistingComment(owner, repo, pr.number, COMMENT_MARKER, ghApi);

  // 6. RE-FETCH: Just before mutation, re-validate the PR is still open with the
  //    same head SHA. This guards against a force-push or merge happening between
  //    step 3 and the comment write — the most critical stale window.
  const freshPr = await ghApi(`/repos/${owner}/${repo}/pulls/${pr.number}`);
  const freshPrCheck = validatePrState(freshPr, captureRun.head_sha);
  if (!freshPrCheck.valid) {
    console.error(`Pre-mutation PR re-validation failed: ${freshPrCheck.reason}`);
    process.exit(0);
  }

  // 7. Build and post/update comment.
  const body = buildCommentBody(captureRun, freshPr, artifactName, REPO);

  if (existing) {
    await ghApi(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: { body },
    });
    console.log(`Updated comment #${existing.id} on PR #${pr.number}`);
  } else {
    const result = await ghApi(`/repos/${owner}/${repo}/issues/${pr.number}/comments`, {
      method: 'POST',
      body: { body },
    });
    console.log(`Created comment #${result.id} on PR #${pr.number}`);
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
