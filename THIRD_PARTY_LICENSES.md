# Third-party notices

Media Tamer's original project code is licensed under the MIT License in `LICENSE`. Third-party components retain their own licenses; the root license does not relicense them.

## Firefox WebExtension Playwright harness (development only)

- Upstream: https://github.com/duckduckgo/firefox-webext-playwright-harness
- Vendored archive: `test/e2e/scripts/firefox-webext-playwright-harness-0.3.0.tgz`
- License: Apache License 2.0, included as `LICENSE.md` inside the archive.
- The archive includes readable source and upstream attribution headers.
- Its `src/web-ext-rdp.js` incorporates Mozilla `web-ext` 8.9.0 code under the Mozilla Public License 2.0. The file's header documents its origins and modifications. That component remains MPL-2.0, not MIT or Apache-2.0.
- Upstream component: https://github.com/mozilla/web-ext
- MPL 2.0 license text: https://www.mozilla.org/MPL/2.0/

This test harness is not included in the Firefox extension ZIP. JavaScript dependencies used for development and packaging retain the licenses distributed in their respective packages. See the dependency lockfiles and package license files for their exact versions and terms.
