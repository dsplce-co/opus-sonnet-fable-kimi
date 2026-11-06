#!/usr/bin/env bash
# grade.sh [run-dir ...]  — run the hidden suites against finished run dirs (default: every runs/*/).
# Copies the hidden tests in, runs vitest, writes hidden.json + own.json, removes them again.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$HERE/setup.sh" || exit 1
DIRS=("$@")
if [ ${#DIRS[@]} -eq 0 ]; then
  DIRS=("$HERE"/runs/*/)
fi

for d in "${DIRS[@]}"; do
  [ -d "$d" ] || continue
  d="$(cd "$d" && pwd)"   # require() below needs an absolute path
  name="$(basename "${d%/}")"
  echo "=== grading $name ==="
  # runs checked out from git carry no node_modules — link the shared install
  [ -e "$d/node_modules" ] || ln -s "$HERE/scaffold/node_modules" "$d/node_modules"
  # only clean up hidden files we copied in ourselves (reference/ ships its own copies)
  had_hidden=0; [ -f "$d/hidden.defects.test.ts" ] && had_hidden=1
  cp "$HERE"/hidden/hidden.defects.test.ts "$HERE"/hidden/hidden.feature.test.ts "$d/"
  ( cd "$d" && npx vitest run hidden.defects.test.ts hidden.feature.test.ts \
      --reporter=json --outputFile=hidden.json >/dev/null 2>hidden.stderr.txt )
  ( cd "$d" && npx vitest run --exclude '**/hidden*' \
      --reporter=json --outputFile=own.json >/dev/null 2>own.stderr.txt )
  [ "$had_hidden" -eq 1 ] || rm -f "$d"/hidden.defects.test.ts "$d"/hidden.feature.test.ts
  if [ -f "$d/hidden.json" ]; then
    node -e '
      const r = require(process.argv[1]);
      const tests = (r.testResults||[]).flatMap(f => (f.assertionResults||[]).map(a => [a.title, a.status]));
      const pass = tests.filter(t => t[1] === "passed").length;
      console.log(`  hidden: ${pass}/${tests.length} passed`);
      tests.filter(t => t[1] !== "passed").forEach(t => console.log(`    FAIL  ${t[0]}`));
    ' "$d/hidden.json" 2>/dev/null || echo "  hidden: SUITE DID NOT RUN (see hidden.stderr.txt)"
  else
    echo "  hidden: SUITE DID NOT RUN (see hidden.stderr.txt)"
  fi
done
