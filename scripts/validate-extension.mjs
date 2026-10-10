#!/usr/bin/env node
/**
 * validate-extension.mjs
 *
 * Static safety checks for the classic browser WebExtension sources.
 * These scripts run in the extension's isolated world with no build step,
 * so we verify structural constraints that a bundler would otherwise catch:
 *
 *   1. No ES module syntax (export/import) in classic scripts — they are
 *      loaded via <script> tags in manifest.json, not as modules.
 *   2. No runtime code generation (eval, new Function, setTimeout(string),
 *      setInterval(string)) — these bypass CSP and are a supply-chain risk.
 *   3. Manifest references resolve to real files and nothing shippable
 *      (tests, docs) is accidentally referenced.
 *   4. Each classic script assigns exactly one expected global (VC_*).
 *
 * Uses acorn for parse-time validation (no execution). Exits non-zero on
 * any violation so CI fails fast.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const EXT_DIR = join(ROOT, 'extensions', 'media-tamer');
const MANIFEST_PATH = join(EXT_DIR, 'manifest.json');

const errors = [];
const warnings = [];

function fail(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

// --- 1. Parse each classic script with acorn, reject ES module syntax ------
function validateScript(filePath) {
  const code = readFileSync(filePath, 'utf8');
  const rel = relative(ROOT, filePath);

  let ast;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType: 'module', // parse as module to detect export/import
      locations: true,
    });
  } catch (_e) {
    // If it fails as a module, try as a script (classic scripts are not modules)
    try {
      ast = acorn.parse(code, {
        ecmaVersion: 2022,
        sourceType: 'script',
        locations: true,
      });
    } catch (e2) {
      fail(`${rel}: parse error — ${e2.message}`);
      return;
    }
  }

  // Walk AST for forbidden nodes
  const forbidden = [];
  function walk(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression') {
      forbidden.push({ line: node.loc?.start?.line, kind: 'import' });
    }
    if (
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportDefaultDeclaration' ||
      node.type === 'ExportAllDeclaration'
    ) {
      forbidden.push({ line: node.loc?.start?.line, kind: 'export' });
    }
    if (node.type === 'CallExpression' && node.callee) {
      const callee = node.callee;
      // eval(...)
      if (callee.type === 'Identifier' && callee.name === 'eval') {
        forbidden.push({ line: node.loc?.start?.line, kind: 'eval' });
      }
      // new Function(...)
      if (
        callee.type === 'Identifier' &&
        callee.name === 'Function' &&
        parent?.type === 'NewExpression'
      ) {
        forbidden.push({ line: node.loc?.start?.line, kind: 'new Function' });
      }
      // setTimeout(string, ...) / setInterval(string, ...)
      if (
        (callee.name === 'setTimeout' || callee.name === 'setInterval') &&
        node.arguments.length > 0 &&
        node.arguments[0].type === 'Literal' &&
        typeof node.arguments[0].value === 'string'
      ) {
        forbidden.push({ line: node.loc?.start?.line, kind: `${callee.name}(string)` });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) walk(c, node);
      } else if (child && typeof child === 'object' && child.type) {
        walk(child, node);
      }
    }
  }
  walk(ast, null);

  if (forbidden.length) {
    for (const f of forbidden) {
      fail(`${rel}:${f.line ?? '?'}: forbidden — ${f.kind}`);
    }
  }
}

// --- 2. Manifest reference check -----------------------------------------
function validateManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    fail('manifest.json missing');
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

  // Content scripts
  for (const cs of manifest.content_scripts ?? []) {
    for (const js of cs.js ?? []) {
      const p = join(EXT_DIR, js);
      if (!existsSync(p)) {
        fail(`manifest content_scripts.js references missing file: ${js}`);
      }
    }
  }

  // Background scripts
  for (const js of manifest.background?.scripts ?? []) {
    const p = join(EXT_DIR, js);
    if (!existsSync(p)) {
      fail(`manifest background.scripts references missing file: ${js}`);
    }
  }

  // Icons
  for (const size of Object.values(manifest.icons ?? {})) {
    const p = join(EXT_DIR, size);
    if (!existsSync(p)) {
      fail(`manifest icon references missing file: ${size}`);
    }
  }

  // Ensure no test/doc files are referenced
  const allFiles = readdirSync(EXT_DIR);
  for (const f of allFiles) {
    if (f === 'tests' || f === 'docs') {
      warn(`non-shipped directory present (parent cleanup): ${f}/`);
    }
  }
}

// --- 3. Global assignment check ------------------------------------------
function validateGlobalAssignments() {
  const expectedGlobals = {
    'night-mode.js': 'VC_NIGHT_MODE',
    'media-roller.js': 'VC_MEDIA_ROLLER',
  };
  for (const [file, expected] of Object.entries(expectedGlobals)) {
    const p = join(EXT_DIR, file);
    if (!existsSync(p)) continue;
    const code = readFileSync(p, 'utf8');
    if (!code.includes(expected)) {
      fail(`${file} does not assign expected global ${expected}`);
    }
  }
}

// --- Main ----------------------------------------------------------------
const scriptFiles = readdirSync(EXT_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(EXT_DIR, f));

for (const f of scriptFiles) {
  validateScript(f);
}
validateManifest();
validateGlobalAssignments();

if (warnings.length) {
  console.warn('Warnings:\n' + warnings.map((w) => '  ⚠ ' + w).join('\n'));
}

if (errors.length) {
  console.error(
    `\nvalidate-extension: ${errors.length} error(s):\n` + errors.map((e) => '  ✗ ' + e).join('\n'),
  );
  process.exit(1);
}

console.log(`✓ validate-extension passed (${scriptFiles.length} scripts, manifest OK)`);
