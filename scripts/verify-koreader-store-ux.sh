#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

bash scripts/verify-koreader-store-phase2.sh

required=(
  server/src/modules/book-discovery/book-discovery-ranking.test.ts
  koreader-plugin/spec/bookorbit_store_index_test.lua
  koreader-plugin/spec/bookorbit_store_search_test.lua
)
for file in "${required[@]}"; do
  test -f "$file" || { echo "missing Store UX regression: $file" >&2; exit 1; }
done

lua5.1 koreader-plugin/spec/bookorbit_store_index_test.lua
lua5.1 koreader-plugin/spec/bookorbit_store_search_test.lua
server/node_modules/.bin/vitest run \
  server/src/modules/book-discovery/book-discovery-ranking.test.ts \
  server/src/modules/book-discovery/book-discovery.service.test.ts \
  server/src/modules/hardcover/hardcover-catalog.service.test.ts \
  server/src/modules/koreader/koreader-store.service.test.ts \
  --maxWorkers=2

python3 - <<'PY'
from pathlib import Path
root = Path('.')
main = (root / 'koreader-plugin/bookorbit.koplugin/main.lua').read_text()
store = (root / 'koreader-plugin/bookorbit.koplugin/bookorbit_store.lua').read_text()
discovery = (root / 'server/src/modules/book-discovery/book-discovery.service.ts').read_text()
hardcover = (root / 'server/src/modules/hardcover/hardcover-catalog.service.ts').read_text()
driver = (root / 'scripts/koreader-emulator/drive.py').read_text()
assert 'local PLUGIN_VERSION = "1.9.0"' in main
for anchor in ('Search books', 'recent', 'store-index'):
    assert anchor.lower() in (store + driver).lower(), anchor
assert 'rank' in discovery.lower()
assert 'CATALOG_EDITIONS_QUERY' not in hardcover or 'search' not in hardcover.split('CATALOG_EDITIONS_QUERY', 1)[1].split('mapCatalogRows', 1)[0]
for scenario in ('store-index', 'store-search-results', 'store-detail'):
    assert scenario in driver, scenario
PY

for file in koreader-plugin/bookorbit.koplugin/*.lua; do luac5.1 -o /dev/null "$file"; done
server/node_modules/.bin/eslint \
  server/src/modules/book-discovery/book-discovery.service.ts \
  server/src/modules/book-discovery/book-discovery-ranking.test.ts \
  server/src/modules/hardcover/hardcover-catalog.service.ts \
  server/src/modules/hardcover/hardcover-catalog.service.test.ts \
  server/src/modules/koreader/koreader-store.service.ts
server/node_modules/.bin/prettier --check \
  server/src/modules/book-discovery/book-discovery.service.ts \
  server/src/modules/book-discovery/book-discovery-ranking.test.ts \
  server/src/modules/hardcover/hardcover-catalog.service.ts \
  server/src/modules/hardcover/hardcover-catalog.service.test.ts

git diff --check
printf '%s\n' 'KOReader Store UX gate: PASS'
