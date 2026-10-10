# Firefox Signing and AMO Release

Firefox requires Mozilla signing for permanent installation of release builds. Media Tamer now has a GitHub Actions workflow that can validate, package, and submit the extension to Mozilla Add-ons (AMO).

## Local unsigned build

```bash
npm ci
npm run build
```

Output:

```text
dist/media_tamer-<version>.zip
```

This ZIP is unsigned. It is useful for inspection and manual upload, but it is not a permanent-install Firefox release until Mozilla signs it.

## GitHub Actions AMO workflow

Workflow file:

```text
.github/workflows/firefox-amo-release.yml
```

It runs on:

- pushed version tags matching `v*.*.*`, for automatic releases
- manual `workflow_dispatch`, with a selectable `listed` or `unlisted` AMO channel

The workflow performs:

1. `npm ci`
2. `npm run lint:js`
3. `npm run lint:ext`
4. `npm run format:check`
5. `npm test -- --passWithNoTests`
6. `npm run test:browser`
7. `npm audit --omit=dev --audit-level=high`
8. `npm run build`
9. `web-ext sign` submission to AMO when publishing is enabled

## Required GitHub repository secrets

Create these in GitHub under **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
| --- | --- |
| `AMO_JWT_ISSUER` | AMO API JWT issuer / API key |
| `AMO_JWT_SECRET` | AMO API JWT secret |

Get both from the AMO credentials page:

```text
https://addons.mozilla.org/developers/addon/api/key/
```

Do not commit these values, paste them into issues, or print them in logs.

## First listed submission

For a listed AMO release, `web-ext sign --channel=listed` needs metadata. This repository includes:

```text
amo-metadata.json
```

The first AMO-listed submission can still require Mozilla account setup, validation prompts, or review before it becomes available to users. Future tagged releases use the same extension ID from `extensions/media-tamer/manifest.json`.

## Triggering an automatic AMO release

After the secrets are configured and the manifest version is bumped:

```bash
git tag v<manifest-version>
git push origin v<manifest-version>
```

Example:

```bash
git tag v1.2.2
git push origin v1.2.2
```

That tag starts the workflow and submits to the default `listed` AMO channel. For a one-off test, run **Firefox AMO Release** manually from GitHub Actions and choose `unlisted`.

## Local AMO signing commands

These commands require `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` in the shell environment:

```bash
npm run sign:amo:listed
npm run sign:amo:unlisted
```

The signed artifact, when AMO returns one, is written under:

```text
dist/amo/
```

## Safety notes

- Do not disable Firefox signature verification to work around signing.
- Do not reuse AMO credentials outside GitHub Actions or a local trusted shell.
- Listed releases may wait for Mozilla review; the workflow can submit the version, but AMO controls final publication timing.
- If AMO rejects the upload, fix the manifest/code, bump the manifest version, and tag again.
