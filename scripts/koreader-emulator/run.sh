#!/usr/bin/env bash
set -euo pipefail

VERSION=v2026.07.1
SHA256=299aadb28147a25e9432ced1214ea444a4184393b5ae97cf42402c8a61b1a1b0
URL="https://github.com/koreader/koreader/releases/download/${VERSION}/koreader-linux-x86_64-${VERSION}.tar.xz"
IMAGE=bookorbit-koreader-emulator:${VERSION}

if [[ ${1:-} != --inside-container ]]; then
  ROOT=$(cd "$(dirname "$0")/../.." && pwd)
  CACHE=${KOREADER_EMULATOR_CACHE:-$HOME/.cache/bookorbit-koreader-emulator/$VERSION}
  OUTPUT=${KOREADER_EMULATOR_OUTPUT:-$ROOT/.hermes/koreader-emulator}
  PROFILE=${KOREADER_EMULATOR_PROFILE:-$OUTPUT/profile}
  ARCHIVE="$CACHE/koreader-linux-x86_64-${VERSION}.tar.xz"
  WIDTH=${KOREADER_EMULATOR_WIDTH:-758}
  HEIGHT=${KOREADER_EMULATOR_HEIGHT:-1024}
  DPI=${KOREADER_EMULATOR_DPI:-300}
  SCENARIO=${KOREADER_EMULATOR_SCENARIO:-idle}
  USE_MOCK=${KOREADER_EMULATOR_USE_MOCK:-0}

  mkdir -p "$CACHE" "$OUTPUT" "$PROFILE"
  if [[ ! -s $ARCHIVE ]]; then
    curl -fL --retry 3 -o "$ARCHIVE" "$URL"
  fi
  actual=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
  [[ $actual == "$SHA256" ]] || { echo "KOReader archive checksum mismatch" >&2; exit 1; }
  if [[ ! -x $CACHE/lib/koreader/koreader.sh ]]; then
    tar -xJf "$ARCHIVE" -C "$CACHE"
  fi

  /usr/bin/sg docker -c "docker build -q -t '$IMAGE' -f '$ROOT/scripts/koreader-emulator/Dockerfile' '$ROOT'" >/dev/null
  MOCK_PID=
  if [[ $USE_MOCK == 1 ]]; then
    python3 "$ROOT/scripts/koreader-emulator/mock_server.py" >"$OUTPUT/mock-server.log" 2>&1 &
    MOCK_PID=$!
    export BOOKORBIT_SERVER_URL=http://host.docker.internal:18080/api/v1
    export BOOKORBIT_USERNAME=emulator
    export BOOKORBIT_USERKEY=emulator-key
    sleep 0.3
  fi
  cleanup_host() {
    if [[ -n $MOCK_PID ]]; then kill "$MOCK_PID" 2>/dev/null || true; fi
  }
  trap cleanup_host EXIT
  /usr/bin/sg docker -c "docker run --rm \
    --user '$(id -u):$(id -g)' \
    --add-host host.docker.internal:host-gateway \
    -e HOME=/tmp/home \
    -e BOOKORBIT_SERVER_URL \
    -e BOOKORBIT_USERNAME \
    -e BOOKORBIT_USERKEY \
    -e KOREADER_EMULATOR_WIDTH='$WIDTH' \
    -e KOREADER_EMULATOR_HEIGHT='$HEIGHT' \
    -e KOREADER_EMULATOR_DPI='$DPI' \
    -e KOREADER_EMULATOR_SCENARIO='$SCENARIO' \
    -v '$ROOT:/workspace:ro' \
    -v '$CACHE:/opt/koreader:ro' \
    -v '$PROFILE:/profile' \
    -v '$OUTPUT:/output' \
    '$IMAGE'"
  exit $?
fi

shift
: "${BOOKORBIT_SERVER_URL:?BOOKORBIT_SERVER_URL is required}"
: "${BOOKORBIT_USERNAME:?BOOKORBIT_USERNAME is required}"
: "${BOOKORBIT_USERKEY:?BOOKORBIT_USERKEY is required}"

WIDTH=${KOREADER_EMULATOR_WIDTH:-758}
HEIGHT=${KOREADER_EMULATOR_HEIGHT:-1024}
DPI=${KOREADER_EMULATOR_DPI:-300}
SCENARIO=${KOREADER_EMULATOR_SCENARIO:-idle}
PLUGIN_DST=/profile/plugins/bookorbit.koplugin
mkdir -p /tmp/home /profile/plugins /profile/patches /output
rm -rf "$PLUGIN_DST"
cp -a /workspace/koreader-plugin/bookorbit.koplugin "$PLUGIN_DST"

python3 - <<'PY'
import json, os
from pathlib import Path

def lua(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)

patch = f'''-- Generated only inside the isolated KOReader emulator profile.
local settings = G_reader_settings:readSetting("bookorbit", {{}})
settings.settings_version = 2
settings.server_url = {lua(os.environ["BOOKORBIT_SERVER_URL"])}
settings.username = {lua(os.environ["BOOKORBIT_USERNAME"])}
settings.userkey = {lua(os.environ["BOOKORBIT_USERKEY"])}
settings.catalog_auto_open = "always"
settings.skip_sync_when_offline = false
G_reader_settings:saveSetting("bookorbit", settings)
'''
Path('/profile/patches/2-bookorbit-emulator.lua').write_text(patch)
PY

export DISPLAY=:99
export KO_HOME=/profile
export EMULATE_READER_W=$WIDTH
export EMULATE_READER_H=$HEIGHT
export EMULATE_READER_DPI=$DPI
export EMULATE_READER_FLASH=100
Xvfb "$DISPLAY" -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp >/output/xvfb.log 2>&1 &
XVFB_PID=$!
cleanup() {
  if [[ -n ${KOREADER_PID:-} ]]; then kill "$KOREADER_PID" 2>/dev/null || true; fi
  kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT

/opt/koreader/lib/koreader/koreader.sh >/output/koreader.log 2>&1 &
KOREADER_PID=$!

ready=0
for _ in $(seq 1 80); do
  if xdotool search --name 'KOReader' >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$KOREADER_PID" 2>/dev/null; then break; fi
  sleep 0.25
done
[[ $ready == 1 ]] || { echo "KOReader emulator window did not start" >&2; tail -80 /output/koreader.log >&2; exit 1; }

python3 /workspace/scripts/koreader-emulator/drive.py "$SCENARIO" --wait 5
sleep 2
import -window root /output/koreader-${WIDTH}x${HEIGHT}-${SCENARIO}.png
identify /output/koreader-${WIDTH}x${HEIGHT}-${SCENARIO}.png
printf 'screenshot=/output/koreader-%sx%s-%s.png\n' "$WIDTH" "$HEIGHT" "$SCENARIO"
