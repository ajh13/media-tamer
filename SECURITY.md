# Security Policy

## Privacy

This browser extension:

- **Has no telemetry or analytics.** Playback settings are per-tab in-memory;
  shortcut and Media Roller configuration persist locally. The optional
  Media Roller feature transmits the current tab URL to your chosen server.
- **Makes no network requests** beyond the optional Media Roller feature,
  which requires an explicit user gesture and a user-configured self-hosted
  server URL (`http://` or `https://` only, validated before use).
- **Uses browser permissions for its controls.** The core manifest declares
  `menus`, `storage`, `webNavigation`, `activeTab`, `theme`; `downloads`
  is optional and only requested on an explicit user gesture.

## Reporting a vulnerability

**Do not report security vulnerabilities in public GitHub issues.** Public
issues are visible to everyone and can expose details before a fix is ready.

Use the repository's **private vulnerability reporting** (GitHub Advisory)
if it is enabled for this repo. Look for a "Report a vulnerability" button
on the **Security** tab, or open a draft security advisory directly:
`https://github.com/ajh13/media-tamer/security/advisories/new`.

If private reporting is not enabled, contact the repository owner privately
through a channel you already trust. **Never include credentials, tokens,
or exploit details in a public issue.**

## Development

- No secrets, tokens, or API keys are checked into this repository.
- Dependabot alerts are enabled for supply-chain monitoring.
- Dependency updates are audited via `npm audit` in CI (`--audit-level=high`,
  dev-only).
- Major version bumps and GitHub Actions changes require manual review.
