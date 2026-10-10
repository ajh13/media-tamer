import { defineConfig } from 'eslint/config';
import globals from 'globals';

// Custom globals exposed by this repo's classic (non-module) extension scripts.
// Each is assigned as a `var` global at top scope and read by other scripts.
const EXTENSION_CUSTOM_GLOBALS = {
  VC_NIGHT_MODE: 'readonly',
  VC_MEDIA_ROLLER: 'readonly',
};

// -- Classic browser extension scripts (IIFE, no ES module exports) ----------
const extensionScriptBlock = {
  files: ['extensions/**/*.js'],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
    globals: {
      ...globals.browser,
      ...globals.webextensions,
      ...EXTENSION_CUSTOM_GLOBALS,
    },
  },
  rules: {
    'no-undef': 'error',
    'no-unused-vars': [
      'error',
      {
        vars: 'all',
        args: 'after-used',
        // Intentional: IIFE params, factory returns, and catch bindings that
        // are deliberately unused are prefixed with `_` to signal intent.
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      },
    ],
    // Classic scripts must not leak globals; flag assignments without `var`.
    'no-implicit-globals': 'error',
    // Catch use of ES module syntax in classic scripts (defense in depth —
    // the acorn validator in lint:js is the authoritative check).
    'import/no-unresolved': 'off',
  },
};

// -- Node test files (ES modules, node globals) -----------------------------
const nodeTestBlock = {
  files: ['test/unit/**/*.js', 'scripts/**/*.mjs'],
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: 'module',
    globals: {
      ...globals.node,
      ...globals.nodeBuiltin,
    },
  },
  rules: {
    'no-undef': 'error',
    'no-unused-vars': [
      'error',
      {
        vars: 'all',
        args: 'after-used',
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      },
    ],
  },
};

// -- Browser test files (Playwright, need browser + node globals) ---------
const browserTestBlock = {
  files: ['test/browser/**/*.js'],
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: 'module',
    globals: {
      ...globals.node,
      ...globals.nodeBuiltin,
      ...globals.browser,
      ...globals.webextensions,
      VC_NIGHT_MODE: 'readonly',
    },
  },
  rules: {
    'no-undef': 'error',
    'no-unused-vars': [
      'error',
      {
        vars: 'all',
        args: 'after-used',
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      },
    ],
  },
};

// -- Shared ignores --------------------------------------------------------
const ignoresBlock = {
  ignores: [
    'node_modules/**',
    'dist/**',
    'build/**',
    '*.xpi',
    '*.zip',
    'playwright-report/**',
    'test-results/**',
    'extensions/**/tests/**', // child test dirs being cleaned up by parent
    'extensions/**/docs/**', // integration docs, not shipped
    'docs/**', // design docs, not shipped
    'tests/**', // legacy test dir being consolidated by parent
  ],
};

export default defineConfig([
  ignoresBlock,
  extensionScriptBlock,
  nodeTestBlock,
  browserTestBlock,
  {
    // Relax rules for config files that run in Node with CommonJS.
    files: ['*.cjs', 'scripts/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.node, ...globals.nodeBuiltin },
    },
    rules: { 'no-undef': 'error' },
  },
]);
