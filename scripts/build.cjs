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

async function main() {
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error('manifest.json missing');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const version = manifest.version;
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
    throw new Error(`Unexpected manifest version: ${version}`);
  }

  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const zip = new JSZip();
  addDirectory(zip, EXTENSION_DIR);
  const zipData = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  });

  const zipFile = `media_tamer-${version}.zip`;
  const outputPath = path.join(DIST_DIR, zipFile);
  fs.writeFileSync(outputPath, zipData);

  console.log(`\nBuilt: ${outputPath}`);
  console.log(`Size: ${fs.statSync(outputPath).size} bytes`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
