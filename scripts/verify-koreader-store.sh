#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

python3 - <<'PY'
from pathlib import Path
root = Path('.')
required = [
    root / 'koreader-plugin/bookorbit.koplugin/bookorbit_store.lua',
    root / 'server/src/modules/koreader/koreader-store.service.ts',
    root / 'server/src/modules/koreader/dto/koreader-store.dto.ts',
]
missing = [str(path) for path in required if not path.is_file()]
if missing:
    raise SystemExit('missing native store files: ' + ', '.join(missing))
controller = (root / 'server/src/modules/koreader/koreader-catalog.controller.ts').read_text()
package = (root / 'server/src/modules/koreader/koreader-package.service.ts').read_text()
main = (root / 'koreader-plugin/bookorbit.koplugin/main.lua').read_text()
api = (root / 'koreader-plugin/bookorbit.koplugin/bookorbit_api.lua').read_text()
for needle, text in [
    ('store/home', controller),
    ('store/search', controller),
    ('store/acquisitions', controller),
    ('catalogStore', package),
    ('local PLUGIN_VERSION = "1.6.0"', main),
    ('catalogStoreHome', api),
    ('catalogStoreSearch', api),
    ('catalogStoreStartAcquisition', api),
]:
    if needle not in text:
        raise SystemExit(f'missing acceptance anchor: {needle}')
PY

pnpm --filter @bookorbit/types build
NODE_OPTIONS=--max-old-space-size=3072 server/node_modules/.bin/tsc --noEmit -p server/tsconfig.build.json
(
  cd server
  ./node_modules/.bin/vitest run \
    src/modules/book-discovery \
    src/modules/hardcover/hardcover-catalog.service.test.ts \
    src/modules/hardcover/hardcover-catalog-browse.service.test.ts \
    src/modules/hardcover/hardcover-read-books.service.test.ts \
    src/modules/storygraph/storygraph-catalog.service.test.ts \
    src/modules/koreader/koreader-catalog.controller.test.ts \
    src/modules/koreader/koreader-catalog.service.test.ts \
    src/modules/koreader/koreader-plugin-source.test.ts \
    src/modules/koreader/koreader-package.service.test.ts \
    --maxWorkers=2
)

server/node_modules/.bin/eslint \
  server/src/modules/book-discovery \
  server/src/modules/koreader \
  server/src/modules/hardcover/hardcover-catalog.service.ts \
  server/src/modules/hardcover/hardcover-catalog-browse.service.ts \
  server/src/modules/storygraph/storygraph-catalog.service.ts

for file in koreader-plugin/bookorbit.koplugin/*.lua; do
  luac5.1 -o /dev/null "$file"
done

for spec in koreader-plugin/spec/*_test.lua; do
  lua5.1 "$spec"
done

git diff --check
