#!/usr/bin/env node
/**
 * gen-media-fixture.js — Generate a deterministic MP4 media fixture for the
 * e2e baseline runner. Uses ffmpeg to produce a small, reproducible test
 * video with a known duration. Provenance recorded in the fixture header.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const OUTPUT_DIR = path.join(__dirname, '..', 'node_modules', '.cache');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'media-test.mp4');
const PROVENANCE_FILE = path.join(OUTPUT_DIR, 'media-test.provenance.json');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const FIXTURE_SPEC = {
  description: 'Deterministic test video for e2e baseline regression',
  durationSeconds: 10,
  width: 640,
  height: 360,
  fps: 15,
  format: 'yuv420p',
  audio: {
    codec: 'aac',
    frequency: 440,
    sampleRate: 44100,
  },
  ffmpegSource: 'builtin testsrc + sine',
  purpose: 'Video Controls e2e: playbackRate, volume, seek-undo, theme tests',
};

console.log('Generating deterministic media fixture...');
console.log(`  Output: ${OUTPUT_FILE}`);
console.log(`  Spec: ${JSON.stringify(FIXTURE_SPEC, null, 2)}`);

// Generate video + audio using ffmpeg's built-in sources
// testsrc = moving color bars (visual), sine = pure tone (audio)
const args = [
  '-y',
  '-f', 'lavfi', '-i',
  `testsrc=duration=${FIXTURE_SPEC.durationSeconds}:size=${FIXTURE_SPEC.width}x${FIXTURE_SPEC.height}:rate=${FIXTURE_SPEC.fps}`,
  '-f', 'lavfi', '-i',
  `sine=frequency=${FIXTURE_SPEC.audio.frequency}:sample_rate=${FIXTURE_SPEC.audio.sampleRate}:duration=${FIXTURE_SPEC.durationSeconds}`,
  '-c:v', 'libx264', '-pix_fmt', FIXTURE_SPEC.format, '-preset', 'ultrafast', '-crf', '28',
  '-c:a', FIXTURE_SPEC.audio.codec, '-b:a', '64k',
  '-shortest',
  '-movflags', '+faststart',
  OUTPUT_FILE,
];

const result = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 60000 });

if (result.status !== 0) {
  console.error('ffmpeg failed:', result.stderr || result.stdout);
  process.exit(1);
}

const stats = fs.statSync(OUTPUT_FILE);
const hash = crypto.createHash('sha256').update(fs.readFileSync(OUTPUT_FILE)).digest('hex');

const provenance = {
  ...FIXTURE_SPEC,
  generatedAt: new Date().toISOString(),
  outputFile: OUTPUT_FILE,
  fileSizeBytes: stats.size,
  sha256: hash,
  ffmpegVersion: (() => {
    const v = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
    return v.stdout?.split('\n')[0] || 'unknown';
  })(),
  generator: 'gen-media-fixture.js (e2e deterministic)',
};

fs.writeFileSync(PROVENANCE_FILE, JSON.stringify(provenance, null, 2));

console.log('✓ Fixture generated successfully');
console.log(`  Size: ${stats.size} bytes`);
console.log(`  SHA-256: ${hash}`);
console.log(`  Provenance: ${PROVENANCE_FILE}`);
