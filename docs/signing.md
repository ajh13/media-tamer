# Marketplace releases

A version bump in `extensions/media-tamer/manifest.json` merged to `main` runs **Release Media Tamer**. It validates and tests both browsers, packages both extensions, and runs the Mozilla Add-ons, Chrome Web Store, and GitHub Release jobs independently. Both stores control their own review and publication timing.

`npm run build` produces `dist/media_tamer-<version>.zip` for Firefox and `dist/media_tamer-chrome-<version>.zip` for Chrome. The build derives Chrome's Manifest V3 and worker entry point from the Firefox manifest. Feature code, popup assets, and the version are shared. Bump the manifest version for each release.

## Mozilla Add-ons setup

Set the `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` repository Actions secrets using credentials from [Mozilla Add-ons Developer Hub](https://addons.mozilla.org/developers/addon/api/key/). The credential must have access to the listing for the Gecko ID in the manifest. The workflow uses `amo-metadata.json` for listed submissions and exits after submitting for review.

For a local signed build, export both AMO credentials in a trusted shell and run `npm run sign:amo:listed` or `npm run sign:amo:unlisted`. A returned XPI is written to `dist/amo/`. For self-distribution from GitHub Actions, run the release workflow with target `firefox-unlisted`.

## Chrome Web Store setup

1. Register as a [Chrome Web Store developer](https://developer.chrome.com/docs/webstore/register) and enable 2-step verification. In the Developer Dashboard, create the Media Tamer item if needed and complete the Store Listing, Privacy, and Distribution sections. Set the intended public visibility. For a new draft, upload a bootstrap ZIP with a version lower than the first automated release, so the version bump can replace that package. Use the project's build with the lower version in a disposable checkout.
2. Enable the Chrome Web Store API in Google Cloud. Create OAuth credentials and obtain a refresh token with the `https://www.googleapis.com/auth/chromewebstore` scope from an account that can publish the item. Put the OAuth consent app in production so the refresh token can be used for ongoing releases. Follow [Google's Chrome Web Store API setup](https://developer.chrome.com/docs/webstore/using-api).
3. In GitHub **Settings → Secrets and variables → Actions**, configure these values.

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `CWS_PUBLISHER_ID` | Publisher ID from Developer Dashboard publisher settings |
| Variable | `CWS_EXTENSION_ID` | 32-character Chrome item ID |
| Secret | `CWS_CLIENT_ID` | Google OAuth client ID |
| Secret | `CWS_CLIENT_SECRET` | Google OAuth client secret |
| Secret | `CWS_REFRESH_TOKEN` | Refresh token for the store publishing account |

The Chrome job uploads the versioned ZIP through API v2 and requests publication after approval. The API uses the listing's visibility. If Google requires the first submission or a visibility change to be published from the dashboard, complete that step there. The workflow recognizes a matching version already published or pending review.

For the store privacy form, describe Media Roller's optional transfer of the current URL to the user's self-hosted server and link to the [README privacy section](../README.md#privacy--permissions). Chrome uses site access for media control, `activeTab` for user-initiated URL access, `webNavigation` to reach embedded frames, `contextMenus` for presets, `declarativeContent` to enable the toolbar button on web pages, and optional `downloads` for Media Roller.

## Retry a submission

Re-run failed jobs after fixing their setup. To submit the current main version independently, open **Actions → Release Media Tamer → Run workflow** and select `chrome`, `firefox`, or `github`. Use the respective dashboard to check review status and resolve any rejected submission.
