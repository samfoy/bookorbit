#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

required=(
  scripts/koreader-emulator/Dockerfile
  scripts/koreader-emulator/README.md
  scripts/koreader-emulator/run.sh
  scripts/koreader-emulator/drive.py
  scripts/koreader-emulator/mock_server.py
  scripts/koreader-emulator/mock_server_test.py
)
for file in "${required[@]}"; do
  test -f "$file" || { echo "missing emulator harness file: $file" >&2; exit 1; }
done

bash -n scripts/koreader-emulator/run.sh
python3 -m py_compile scripts/koreader-emulator/drive.py
python3 -m py_compile scripts/koreader-emulator/mock_server.py
python3 scripts/koreader-emulator/mock_server_test.py
grep -q 'EMULATE_READER_W' scripts/koreader-emulator/run.sh
grep -q 'Xvfb' scripts/koreader-emulator/run.sh
grep -q 'bookorbit.koplugin' scripts/koreader-emulator/run.sh
grep -q 'import -window root' scripts/koreader-emulator/run.sh
