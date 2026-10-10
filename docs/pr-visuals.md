# PR Visual Reporting

Automated visual capture and reporting of the popup UI for every PR to `main`.

## Overview

Two-workflow design that separates the **unprivileged capture** (runs PR code,
read-only) from the **trusted reporter** (writes PR comments, never touches PR
code). This avoids the security pitfalls of `pull_request_target` and phantom
bot tokens.

## Architecture

```
PR push/pull_request
       │
       ▼
┌─────────────────────────┐
│ PR Visual Capture       │  pull_request event (read-only, no secrets)
│ (unprivileged)          │  Checks out PR head SHA, runs Playwright,
│                         │  uploads artifact named pr-visuals-<head_sha>
└───────────┬─────────────┘
            │ workflow_run completed (success)
            ▼
┌─────────────────────────┐
│ PR Visual Report        │  workflow_run event (trusted, pull-requests:write)
│ (trusted reporter)      │  Validates run via API, validates artifact name,
│                         │  finds PR (fork-aware), stale-guards, posts comment
└─────────────────────────┘
```

## Workflow 1: `pr-visual-capture.yml` (Capture)

- **Trigger:** `pull_request` to `main` (opened, synchronize, reopened)
- **Permissions:** `contents: read` only
- **Credentials:** `persist-credentials: false`
- **Action:** Checks out the PR's exact head SHA, runs Playwright Firefox to
  capture popup screenshots, uploads them as a workflow artifact named
  `pr-visuals-<head_sha>`.
- **Reporting:** Does NOT comment on the PR — purely a capture step.

## Workflow 2: `pr-visual-report.yml` (Reporter)

- **Trigger:** `workflow_run` completion of `PR Visual Capture` from the trusted owner
- **Permissions:** `contents: read`, `pull-requests: write`, `actions: read`
- **No PR code checkout:** Sparse-checkouts only its own script from `main`.
- **Validation gates (all must pass):**
  1. **Run identity:** repo `full_name`, `path` (via API — uses top-level
     `run.repository.full_name` and `run.path`, matching real GitHub REST
     shape), event=`pull_request`, conclusion=`success`.
  2. **PR state:** open, not merged, head SHA matches run head SHA
     (stale guard — rejects force-pushed or closed PRs).
  3. **Artifact name:** exact match `pr-visuals-<head_sha>` via API
     (never downloads contents). Name is derived from the capture run's
     head_sha — prefix-only checks are insufficient.
- **Pre-mutation re-fetch:** The reporter re-fetches the PR from the API
  immediately before writing the comment. This catches force-pushes or
  merges that occurred between the initial validation and the write.
- **Comment:** Posts or updates a comment identified by the marker
  `<!-- pr-visual-report -->`. Paginates through comments to find existing
  one (bounded to 10 pages max to prevent infinite loops); only touches
  its own marker.

## Security Design

| Requirement | Approach |
|---|---|
| No PR code execution in reporter | workflow_run trigger, no checkout, sparse-checkout own script only |
| No secrets exposure in capture | `permissions: contents: read`, `persist-credentials: false` |
| No artifact JSON trust | Artifact name validated via API; contents never downloaded |
| Fork safety | `head_repository.owner.login == '<trusted-owner>'` gate on reporter; fallback PR search by head SHA |
| SHA-pinned actions | All actions pinned to full-length commit SHAs |
| Stale guard | Reporter re-fetches PR via API and verifies head SHA before writing; pre-mutation re-fetch catches force-pushes between validation and write |
| Comment isolation | Unique marker identifies own comment; never modifies other bots' comments |
| Bounded pagination | Pagination loops limited to 10 pages max; fail-closed on infinite-loop mocks |
| Exact artifact match | Artifact name must match `pr-visuals-<head_sha>` exactly; no prefix-only validation |

## Files

| File | Purpose |
|---|---|
| `.github/workflows/pr-visual-capture.yml` | Unprivileged capture workflow |
| `.github/workflows/pr-visual-report.yml` | Trusted reporter workflow |
| `scripts/visual-capture.mjs` | Capture script (Playwright Firefox) |
| `scripts/pr-visual-report.mjs` | Reporter script (API validation + comment) |
| `test/browser/visual-capture.test.js` | Unit tests verifying screenshots + dimensions |
| `test/unit/pr-visual-report.test.js` | Unit tests for reporter validation logic |

## Usage

### Locally

```bash
# Install Firefox for Playwright (if not cached)
npx playwright install firefox

# Capture current checkout
npm run visuals:capture
```

Outputs: `artifacts/visuals/popup-light-collapsed.png`, etc. + `manifest.json`.

### With base/head comparison

```bash
# Capture base first
git stash
git checkout <base-ref>
npm run visuals:capture -- --base <base-ref>

# Then capture head
git checkout <head-ref>
npm run visuals:capture
```

Produces `-before` / `-after` suffixed files for side-by-side comparison.

## Inline Image Limitation

GitHub does **not** natively embed private-repo artifact PNGs inline in PR
comments without an authenticated external image host (e.g., a public CDN or
a GitHub Pages site with a PAT). Since this is a private repo and we avoid
adding external dependencies:

- Screenshots are **downloadable artifacts** attached to the capture workflow run.
- The PR comment links to the capture run's artifact page.
- Future enhancement: a trusted external host could enable true inline diffs.

## Adding New Capture States

Edit `CAPTURES` in `scripts/visual-capture.mjs`:

```js
{ name: 'my-state', colorScheme: 'light', theme: 'light', expandSettings: true, expandMr: false },
```

Add corresponding assertions in `test/browser/visual-capture.test.js`.

## CI Integration

The capture workflow runs on every PR push to main. The reporter runs after
each successful capture. Neither blocks merge or runs on non-PR events.
