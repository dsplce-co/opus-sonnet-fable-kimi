#!/usr/bin/env bash
# report.sh — grade every run, then print the per-run table + per-model summary.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "grading all runs (this re-runs the hidden suite against each) ..."
bash "$HERE/grade.sh" "$HERE"/runs/*/ > "$HERE/runs/_grade.log" 2>&1
node "$HERE/aggregate.mjs"
