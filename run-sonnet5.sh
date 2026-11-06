#!/usr/bin/env bash
# Run the benchmark prompt against Claude Sonnet 5 (your normal Claude Code auth) in a fresh run dir.
# node_modules is SYMLINKED (not copied) so many runs don't duplicate a big install and fill the disk.
set -euo pipefail

MODEL_TAG="sonnet-5"
MODEL_ID="claude-sonnet-5"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$HERE/setup.sh"

# --- model env (pin the model; use normal Claude Code auth) ---
unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN 2>/dev/null || true
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL_ID"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$MODEL_ID"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL_ID"
export ANTHROPIC_MODEL="$MODEL_ID"
export CLAUDE_CODE_SUBAGENT_MODEL="$MODEL_ID"
export ENABLE_TOOL_SEARCH=false

# --- fresh run folder (auto-incrementing); copy source, symlink node_modules ---
mkdir -p "$HERE/runs"
n=1; while [ -e "$HERE/runs/${MODEL_TAG}-${n}" ]; do n=$((n + 1)); done
RUN_DIR="$HERE/runs/${MODEL_TAG}-${n}"
mkdir -p "$RUN_DIR"
cp "$HERE"/scaffold/*.ts "$HERE"/scaffold/package.json "$HERE"/scaffold/tsconfig.json "$RUN_DIR"/
ln -s ../../scaffold/node_modules "$RUN_DIR/node_modules"
rm -f "$RUN_DIR"/hidden*.ts   # never let the hidden suite leak into a run

# --- run the prompt agentically: high effort, bypass permission prompts, tee a transcript ---
PROMPT="$(cat "$HERE/PROMPT.txt")"
cd "$RUN_DIR"
echo "[$MODEL_TAG] run #$n  model=$ANTHROPIC_MODEL  cwd=runs/${MODEL_TAG}-${n}"
claude -p "$PROMPT" --permission-mode bypassPermissions --effort high 2>&1 | tee "$RUN_DIR/transcript.txt"
echo "[$MODEL_TAG] done -> runs/${MODEL_TAG}-${n}  (code + REPORT.md left in place)"
