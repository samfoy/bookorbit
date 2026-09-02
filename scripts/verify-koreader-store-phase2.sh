#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

bash scripts/verify-koreader-store.sh

python3 - <<'PY'
from pathlib import Path
root=Path('.')
required=[
 root/'server/src/modules/koreader/koreader-store-phase2.service.ts',
 root/'koreader-plugin/bookorbit.koplugin/bookorbit_store_queue.lua',
 root/'koreader-plugin/bookorbit.koplugin/bookorbit_store_device.lua',
 root/'koreader-plugin/spec/bookorbit_store_phase2_test.lua',
 root/'server/src/modules/koreader/koreader-store-personalization.service.ts',
 root/'server/src/modules/hardcover/hardcover-tracker.service.ts',
 root/'server/src/modules/storygraph/storygraph-tracker.service.ts',
 root/'koreader-plugin/bookorbit.koplugin/bookorbit_store.lua',
 root/'koreader-plugin/bookorbit.koplugin/main.lua',
]
missing=[str(p) for p in required if not p.is_file()]
if missing: raise SystemExit('missing Phase 2 files: '+', '.join(missing))
texts={p:str(p.read_text()) for p in required}
all_text='\n'.join(texts.values())
anchors=[
 'For You', 'Up Next in Your Series', 'recommendationReason', 'alreadyOwned', 'alreadyRead',
 'Hardcover', 'StoryGraph', 'Get and open', 'Retry another', 'Get all visible',
 'Get unread series', 'free', 'Wi-Fi', 'charging', 'Remove from device',
 'cleanup', 'cancel remaining', 'missing', '1.8.0',
]
for anchor in anchors:
 if anchor.lower() not in all_text.lower(): raise SystemExit('missing Phase 2 acceptance anchor: '+anchor)
main=(root/'koreader-plugin/bookorbit.koplugin/main.lua').read_text()
package=(root/'server/src/modules/koreader/koreader-package.service.ts').read_text()
assert 'local PLUGIN_VERSION = "1.8.0"' in main
assert 'catalogStorePhase2' in package
PY

for file in koreader-plugin/bookorbit.koplugin/*.lua; do luac5.1 -o /dev/null "$file"; done
for spec in koreader-plugin/spec/*_test.lua; do lua5.1 "$spec"; done

pnpm --filter @bookorbit/types build
NODE_OPTIONS=--max-old-space-size=3072 server/node_modules/.bin/tsc --noEmit -p server/tsconfig.build.json
server/node_modules/.bin/vitest run \
  server/src/modules/book-discovery \
  server/src/modules/hardcover \
  server/src/modules/storygraph \
  server/src/modules/koreader/koreader-store*.test.ts \
  server/src/modules/koreader/koreader-catalog.controller.test.ts \
  server/src/modules/koreader/koreader-plugin-source.test.ts \
  server/src/modules/koreader/koreader-package.service.test.ts \
  --maxWorkers=2
server/node_modules/.bin/eslint \
  server/src/modules/book-discovery \
  server/src/modules/hardcover \
  server/src/modules/storygraph \
  server/src/modules/koreader/koreader-store*.ts \
  server/src/modules/koreader/koreader-catalog.controller.ts \
  server/src/modules/koreader/koreader-package.service.ts

git diff --check
