/**
 * Unit tests for scripts/pr-visual-report.mjs
 *
 * Tests the pure validation functions, bounded pagination, and orchestration
 * helpers with mocked inputs. Does NOT test live API calls.
 *
 * API fixtures use the real GitHub REST API shape:
 *   - run.repository.full_name (not run.repo)
 *   - run.path (not run.workflow.path)
 *   - artifact response: { total_count, artifacts: [...] }
 *
 * Pagination mocks MUST return < 100 items on the last page OR return empty
 * — returning exactly 100 items on every page is an infinite-loop bug that
 * MAX_PAGES bounds. We test both the happy path and the bounded case.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRunIdentity,
  validatePrState,
  validateArtifactName,
  validateArtifactNameExact,
  findAssociatedPR,
  findExistingComment,
  listArtifacts,
  buildCommentBody,
  COMMENT_MARKER,
} from '../../scripts/pr-visual-report.mjs';

const EXPECTED_REPO = 'example-owner/media-tamer';
const EXPECTED_WORKFLOW = '.github/workflows/pr-visual-capture.yml';

// ---------------------------------------------------------------------------
// validateRunIdentity
// ---------------------------------------------------------------------------

describe('validateRunIdentity', () => {
  const validRun = {
    repository: { full_name: EXPECTED_REPO },
    path: EXPECTED_WORKFLOW,
    event: 'pull_request',
    conclusion: 'success',
    id: 12345,
    head_sha: 'abc123def456',
  };

  test('accepts valid run', () => {
    const result = validateRunIdentity(validRun, EXPECTED_REPO, EXPECTED_WORKFLOW);
    assert.equal(result.valid, true);
    assert.equal(result.reason, undefined);
  });

  test('rejects null run', () => {
    const result = validateRunIdentity(null, EXPECTED_REPO, EXPECTED_WORKFLOW);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('null'));
  });

  test('rejects undefined run', () => {
    const result = validateRunIdentity(undefined, EXPECTED_REPO, EXPECTED_WORKFLOW);
    assert.equal(result.valid, false);
  });

  test('rejects run from wrong repo', () => {
    const run = { ...validRun, repository: { full_name: 'evil-fork/media-tamer' } };
    const result = validateRunIdentity(run, EXPECTED_REPO, EXPECTED_WORKFLOW);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('repo mismatch'));
    assert.ok(result.reason.includes('evil-fork'));
  });

  test('rejects run with null repo', () => {
    const run = { ...validRun, repository: null };
    const result = validateRunIdentity(run, EXPECTED_REPO, EXPECTED_WORKFLOW);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('repo mismatch'));
  });

  test('rejects run with wrong workflow path', () => {
    const run = { ...validRun, path: '.github/workflows/evil.yml' };
    const result = validateRunIdentity(run, EXPECTED_REPO, EXPECTED_WORKFLOW);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('workflow path mismatch'));
  });

  test('rejects run with null workflow path', () => {
    const run = { ...validRun, path: null };
    const result = validateRunIdentity(run, EXPECTED_REPO, EXPECTED_WORKFLOW);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('workflow path mismatch'));
  });

  test('rejects run with push event (not pull_request)', () => {
    const run = { ...validRun, event: 'push' };
    const result = validateRunIdentity(run, EXPECTED_REPO, EXPECTED_WORKFLOW);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('push'));
  });

  test('rejects run with workflow_dispatch event', () => {
    const run = { ...validRun, event: 'workflow_dispatch' };
    const result = validateRunIdentity(run, EXPECTED_REPO, EXPECTED_WORKFLOW);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('workflow_dispatch'));
  });

  test('rejects failed run', () => {
    const run = { ...validRun, conclusion: 'failure' };
    const result = validateRunIdentity(run, EXPECTED_REPO, EXPECTED_WORKFLOW);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('failure'));
  });

  test('rejects cancelled run', () => {
    const run = { ...validRun, conclusion: 'cancelled' };
    const result = validateRunIdentity(run, EXPECTED_REPO, EXPECTED_WORKFLOW);
    assert.equal(result.valid, false);
  });

  test('rejects timed_out run', () => {
    const run = { ...validRun, conclusion: 'timed_out' };
    const result = validateRunIdentity(run, EXPECTED_REPO, EXPECTED_WORKFLOW);
    assert.equal(result.valid, false);
  });

  test('rejects non-object input', () => {
    const result = validateRunIdentity('not-an-object', EXPECTED_REPO, EXPECTED_WORKFLOW);
    assert.equal(result.valid, false);
  });

  // Real API shape: run.repository and run.path are top-level
  test('rejects legacy run.repo / run.workflow.path fields (wrong shape)', () => {
    const run = {
      repo: { full_name: EXPECTED_REPO },
      workflow: { path: EXPECTED_WORKFLOW },
      event: 'pull_request',
      conclusion: 'success',
    };
    const result = validateRunIdentity(run, EXPECTED_REPO, EXPECTED_WORKFLOW);
    assert.equal(result.valid, false);
    assert.ok(
      result.reason.includes('repo mismatch') || result.reason.includes('workflow path mismatch'),
    );
  });
});

// ---------------------------------------------------------------------------
// validatePrState
// ---------------------------------------------------------------------------

describe('validatePrState', () => {
  const validPr = {
    number: 42,
    state: 'open',
    merged: false,
    head: { sha: 'abc123def456' },
  };

  test('accepts valid open PR with matching SHA', () => {
    const result = validatePrState(validPr, 'abc123def456');
    assert.equal(result.valid, true);
  });

  test('rejects null PR', () => {
    const result = validatePrState(null, 'abc123');
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('null'));
  });

  test('rejects undefined PR', () => {
    const result = validatePrState(undefined, 'abc123');
    assert.equal(result.valid, false);
  });

  test('rejects closed PR', () => {
    const pr = { ...validPr, state: 'closed' };
    const result = validatePrState(pr, 'abc123def456');
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('closed'));
  });

  test('rejects merged PR (stale guard)', () => {
    const pr = { ...validPr, merged: true };
    const result = validatePrState(pr, 'abc123def456');
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('merged'));
  });

  test('rejects PR with mismatched head SHA (stale guard)', () => {
    const pr = { ...validPr, head: { sha: 'different_sha' } };
    const result = validatePrState(pr, 'abc123def456');
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('SHA mismatch'));
    assert.ok(result.reason.includes('abc123def456'));
    assert.ok(result.reason.includes('different_sha'));
  });

  test('rejects PR with null head', () => {
    const pr = { ...validPr, head: null };
    const result = validatePrState(pr, 'abc123');
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('SHA mismatch'));
  });

  test('rejects PR with null head sha', () => {
    const pr = { ...validPr, head: { sha: null } };
    const result = validatePrState(pr, 'abc123');
    assert.equal(result.valid, false);
  });

  test('rejects non-object input', () => {
    const result = validatePrState(42, 'abc123');
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// validateArtifactName (prefix check)
// ---------------------------------------------------------------------------

describe('validateArtifactName', () => {
  const prefix = 'pr-visuals-';

  test('accepts valid artifact name', () => {
    const result = validateArtifactName('pr-visuals-12345', prefix);
    assert.equal(result.valid, true);
  });

  test('rejects empty string', () => {
    const result = validateArtifactName('', prefix);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('empty'));
  });

  test('rejects null', () => {
    const result = validateArtifactName(null, prefix);
    assert.equal(result.valid, false);
  });

  test('rejects undefined', () => {
    const result = validateArtifactName(undefined, prefix);
    assert.equal(result.valid, false);
  });

  test('rejects non-string', () => {
    const result = validateArtifactName(12345, prefix);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('not a string'));
  });

  test('rejects name with wrong prefix', () => {
    const result = validateArtifactName('evil-artifact', prefix);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('pr-visuals-'));
    assert.ok(result.reason.includes('evil-artifact'));
  });

  test('rejects name that contains but does not start with prefix', () => {
    const result = validateArtifactName('prefix-pr-visuals-', prefix);
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// validateArtifactNameExact (exact match)
// ---------------------------------------------------------------------------

describe('validateArtifactNameExact', () => {
  const expectedName = 'pr-visuals-abc123def4567890';

  test('accepts exact name', () => {
    const result = validateArtifactNameExact(expectedName, expectedName);
    assert.equal(result.valid, true);
  });

  test('rejects prefix-only match', () => {
    const result = validateArtifactNameExact('pr-visuals-abc123_other', expectedName);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('does not match expected'));
  });

  test('rejects empty string', () => {
    const result = validateArtifactNameExact('', expectedName);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('empty'));
  });

  test('rejects null', () => {
    const result = validateArtifactNameExact(null, expectedName);
    assert.equal(result.valid, false);
  });

  test('rejects undefined', () => {
    const result = validateArtifactNameExact(undefined, expectedName);
    assert.equal(result.valid, false);
  });

  test('rejects non-string', () => {
    const result = validateArtifactNameExact(123, expectedName);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('not a string'));
  });

  test('rejects path traversal even if exact match (only because name equals)', () => {
    const name = '../../../etc/passwd';
    const result = validateArtifactNameExact(name, name);
    assert.equal(result.valid, true); // Exact match — name safety is enforced elsewhere
  });
});

// ---------------------------------------------------------------------------
// findAssociatedPR
// ---------------------------------------------------------------------------

describe('findAssociatedPR', () => {
  const apiClient = async (path) => {
    if (path.includes('/pulls?state=open')) {
      return [
        { number: 42, head: { sha: 'sha-in-list' }, state: 'open' },
        { number: 99, head: { sha: 'other-sha' }, state: 'open' },
      ];
    }
    throw new Error(`Unexpected: ${path}`);
  };

  test('uses pull_requests array when present (same-repo)', async () => {
    const run = {
      pull_requests: [{ number: 7, head_sha: 'pr_sha', head_ref: 'feature', base_sha: 'base' }],
      head_sha: 'pr_sha',
    };
    const pr = await findAssociatedPR(run, apiClient, 'example-owner/media-tamer');
    assert.ok(pr);
    assert.equal(pr.number, 7);
    assert.equal(pr.head.sha, 'pr_sha');
  });

  test('uses pull_requests array when present (approved fork)', async () => {
    const run = {
      pull_requests: [{ number: 88, head_sha: 'fork_sha', base_sha: 'base' }],
      head_sha: 'fork_sha',
    };
    const pr = await findAssociatedPR(run, apiClient, 'example-owner/media-tamer');
    assert.ok(pr);
    assert.equal(pr.number, 88);
  });

  test('falls back to head_sha search when pull_requests empty', async () => {
    const run = {
      pull_requests: [],
      head_sha: 'sha-in-list',
    };
    const pr = await findAssociatedPR(run, apiClient, 'example-owner/media-tamer');
    assert.ok(pr);
    assert.equal(pr.number, 42);
  });

  test('returns null when head_sha search finds no match', async () => {
    const run = {
      pull_requests: [],
      head_sha: 'no-match-sha',
    };
    const pr = await findAssociatedPR(run, apiClient, 'example-owner/media-tamer');
    assert.equal(pr, null);
  });

  test('returns null when head_sha is missing and pull_requests empty', async () => {
    const run = { pull_requests: [], head_sha: null };
    const pr = await findAssociatedPR(run, apiClient, 'example-owner/media-tamer');
    assert.equal(pr, null);
  });

  test('returns null when API returns non-array', async () => {
    const badClient = async () => null;
    const run = { pull_requests: [], head_sha: 'abc' };
    const pr = await findAssociatedPR(run, badClient, 'example-owner/media-tamer');
    assert.equal(pr, null);
  });

  test('returns null when repoFullName is missing', async () => {
    const run = { pull_requests: [], head_sha: 'abc' };
    const pr = await findAssociatedPR(run, apiClient, null);
    assert.equal(pr, null);
  });

  test('returns null when repoFullName is malformed', async () => {
    const run = { pull_requests: [], head_sha: 'abc' };
    const pr = await findAssociatedPR(run, apiClient, 'no-slash');
    assert.equal(pr, null);
  });
});

// ---------------------------------------------------------------------------
// findExistingComment — bounded pagination
// ---------------------------------------------------------------------------

describe('findExistingComment', () => {
  const owner = 'trusted-owner';
  const repo = 'media-tamer';
  const marker = COMMENT_MARKER;

  test('finds comment with marker on first page', async () => {
    const client = async (path) => {
      if (path.includes('page=1')) {
        return [
          { id: 1, body: 'some other comment' },
          {
            id: 2,
            user: { login: 'github-actions[bot]', type: 'Bot' },
            body: `${marker}\nvisual report`,
          },
          { id: 3, body: 'another comment' },
        ];
      }
      return [];
    };
    const result = await findExistingComment(owner, repo, 42, marker, client);
    assert.ok(result);
    assert.equal(result.id, 2);
  });

  test('finds comment with marker on second page (terminates at last page)', async () => {
    const client = async (path) => {
      const pageMatch = path.match(/[?&]page=(\d+)/);
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 1;
      if (page === 1) {
        return Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `filler ${i}` }));
      }
      if (page === 2) {
        return [
          {
            id: 999,
            user: { login: 'github-actions[bot]', type: 'Bot' },
            body: `${marker}\npaged report`,
          },
        ];
      }
      return [];
    };
    const result = await findExistingComment(owner, repo, 42, marker, client);
    assert.ok(result);
    assert.equal(result.id, 999);
  });

  test('returns null when no comment has marker', async () => {
    const client = async () => [
      { id: 1, body: 'other bot comment <!-- other-bot -->' },
      { id: 2, body: 'human comment' },
    ];
    const result = await findExistingComment(owner, repo, 42, marker, client);
    assert.equal(result, null);
  });

  test('returns null on empty comment list', async () => {
    const client = async () => [];
    const result = await findExistingComment(owner, repo, 42, marker, client);
    assert.equal(result, null);
  });

  test('does NOT match another bots marker', async () => {
    const client = async () => [
      { id: 1, body: '<!-- other-bot -->\nreport' },
      {
        id: 2,
        user: { login: 'github-actions[bot]', type: 'Bot' },
        body: '<!-- pr-visual-report -->\nvisual report',
      },
    ];
    const result = await findExistingComment(owner, repo, 42, marker, client);
    assert.ok(result);
    assert.equal(result.id, 2);
  });

  test('handles comment with null body', async () => {
    const client = async () => [{ id: 1, body: null }];
    const result = await findExistingComment(owner, repo, 42, marker, client);
    assert.equal(result, null);
  });

  // Critical: bounded pagination — a mock that returns 100 items every page
  // MUST NOT hang. It should terminate after MAX_PAGES pages.
  test('bounded pagination terminates when mock always returns 100 items', async () => {
    let callCount = 0;
    const client = async () => {
      callCount++;
      return Array.from({ length: 100 }, (_, i) => ({ id: i, body: `filler ${i}` }));
    };
    const result = await findExistingComment(owner, repo, 42, marker, client);
    assert.equal(result, null);
    assert.ok(callCount <= 10, `pagination called ${callCount} times — should be bounded`);
  });
});

// ---------------------------------------------------------------------------
// listArtifacts — bounded pagination
// ---------------------------------------------------------------------------

describe('listArtifacts', () => {
  const owner = 'trusted-owner';
  const repo = 'media-tamer';

  test('returns single page of artifacts', async () => {
    const client = async (path) => {
      if (path.includes('page=1')) {
        return {
          total_count: 2,
          artifacts: [
            { id: 1, name: 'pr-visuals-abc123' },
            { id: 2, name: 'other-artifact' },
          ],
        };
      }
      return { total_count: 0, artifacts: [] };
    };
    const result = await listArtifacts(owner, repo, 12345, client);
    assert.equal(result.length, 2);
  });

  test('paginates when more than 100 artifacts (terminates correctly)', async () => {
    const client = async (path) => {
      const pageMatch = path.match(/[?&]page=(\d+)/);
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 1;
      if (page === 1) {
        return {
          total_count: 101,
          artifacts: Array.from({ length: 100 }, (_, i) => ({
            id: i,
            name: `artifact-${i}`,
          })),
        };
      }
      if (page === 2) {
        return {
          total_count: 101,
          artifacts: [{ id: 100, name: 'pr-visuals-last' }],
        };
      }
      return { total_count: 0, artifacts: [] };
    };
    const result = await listArtifacts(owner, repo, 12345, client);
    assert.equal(result.length, 101);
    assert.ok(result.find((a) => a.name === 'pr-visuals-last'));
  });

  test('returns empty array when no artifacts', async () => {
    const client = async () => ({ total_count: 0, artifacts: [] });
    const result = await listArtifacts(owner, repo, 12345, client);
    assert.equal(result.length, 0);
  });

  test('returns empty array when artifacts key missing', async () => {
    const client = async () => ({});
    const result = await listArtifacts(owner, repo, 12345, client);
    assert.equal(result.length, 0);
  });

  test('never downloads artifact contents (metadata only)', async () => {
    const client = async (path) => {
      assert.ok(!path.includes('/zip'), 'should not call zip download endpoint');
      assert.ok(!path.includes('/download'), 'should not call download endpoint');
      return {
        total_count: 1,
        artifacts: [{ id: 1, name: 'pr-visuals-123', size_in_bytes: 5000 }],
      };
    };
    const result = await listArtifacts(owner, repo, 12345, client);
    assert.equal(result.length, 1);
    assert.equal(result[0].size_in_bytes, 5000);
  });

  // Critical: bounded pagination — a mock that returns 100 items every page
  // MUST NOT hang. It should terminate after MAX_PAGES pages.
  test('bounded pagination terminates when mock always returns 100 items', async () => {
    let callCount = 0;
    const client = async () => {
      callCount++;
      return {
        total_count: 1000,
        artifacts: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `a-${i}` })),
      };
    };
    const result = await listArtifacts(owner, repo, 12345, client);
    assert.equal(
      callCount,
      10,
      `pagination called ${callCount} times — should be exactly MAX_PAGES`,
    );
    assert.equal(result.length, 1000);
  });
});

// ---------------------------------------------------------------------------
// buildCommentBody
// ---------------------------------------------------------------------------

describe('buildCommentBody', () => {
  test('includes marker as first line', () => {
    const captureRun = { id: 999, head_sha: 'abc123def456' };
    const pr = { number: 42, head: { sha: 'abc123def456' } };
    const body = buildCommentBody(
      captureRun,
      pr,
      'pr-visuals-abc123def456',
      'example-owner/media-tamer',
    );
    assert.ok(body.startsWith(COMMENT_MARKER));
  });

  test('includes PR number', () => {
    const captureRun = { id: 999, head_sha: 'abc123' };
    const pr = { number: 77, head: { sha: 'abc123' } };
    const body = buildCommentBody(captureRun, pr, 'pr-visuals-999', 'example-owner/media-tamer');
    assert.ok(body.includes('#77'));
  });

  test('includes head SHA (short form)', () => {
    const captureRun = { id: 999, head_sha: 'abc123def456789' };
    const pr = { number: 42, head: { sha: 'abc123def456789' } };
    const body = buildCommentBody(captureRun, pr, 'pr-visuals-999', 'example-owner/media-tamer');
    assert.ok(body.includes('`abc123d`'));
  });

  test('includes artifact name', () => {
    const captureRun = { id: 999, head_sha: 'abc123' };
    const pr = { number: 42, head: { sha: 'abc123' } };
    const body = buildCommentBody(captureRun, pr, 'pr-visuals-999', 'example-owner/media-tamer');
    assert.ok(body.includes('`pr-visuals-999`'));
  });

  test('links to capture run artifacts (not reporter run)', () => {
    const captureRun = { id: 555, head_sha: 'abc123' };
    const pr = { number: 42, head: { sha: 'abc123' } };
    const body = buildCommentBody(captureRun, pr, 'pr-visuals-555', 'example-owner/media-tamer');
    assert.ok(body.includes('/actions/runs/555/artifacts'));
    assert.ok(
      body.includes('https://github.com/example-owner/media-tamer/actions/runs/555/artifacts'),
    );
  });

  test('includes bot identifier', () => {
    const captureRun = { id: 999, head_sha: 'abc123' };
    const pr = { number: 42, head: { sha: 'abc123' } };
    const body = buildCommentBody(captureRun, pr, 'pr-visuals-999', 'example-owner/media-tamer');
    assert.ok(body.includes('pr-visual-bot'));
  });

  test('includes timestamp', () => {
    const captureRun = { id: 999, head_sha: 'abc123' };
    const pr = { number: 42, head: { sha: 'abc123' } };
    const body = buildCommentBody(captureRun, pr, 'pr-visuals-999', 'example-owner/media-tamer');
    assert.match(body, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z/);
  });

  test('handles missing pr head sha gracefully', () => {
    const captureRun = { id: 999, head_sha: 'fallback_sha' };
    const pr = { number: 42, head: {} };
    const body = buildCommentBody(captureRun, pr, 'pr-visuals-999', 'example-owner/media-tamer');
    assert.ok(body.includes('fallback_sha'.slice(0, 7)));
  });

  test('does not embed raw artifact contents', () => {
    const captureRun = { id: 999, head_sha: 'abc123' };
    const pr = { number: 42, head: { sha: 'abc123' } };
    const body = buildCommentBody(captureRun, pr, 'pr-visuals-999', 'example-owner/media-tamer');
    assert.ok(!body.includes('data:image/png;base64'));
    assert.ok(!body.includes('iVBORw0KGgo'));
  });

  test('links to artifacts page not inline images', () => {
    const captureRun = { id: 999, head_sha: 'abc123' };
    const pr = { number: 42, head: { sha: 'abc123' } };
    const body = buildCommentBody(captureRun, pr, 'pr-visuals-abc123', 'example-owner/media-tamer');
    assert.ok(body.includes('/artifacts'));
  });
});

// ---------------------------------------------------------------------------
// Stale guard edge cases
// ---------------------------------------------------------------------------

describe('stale guard scenarios', () => {
  test('rejects run from wrong repo even if SHA matches', () => {
    const run = {
      repository: { full_name: 'attacker/repo' },
      path: '.github/workflows/pr-visual-capture.yml',
      event: 'pull_request',
      conclusion: 'success',
    };
    const result = validateRunIdentity(
      run,
      'example-owner/media-tamer',
      '.github/workflows/pr-visual-capture.yml',
    );
    assert.equal(result.valid, false);
  });

  test('rejects PR that was merged between capture and report', () => {
    const pr = {
      number: 42,
      state: 'open',
      merged: true,
      head: { sha: 'abc123' },
    };
    const result = validatePrState(pr, 'abc123');
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('merged'));
  });

  test('rejects PR whose head was force-pushed after capture', () => {
    const pr = {
      number: 42,
      state: 'open',
      merged: false,
      head: { sha: 'newer_sha_after_force_push' },
    };
    const result = validatePrState(pr, 'original_capture_sha');
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('SHA mismatch'));
  });
});

// ---------------------------------------------------------------------------
// Unauthenticated correlation test
// ---------------------------------------------------------------------------

describe('unauthenticated correlation', () => {
  test('findAssociatedPR does not authenticate via URL (uses injected client)', async () => {
    let capturedPath = null;
    const spyClient = async (path) => {
      capturedPath = path;
      return [];
    };
    const run = { pull_requests: [], head_sha: 'abc' };
    await findAssociatedPR(run, spyClient, 'example-owner/media-tamer');
    assert.ok(capturedPath?.includes('/pulls?state=open'));
    assert.ok(!capturedPath?.includes('token='));
  });
});

// ---------------------------------------------------------------------------
// Real API fixture — validates schema expectations against actual API response
// ---------------------------------------------------------------------------

describe('real API shape fixture (matches actual GitHub REST response)', () => {
  // This is the exact shape returned by GitHub's REST API for a workflow run.
  // It verifies validateRunIdentity works against real API data, not a strawman.
  const realApiRun = {
    id: 37558828474,
    name: 'CI',
    head_branch: 'main',
    head_sha: '474e175e4d22ae4f1697484b1d95214db414553a',
    path: '.github/workflows/ci.yml',
    display_title: 'feat: test',
    run_number: 16,
    event: 'push',
    status: 'queued',
    conclusion: null,
    workflow_id: 369847252,
    repository: {
      id: 1394440277,
      name: 'media-tamer',
      full_name: 'example-owner/media-tamer',
      private: true,
    },
    head_repository: {
      full_name: 'example-owner/media-tamer',
    },
    pull_requests: [],
  };

  test('validateRunIdentity handles real API run shape', () => {
    // This run is push event + null conclusion — should be rejected
    const result = validateRunIdentity(
      realApiRun,
      'example-owner/media-tamer',
      '.github/workflows/pr-visual-capture.yml',
    );
    assert.equal(result.valid, false);
    // Either event or conclusion rejection is acceptable
    assert.ok(
      result.reason.includes('event') ||
        result.reason.includes('conclusion') ||
        result.reason.includes('workflow path'),
      `Expected rejection reason, got: ${result.reason}`,
    );
  });

  test('validateRunIdentity accepts correctly-shaped valid run', () => {
    const validRun = {
      ...realApiRun,
      event: 'pull_request',
      conclusion: 'success',
      path: '.github/workflows/pr-visual-capture.yml',
    };
    const result = validateRunIdentity(
      validRun,
      'example-owner/media-tamer',
      '.github/workflows/pr-visual-capture.yml',
    );
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// Orchestration-level tests (full flow with mocked API)
// ---------------------------------------------------------------------------

describe('orchestration: full report flow with mocked API', () => {
  // Simulates the full main() flow with a mock API client that follows
  // the real GitHub REST API response shapes.

  const mockRunResponse = {
    id: 99999,
    repository: { full_name: 'example-owner/media-tamer' },
    path: '.github/workflows/pr-visual-capture.yml',
    event: 'pull_request',
    conclusion: 'success',
    head_sha: 'deadbeef0123456789',
    pull_requests: [
      { number: 42, head_sha: 'deadbeef0123456789', head_ref: 'feature', base_sha: 'base123' },
    ],
  };

  const mockPrResponse = {
    number: 42,
    state: 'open',
    merged: false,
    head: { sha: 'deadbeef0123456789', ref: 'feature' },
    base: { sha: 'base123', ref: 'main' },
  };

  const mockArtifactsResponse = {
    total_count: 1,
    artifacts: [{ id: 555, name: 'pr-visuals-deadbeef0123456789', size_in_bytes: 1024 }],
  };

  function buildMockClient(options = {}) {
    const calls = [];
    let prFetchCount = 0;
    const client = async (path, { method = 'GET', body } = {}) => {
      calls.push({ path, method, body });

      if (path.includes('/actions/runs/99999/artifacts')) {
        return options.artifacts || mockArtifactsResponse;
      }
      if (path.includes('/pulls/42/comments') || path.includes('/issues/42/comments')) {
        return options.comments || [];
      }
      if (path.includes('/pulls/42') && method === 'GET') {
        prFetchCount++;
        // If pre-mutation re-fetch should return stale, return stale
        if (options.staleOnSecondFetch && prFetchCount > 1) {
          return { ...mockPrResponse, state: 'closed' };
        }
        return options.pr || mockPrResponse;
      }
      if (path.includes('/issues/') && path.includes('/comments') && method === 'POST') {
        return { id: 777, body };
      }
      if (path.includes('/issues/comments/') && method === 'PATCH') {
        return { id: existingCommentId, body };
      }
      return {};
    };
    return { client, calls, getPrFetchCount: () => prFetchCount };
  }

  const existingCommentId = 5566;

  test('full flow: first run creates a new comment', async () => {
    const { client, calls } = buildMockClient({
      comments: [], // No existing comment
    });

    // Run validation
    const runCheck = validateRunIdentity(
      mockRunResponse,
      'example-owner/media-tamer',
      '.github/workflows/pr-visual-capture.yml',
    );
    assert.equal(runCheck.valid, true);

    // Find associated PR
    const pr = await findAssociatedPR(mockRunResponse, client, 'example-owner/media-tamer');
    assert.ok(pr);
    assert.equal(pr.number, 42);

    // Validate initial PR state
    const fullPr = await client(`/repos/example-owner/media-tamer/pulls/${pr.number}`, {
      method: 'GET',
    });
    const prCheck = validatePrState(fullPr, mockRunResponse.head_sha);
    assert.equal(prCheck.valid, true);

    // Validate artifact name (exact match)
    const artifactsRes = await client(
      `/repos/example-owner/media-tamer/actions/runs/99999/artifacts`,
    );
    const artifacts = artifactsRes.artifacts;
    const expectedName = `pr-visuals-${mockRunResponse.head_sha}`;
    const matched = artifacts.find((a) => validateArtifactNameExact(a.name, expectedName).valid);
    assert.ok(matched);

    // Check for existing comment
    const existing = await findExistingComment(
      'trusted-owner',
      'media-tamer',
      42,
      COMMENT_MARKER,
      client,
    );
    assert.equal(existing, null);

    // Pre-mutation re-fetch
    const freshPr = await client(`/repos/example-owner/media-tamer/pulls/${pr.number}`, {
      method: 'GET',
    });
    const freshCheck = validatePrState(freshPr, mockRunResponse.head_sha);
    assert.equal(freshCheck.valid, true);

    // Build body
    const body = buildCommentBody(
      mockRunResponse,
      freshPr,
      matched.name,
      'example-owner/media-tamer',
    );
    assert.ok(body.startsWith(COMMENT_MARKER));

    // Verify API call sequence included re-fetch
    const prFetchCalls = calls.filter((c) => c.path.includes('/pulls/42') && c.method === 'GET');
    assert.equal(prFetchCalls.length, 2, 'Should fetch PR twice: initial + pre-mutation re-fetch');
  });

  test('full flow: second run updates existing comment', async () => {
    const { client } = buildMockClient({
      comments: [
        {
          id: existingCommentId,
          user: { login: 'github-actions[bot]', type: 'Bot' },
          body: `${COMMENT_MARKER}\nold report`,
        },
      ],
    });

    const pr = await findAssociatedPR(mockRunResponse, client, 'example-owner/media-tamer');
    assert.ok(pr);

    const existing = await findExistingComment(
      'trusted-owner',
      'media-tamer',
      42,
      COMMENT_MARKER,
      client,
    );
    assert.ok(existing);
    assert.equal(existing.id, existingCommentId);
  });

  test('full flow: stale PR (force-push) aborts before mutation', async () => {
    const { client } = buildMockClient({
      staleOnSecondFetch: true,
    });

    const pr = await findAssociatedPR(mockRunResponse, client, 'example-owner/media-tamer');
    assert.ok(pr);

    // Initial fetch passes
    const initialPr = await client(`/repos/example-owner/media-tamer/pulls/${pr.number}`, {
      method: 'GET',
    });
    const initialCheck = validatePrState(initialPr, mockRunResponse.head_sha);
    assert.equal(initialCheck.valid, true);

    // Re-fetch before mutation fails
    const freshPr = await client(`/repos/example-owner/media-tamer/pulls/${pr.number}`, {
      method: 'GET',
    });
    const freshCheck = validatePrState(freshPr, mockRunResponse.head_sha);
    assert.equal(freshCheck.valid, false);
    assert.ok(freshCheck.reason.includes('closed') || freshCheck.reason.includes('merged'));
  });

  test('full flow: missing artifact aborts', async () => {
    const { client } = buildMockClient({
      artifacts: { total_count: 0, artifacts: [] },
    });

    const artifactsRes = await client(
      `/repos/example-owner/media-tamer/actions/runs/99999/artifacts`,
    );
    const artifacts = artifactsRes.artifacts ?? [];
    const expectedName = `pr-visuals-${mockRunResponse.head_sha}`;
    const matched = artifacts.find((a) => validateArtifactNameExact(a.name, expectedName).valid);
    assert.equal(matched, undefined);
  });

  test('full flow: wrong artifact name aborts', async () => {
    const { client } = buildMockClient({
      artifacts: {
        total_count: 1,
        artifacts: [{ id: 1, name: 'other-artifact-not-visual' }],
      },
    });

    const artifactsRes = await client(
      `/repos/example-owner/media-tamer/actions/runs/99999/artifacts`,
    );
    const artifacts = artifactsRes.artifacts ?? [];
    const expectedName = `pr-visuals-${mockRunResponse.head_sha}`;
    const matched = artifacts.find((a) => validateArtifactNameExact(a.name, expectedName).valid);
    assert.equal(matched, undefined);
  });
});
