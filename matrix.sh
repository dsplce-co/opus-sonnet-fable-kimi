#!/usr/bin/env bash
# matrix.sh [N]  — run every model's runner N times (default 3), sequentially.
# Each run is env-stripped via chain.sh so it starts like a plain terminal.
# Reproduce the whole benchmark with:  bash matrix.sh 3
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
N="${1:-3}"
RUNNERS=(run-opus5.sh run-sonnet5.sh run-sonnet46.sh run-sonnet45.sh run-fable.sh run-kimi.sh)
for r in "${RUNNERS[@]}"; do
  echo "########## $r x$N  $(date +%H:%M:%S) ##########"
  bash "$HERE/chain.sh" "$r" "$N"
done
echo "########## MATRIX COMPLETE $(date +%H:%M:%S) ##########"
