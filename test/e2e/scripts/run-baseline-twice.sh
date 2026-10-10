#!/usr/bin/env bash
# run-baseline-twice.sh — Execute the baseline runner twice in succession.
# Verifies reproducibility: both runs must independently pass.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "=== Run 1 ==="
node scripts/baseline-runner.js
echo "=== Run 1 PASSED ==="
echo ""
echo "=== Run 2 ==="
node scripts/baseline-runner.js
echo "=== Run 2 PASSED ==="
echo ""
echo "=== BASELINE REPRODUCIBLE: 2/2 runs passed ==="
