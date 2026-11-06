#!/usr/bin/env bash
# setup.sh — install the test toolchain into scaffold/node_modules (once).
# Every run dir and the reference get a symlink to it, so many runs don't each duplicate the install.
# scaffold/package.json is left untouched on purpose: it is part of what the models are handed.
# vitest 4.1.10 is the version the published runs used (see "RUN v4.1.10" in runs/*/REPORT.md).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -x "$HERE/scaffold/node_modules/.bin/vitest" ]; then
  exit 0
fi
echo "[setup] installing vitest + typescript into scaffold/node_modules ..."
( cd "$HERE/scaffold" && npm install --no-save --no-package-lock --no-audit --no-fund \
    vitest@4.1.10 typescript@7.0.2 )
