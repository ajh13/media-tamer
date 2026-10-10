# Contributing to Media Tamer

## Setup

```bash
git clone https://github.com/ajh13/media-tamer.git
cd media-tamer
npm ci          # install from lockfile, never `npm install`
```

## Commands

```bash
# Unit tests (Node 24, mocked Firefox/Web Audio APIs)
npm test

# Lint JS (ESLint flat config) + extension structural validation
npm run lint

# Check formatting (Prettier)
npm run format:check

# Auto-format
npm run format

# Build extension package (unsigned .zip in dist/)
npm run build

# Dependency audit (dev-only, high severity+)
npm run audit

# Browser tests — real Firefox via Playwright (requires Firefox binary)
npm run test:browser
```

End-to-end tests live in `test/e2e/` with their own lockfile and pinned harness. That suite is **still evolving** and runs in isolation — see `docs/e2e.md` and `test/e2e/` for its current status before relying on it.

## Requirements

- Node.js 24 (CI), npm 12+
- Firefox binary installed for browser tests
  (`npx playwright install --with-deps firefox`)

## Code style

- **ESLint** flat config (`eslint.config.mjs`) with `no-undef` enabled
  and no blanket rule disables. Unused vars must be prefixed with `_`.
- **Prettier** with modest defaults (single quotes, trailing commas,
  100 char width).
- **Classic extension scripts** are NOT ES modules — no `export`/`import`.
  They run as IIFEs and expose `var` globals (e.g., `VC_NIGHT_MODE`).
- **No runtime code generation**: `eval`, `new Function`, and
  `setTimeout(string)` are forbidden by the structural validator.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). Do **not** paste credentials, tokens, cookies, or unredacted URLs into public issues. Sanitize query parameters. For security issues, see [`SECURITY.md`](SECURITY.md).

## Pull requests

Follow the [pull request template](.github/PULL_REQUEST_TEMPLATE.md). PRs from Dependabot are auto-merged after a 7-day cooldown (patch/minor devDependencies only) if CI passes. Major bumps and GitHub Actions updates require manual review. Security updates bypass the cooldown when manually merged.
