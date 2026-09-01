#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

bash scripts/verify-koreader-store-phase2.sh

required=(
  koreader-plugin/spec/bookorbit_store_performance_test.lua
  server/src/modules/koreader/koreader-store-performance.test.ts
)
for file in "${required[@]}"; do
  test -f "$file" || { echo "missing performance regression test: $file" >&2; exit 1; }
done

lua5.1 koreader-plugin/spec/bookorbit_store_performance_test.lua
server/node_modules/.bin/vitest run server/src/modules/koreader/koreader-store-performance.test.ts --maxWorkers=2

git diff --check
printf '%s\n' 'KOReader Store performance gate: PASS'
