#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');

const ROOT = path.join(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT, 'extensions', 'media-tamer');
const DIST_DIR = path.join(ROOT, 'dist');
const MANIFEST_PATH = path.join(EXTENSION_DIR, 'manifest.json');

function assertSafeRelative(rel) {
  if (!rel || rel.startsWith('.') || path.isAbsolute(rel) || rel.includes('..')) {
    throw new Error(`Refusing unsafe extension archive path: ${rel}`);
  }
}

function addDirectory(zip, dir, baseDir = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const rel = path.relative(baseDir, fullPath).split(path.sep).join('/');
    assertSafeRelative(rel);

    if (entry.isDirectory()) {
      addDirectory(zip, fullPath, baseDir);
    } else if (entry.isFile()) {
      zip.file(rel, fs.readFileSync(fullPath));
    }
  }
}

function buildChromeDirectory(manifest) {
  const { background, browser_specific_settings, page_action, permissions, ...common } = manifest;
  const { show_matches, ...action } = page_action;
  const chromeManifest = {
    ...common,
    manifest_version: 3,
    // Chrome 148 provides the browser namespace and Promise message responses.
    minimum_chrome_version: '148',
    background: { service_worker: 'chrome-worker.js' },
    action: { ...action, default_state: 'disabled' },
    permissions: [
      ...permissions.filter((permission) => !['menus', 'theme'].includes(permission)),
      'contextMenus',
      'declarativeContent',
    ],
  };
  const chromeDir = path.join(DIST_DIR, 'chrome');
  fs.rmSync(chromeDir, { recursive: true, force: true });
  fs.cpSync(EXTENSION_DIR, chromeDir, {
    recursive: true,
    filter: (file) => !path.basename(file).startsWith('.'),
  });
  fs.writeFileSync(
    path.join(chromeDir, 'manifest.json'),
    JSON.stringify(chromeManifest, null, 2) + '\n',
  );
  const imports = background.scripts.map((file) => JSON.stringify(file)).join(', ');
  fs.writeFileSync(path.join(chromeDir, 'chrome-worker.js'), `importScripts(${imports});\n`);
  return chromeDir;
}

async function writeZip(directory, zipFile) {
  const zip = new JSZip();
  addDirectory(zip, directory);
  const zipData = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  });
  const outputPath = path.join(DIST_DIR, zipFile);
  fs.writeFileSync(outputPath, zipData);
  console.log(`Built: ${outputPath} (${zipData.length} bytes)`);
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const { version } = manifest;
  const parts = version.split('.');
  if (
    !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version) ||
    parts.some((part) => String(Number(part)) !== part || Number(part) > 65535) ||
    parts.every((part) => part === '0')
  ) {
    throw new Error(`Unexpected manifest version: ${version}`);
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const chromeDir = buildChromeDirectory(manifest);
  await Promise.all([
    writeZip(EXTENSION_DIR, `media_tamer-${version}.zip`),
    writeZip(chromeDir, `media_tamer-chrome-${version}.zip`),
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
