# Tooling & Maintenance

Quality tooling configuration, dependency automation, and maintenance procedures.

## Contents

- [ESLint Flat Config](#eslint-flat-config)
- [Prettier](#prettier)
- [Extension Structural Validator](#extension-structural-validator)
- [Dependabot](#dependabot)
- [Dependabot Auto-Merge Gate](#dependabot-auto-merge-gate)
- [GitHub CI](#github-ci)
- [Security](#security)
- [Sources](#sources)

## ESLint Flat Config

**File:** `eslint.config.mjs` (ESLint v10 flat config)

Two targeted blocks with explicit globals:

| Block | Files | Globals | Notes |
|-------|-------|---------|-------|
| Extension scripts | `extensions/**/*.js` | `browser`, `webextensions`, `VC_NIGHT_MODE:readonly`, `VC_MEDIA_ROLLER:readonly` | Classic scripts (IIFE, no ES modules). `no-implicit-globals` enforced. |
| Node tests | `test/**/*.js`, `scripts/*.mjs` | `node`, `nodeBuiltin` | ES module test files. |

Key rules:
- `no-undef: error` — no implicit globals
- `no-unused-vars: error` with `^_` ignore pattern (intentional unused must be prefixed)
- `no-implicit-globals: error` — prevents accidental global leakage in classic scripts
- No blanket `eslint-disable` overrides

Custom globals declared: `VC_NIGHT_MODE`, `VC_MEDIA_ROLLER` (assigned as `var` at top scope in night-mode.js and media-roller.js respectively).

## Prettier

**File:** `.prettierrc.json`

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

Applied via `prettier --check` / `prettier --write`. Excludes `node_modules/`, `dist/`, `*.xpi`, `*.zip`.

## Extension Structural Validator

**File:** `scripts/validate-extension.mjs`

Runs in CI (`npm run lint:ext`) and uses **acorn** for parse-time validation without execution:

1. **No ES module syntax** in classic scripts (export/import detected via acorn AST)
2. **No runtime code generation**: `eval`, `new Function`, `setTimeout(string)`, `setInterval(string)`
3. **Manifest reference check**: all `content_scripts.js`, `background.scripts`, and `icons` paths resolve
4. **Global assignment check**: `night-mode.js` declares `VC_NIGHT_MODE`, `media-roller.js` declares `VC_MEDIA_ROLLER`

Exits non-zero on any violation.

## Dependabot

**File:** `.github/dependabot.yml`

Two update configurations:

### npm devDependencies
- **Schedule:** weekly, Monday 09:00 UTC
- **Open PR limit:** 5
- **Grouped:** patch + minor updates under `npm-dev-patch-minor`
- **Major updates:** separate, manual review (eslint/prettier majors explicitly ignored)
- **Labels:** `dependencies`, `npm`

### GitHub Actions
- **Schedule:** weekly, Monday 09:00 UTC
- **Open PR limit:** 3
- **Manual review required** (supply chain sensitivity)

## Dependabot Auto-Merge Gate

**File:** `scripts/dependabot-automerge.mjs`
**Workflow:** `.github/workflows/dependabot-automerge.yml` (daily 02:00 UTC + manual dispatch with `dry_run` input)

**Safety model:**
- NEVER checks out PR code, never runs `npm install`/build
- Uses default `GITHUB_TOKEN` only (no PAT, no secrets)
- Minimal permissions: `contents:read`, `pull-requests:write`, `actions:read`, `checks:read`

**Eligibility gate (all must pass):**

| # | Check | Rationale |
|---|-------|-----------|
| 1 | Author is `dependabot[bot]` | Only bot PRs |
| 2 | Base branch is `main` | No feature branch merges |
| 3 | PR state is `open` | |
| 4 | PR is not a `draft` | |
| 5 | PR is `mergeable` (not behind, no conflicts) | |
| 6 | PR is from the same repository (not a fork) | |
| 7 | No `CHANGES_REQUESTED` review (latest per reviewer) | Don't ignore review requests |
| 8 | Changed files EXACTLY `package.json` + `package-lock.json` | No unexpected file changes |
| 9 | CI passing on exact head SHA | Fresh green check |
| 10 | All check runs successful (allChecksGreen) | |
| 11 | `ci.yml` workflow successful on head SHA | Named workflow, not arbitrary latest |
| 12 | Expected CI jobs (`quality`, `unit-tests`, `browser-tests`) all pass | |
| 13 | All changes are patch/minor devDependency bumps | No major, no added/removed deps |
| 14 | No runtime dependency changes (even duplicate names) | Only devDependencies |
| 15 | No prerelease, downgrade, or invalid versions | |
| 16 | Metadata outside devDependencies identical | No scripts/engines/name/peerDeps changes |
| 17 | Registry URL + integrity match for every changed version | Exact registry validation |
| 18 | Publication age >= 7 days for ALL changed versions (including nested/transitive) | Cooldown fail-closed |
| 19 | Non-registry versions rejected (git+, file:, workspace:) | Only npm registry |
| 20 | Merge API with `sha=headSha` + read-back verification | Prevent race conditions |

**Version cooldown:** Every changed npm package version (including nested/transitive in the lockfile) must have been published >= 7 days ago, verified via `registry.npmjs.org/<name>` full packument `time[version]`. Missing/unparseable publication dates **fail closed** (PR not auto-merged).

**Registry validation:** For every changed version, the lockfile `resolved` URL and `integrity` hash must match the registry metadata exactly. The tarball URL must be from `https://registry.npmjs.org/`. Mismatches **fail closed**.

**Tests:** `test/unit/dependabot-automerge.test.js` — ~100 tests covering eligibility logic, `findLockfileEntry` transitive-dep resolution, and registry validation with mocked inputs.

**Activation:** Live merging requires two explicit steps — set a repository variable and reconfigure the schedule trigger:
1. Set repository variable `AUTOMERGE_LIVE` to `'false'` (default) for dry-run-only operation.
2. After safety review, set `AUTOMERGE_LIVE` to `'true'` to enable live merges from the daily scheduled run. Manual `workflow_dispatch` always defaults to `dry_run=true` and must explicitly opt in to `dry_run=false`.

**Security advisory bypass:** This gate does **not** handle Dependabot security-advisory merges (those use `@dependabot merge` and GitHub's own review flow). The gate is fail-closed — `@dependabot rebase`/`squash` commands re-trigger CI, and the script re-validates the exact head SHA before any merge action. GitHub's `dependabot.yml` ignore rules remain the correct mechanism for blocking unwanted bumps.

## GitHub CI

**File:** `.github/workflows/ci.yml`

Three jobs (quality → unit-tests, browser-tests):

| Job | Timeout | Key Steps |
|-----|---------|-----------|
| `quality` | 10m | `npm ci`, `lint:js`, `lint:ext`, `format:check` |
| `unit-tests` | 15m | `node --test test/unit/*.test.js`, `npm audit --omit=dev` |
| `browser-tests` | 30m | `npx playwright install --with-deps firefox`, `test:browser`, artifact upload on failure |

**Permissions:** `contents:read` only
**Concurrency:** cancel-in-progress on same ref
**Actions pinned to SHA:** all `uses:` references are full-length commit SHAs verified via `gh api repos/<action>/git/ref/tags/v4`:
- `actions/checkout@11d5960a326750d5838078e36cf38b85af677262` (# v4)
- `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (# v4)
- `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02` (# v4)

## Security

- `npm audit --omit=dev --audit-level=high` runs in CI (dev-only, cannot invent clean — reports only)
- `SECURITY.md` documents no data collection, no public issue reporting
- No default CODEOWNERS owner is assigned
- No secrets/PAT in repository

**CodeQL:** Not enabled. GitHub CodeQL requires either GitHub Advanced Security (org-level entitlement) or a public repository. For a private repo without GHAS entitlement, CodeQL is not available. Recommend enabling Dependabot alerts (already enabled) and the SHA-pinning policy as the primary supply-chain hardening.

## Branch Protection (propose to parent)

Minimal rules to enable public conversion while preserving the automerge
gate's security properties:

| Setting | Value | Rationale |
|---------|-------|-----------|
| Require PRs before merging | ✅ | No direct pushes to `main` |
| Require status checks | `quality`, `unit-tests`, `browser-tests` | Hardens CI beyond advisory |
| Require up-to-date branches | ✅ | Prevents stale-CI race conditions |
| Require conversation resolution | ✅ | Resolved review threads before merge |
| No force pushes | ✅ | Audit trail integrity |
| No deletions | ✅ | Branch recovery |
| Require signed commits | ✅ (optional) | Supply-chain provenance |
| Allow automatic merging | ⚠️ Optional | Enables gate; review implications below |

**CI status checks are sufficient on their own** — branch protection
required-status-checks enforce the same `ci.yml` gate that the automerge
script validates. Branch protection is defense-in-depth, not a prerequisite
for script correctness.

**Security advisory bypass concerns:**
- **Dependabot security advisories** use a separate code path (`@dependabot merge`)
  that bypasses this gate entirely. This gate is for version-bump PRs, not
  security-advisory merges. Security-advisory merges are intentionally out of
  scope — they use GitHub's own review process, not our script.
- **GitHub-ignore rules** in `dependabot.yml` (eslint/prettier majors) are the
  correct mechanism for blocking unwanted bumps. The gate rejects anything
  outside patch/minor/devDeps, so even if ignore rules are widened, the gate
  remains fail-closed.
- **`@dependabot rebase`** comments bypass nothing — the gate re-evaluates CI
  on every new head SHA.
- **`@dependabot squash`** similarly re-triggers CI; the gate's head-SHA
  validation ensures stale green checks never authorize a merge.

## Sources

- [ESLint Flat Config Migration Guide](https://eslint.org/docs/latest/use/configure/migration-guide)
- [ESLint v10 defineConfig + globalIgnores](https://eslint.org/blog/2025/03/flat-config-extends-define-config-global-ignores/)
- [globals npm package (webextensions)](https://www.npmjs.com/package/globals)
- [Dependabot Options Reference (cooldown, groups)](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
- [GitHub Blog: Tame Dependabot — Group Your Updates](https://github.blog/security/supply-chain-security/tame-dependabot-group-your-updates-slow-the-cadence-keep-security-fast/)
- [GitHub Actions: Security Hardening — SHA Pinning](https://docs.github.com/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
- [GitHub Blog: Actions Policy Supports SHA Pinning (Aug 2025)](https://github.blog/changelog/2025-08-15-github-actions-policy-now-supports-blocking-and-sha-pinning-actions/)
- [Pinning GitHub Actions to Commit SHAs](https://www.romainlespinasse.dev/posts/github-actions-commit-sha-pinning/)
- [acorn — JavaScript Parser](https://www.npmjs.com/package/acorn)
- [npm Audit](https://docs.npmjs.com/cli/v10/commands/npm-audit)
- [Prettier Configuration](https://prettier.io/docs/en/configuration.html)
- [Dependabot Auto-Merge GitHub Action (third-party, not used — we use our own gate)](https://github.com/ahmadnassri/action-dependabot-auto-merge)
