/**
 * branding.test.js — TDD verification for the "Media Tamer" rebrand.
 *
 * These tests must FAIL before the rename is applied (RED) and PASS after (GREEN).
 * They cover: manifest name/description/version, runtime display strings
 * (popup/background/menu/pageAction), build filename, and docs branding.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const extDir = resolve('extensions/media-tamer');
const manifest = JSON.parse(readFileSync(resolve(extDir, 'manifest.json'), 'utf8'));
const popupHtml = readFileSync(resolve(extDir, 'popup.html'), 'utf8');
const popupJs = readFileSync(resolve(extDir, 'popup.js'), 'utf8');
const popupCss = readFileSync(resolve(extDir, 'popup.css'), 'utf8');
const bgJs = readFileSync(resolve(extDir, 'background.js'), 'utf8');
const buildCjs = readFileSync(resolve('scripts/build.cjs'), 'utf8');
const readme = readFileSync(resolve('README.md'), 'utf8');
const design = readFileSync(resolve('DESIGN.md'), 'utf8');
const contributing = readFileSync(resolve('CONTRIBUTING.md'), 'utf8');
const compatMd = readFileSync(resolve('docs/compatibility.md'), 'utf8');
const guidelines = readFileSync(resolve('docs/ui-and-extension-guidelines.md'), 'utf8');
const e2eMd = readFileSync(resolve('docs/e2e.md'), 'utf8');
const signingMd = readFileSync(resolve('docs/signing.md'), 'utf8');
const pkgJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

describe('Media Tamer branding — manifest identity', () => {
  test('manifest name is "Media Tamer"', () => {
    assert.equal(manifest.name, 'Media Tamer');
  });
  test('manifest description retained', () => {
    assert.match(manifest.description, /Prevent accidental number-key seeks/);
  });
  test('manifest version bumped to 1.2.2 (new branding release)', () => {
    assert.equal(manifest.version, '1.2.2');
  });
  test('gecko.id preserved as media-tamer@example.invalid', () => {
    assert.equal(manifest.browser_specific_settings.gecko.id, 'media-tamer@example.invalid');
  });
  test('page_action default_title is "Media Tamer"', () => {
    assert.equal(manifest.page_action.default_title, 'Media Tamer');
  });
});

describe('Media Tamer branding — runtime display strings', () => {
  test('popup.html <title> is "Media Tamer"', () => {
    assert.match(popupHtml, /<title>Media Tamer<\/title>/);
  });
  test('popup.js header comment references Media Tamer', () => {
    assert.match(popupJs, /Media Tamer — Popup script/);
  });
  test('popup.css header comment references Media Tamer', () => {
    assert.match(popupCss, /Media Tamer — Compact popup/);
  });
  test('background.js header comment references Media Tamer', () => {
    assert.match(bgJs, /Media Tamer — Background script/);
  });
  test('background.js pageAction title uses "Media Tamer"', () => {
    assert.match(bgJs, /Media Tamer \\u2014/);
    assert.ok(!bgJs.includes('Video Controls \\u2014'), 'legacy pageAction title must be gone');
  });
  test('background.js root context menu title is "Media Tamer"', () => {
    const rootMenuMatch = bgJs.match(/id: 'vg-root', title: 'Media Tamer'/);
    assert.ok(rootMenuMatch, 'vg-root menu must have title "Media Tamer"');
    assert.ok(!bgJs.includes("title: 'Video Controls'"), 'legacy root menu title must be gone');
  });
});

describe('Media Tamer branding — build artifact', () => {
  test('build.cjs produces media_tamer-<version>.zip', () => {
    assert.match(buildCjs, /media_tamer-\$\{version\}\.zip/);
    assert.ok(!buildCjs.includes('video_controls-'), 'legacy build filename must be gone');
  });
  test('no leftover video_controls in dist or README', () => {
    assert.ok(!readme.includes('video_controls'), 'README must not reference legacy build name');
  });
});

describe('Media Tamer branding — docs', () => {
  test('README.md title is "Media Tamer — Firefox Extension"', () => {
    assert.match(readme, /# Media Tamer — Firefox Extension/);
    assert.match(readme, /dist\/media_tamer-<version>\.zip/);
  });
  test('DESIGN.md title references Media Tamer', () => {
    assert.match(design, /# Media Tamer Extension — Design System/);
  });
  test('CONTRIBUTING.md title references Media Tamer', () => {
    assert.match(contributing, /# Contributing to Media Tamer/);
  });
  test('docs/compatibility.md title and root menu reference Media Tamer', () => {
    assert.match(compatMd, /# Media Tamer — Firefox Compatibility Report/);
    assert.match(compatMd, /Root menu "Media Tamer"/);
    assert.ok(
      !compatMd.includes('Root menu "Video Controls"'),
      'legacy root menu in compat doc must be gone',
    );
  });
  test('docs/ui-and-extension-guidelines.md references Media Tamer in titles', () => {
    assert.match(guidelines, /# Firefox Media Tamer Extension — UI & Extension Guidelines/);
    assert.match(guidelines, /"default_title": "Media Tamer"/);
    assert.ok(
      guidelines.includes('Prefix with `VC_` (Media Tamer)'),
      'VC_ prefix explanation must reference Media Tamer',
    );
  });
  test('docs/e2e.md references Media Tamer', () => {
    assert.match(e2eMd, /# E2E Baseline Regression Test — Media Tamer Anchored Popup/);
    assert.match(e2eMd, /for the Media Tamer/);
  });
  test('docs/signing.md uses media_tamer filename', () => {
    assert.match(signingMd, /dist\/media_tamer-<\w+>\.zip/);
    assert.ok(!signingMd.includes('video_controls'), 'legacy signing doc filename must be gone');
  });
});

describe('Media Tamer branding — package.json metadata', () => {
  test('package description references Media Tamer', () => {
    assert.match(pkgJson.description, /Media Tamer/);
  });
  test('package name uses media-tamer', () => {
    assert.equal(pkgJson.name, 'media-tamer');
  });
});

describe('Media Tamer branding — GitHub templates', () => {
  test('bug report template references Media Tamer', () => {
    const bug = readFileSync(resolve('.github/ISSUE_TEMPLATE/bug_report.md'), 'utf8');
    assert.match(bug, /Report a problem in Media Tamer/);
  });
  test('feature request template references Media Tamer', () => {
    const feat = readFileSync(resolve('.github/ISSUE_TEMPLATE/feature_request.md'), 'utf8');
    assert.match(feat, /Suggest an enhancement for Media Tamer/);
  });
});

describe('Media Tamer branding — preserved internals', () => {
  test('internal extension folder name media-tamer exists', () => {
    assert.ok(existsSync(resolve('extensions/media-tamer')), 'media-tamer folder must exist');
  });
  test('legacy video-number-guard source directory is absent', () => {
    assert.ok(
      !existsSync(resolve('extensions/video-number-guard')),
      'legacy video-number-guard source directory must be gone',
    );
  });
  test('internal VC_ protocol constants are preserved in popup.js', () => {
    assert.ok(
      popupJs.includes("VOLUME_SET: 'VC_VOLUME_SET'"),
      'VC_ protocol constants must remain',
    );
  });
  test('internal VC_ protocol constants are preserved in background.js', () => {
    assert.ok(bgJs.includes("VOLUME_SET: 'VC_VOLUME_SET'"), 'VC_ protocol constants must remain');
  });
  test('volume.js internal reference to Video Number Guard is preserved', () => {
    const vol = readFileSync(resolve('extensions/media-tamer/volume.js'), 'utf8');
    assert.match(vol, /Video Number Guard — Volume \+ Night Mode/);
  });
  test('GitHub repo references (example-owner/media-tamer) preserved for parent', () => {
    assert.ok(
      !readme.includes('example-owner/media-tamer'),
      'README has no hard remote URL to change',
    );
  });
});

describe('Media Tamer branding — display strings audit', () => {
  test('no leftover "Video Controls" in extension runtime sources', () => {
    for (const [name, src] of [
      ['popup.js', popupJs],
      ['popup.html', popupHtml],
      ['popup.css', popupCss],
      ['background.js', bgJs],
    ]) {
      assert.ok(!src.includes('Video Controls'), `${name} must not contain "Video Controls"`);
    }
  });
  test('manifest.json has no "Video Controls"', () => {
    const raw = readFileSync(resolve(extDir, 'manifest.json'), 'utf8');
    assert.ok(!raw.includes('Video Controls'), 'manifest.json must not contain "Video Controls"');
  });
});
