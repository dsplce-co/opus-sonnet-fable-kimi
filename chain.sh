#!/usr/bin/env bash
# chain.sh <runner.sh> <n>  — run a model's benchmark runner N times, sequentially.
# Strips the parent Claude Code session env so each run starts like a plain terminal.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$1"
N="${2:-3}"

for i in $(seq 1 "$N"); do
  echo "=== [$RUNNER] pass $i/$N  $(date +%H:%M:%S) ==="
  env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID \
      -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS \
      -u CLAUDE_CODE_ENABLE_TASKS -u CLAUDE_EFFORT -u CLAUDE_AGENT_SDK_VERSION \
      -u CLAUDE_CODE_EXECPATH -u CLAUDE_CODE_ENABLE_OPUS_4_7_FAST_MODE \
      bash "$HERE/$RUNNER"
  echo "=== [$RUNNER] pass $i/$N finished rc=$? $(date +%H:%M:%S) ==="
done
echo "=== [$RUNNER] ALL DONE $(date +%H:%M:%S) ==="
