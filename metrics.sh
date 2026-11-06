#!/usr/bin/env bash
# metrics.sh — per-run "how much did it do" numbers: files added, LOC delta, tests added, report size.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

src_loc() { find "$1" -maxdepth 1 -name '*.ts' ! -name 'hidden*' -exec cat {} + 2>/dev/null | wc -l | tr -d ' '; }
base_loc=$(src_loc "$HERE/scaffold")
base_files=$(find "$HERE/scaffold" -maxdepth 1 -name '*.ts' | wc -l | tr -d ' ')

printf "%-12s %7s %7s %7s %7s %9s %8s\n" run ts_files loc d_loc tests report_w new_files
for d in "$HERE"/runs/*/; do
  [ -f "$d/REPORT.md" ] || continue
  name=$(basename "${d%/}")
  loc=$(src_loc "$d")
  files=$(find "$d" -maxdepth 1 -name '*.ts' | wc -l | tr -d ' ')
  tests=$(grep -rhoE '\b(it|test)\(' "$d"/*.ts 2>/dev/null | wc -l | tr -d ' ')
  words=$(wc -w < "$d/REPORT.md" | tr -d ' ')
  newf=$(cd "$d" && ls *.ts 2>/dev/null | grep -vxF -f <(cd "$HERE/scaffold" && ls *.ts) | tr '\n' ',' )
  printf "%-12s %7s %7s %+7s %7s %9s %8s\n" "$name" "$files" "$loc" "$((loc-base_loc))" "$tests" "$words" "${newf:--}"
done
echo "(scaffold baseline: $base_files files, $base_loc LOC)"
