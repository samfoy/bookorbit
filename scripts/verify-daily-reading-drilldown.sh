#!/bin/sh
# Acceptance gate for the Daily Reading drill-down feature.
#
# Runs inside a node:24-alpine container because this checkout's node_modules were
# installed under musl (the rolldown/vitest native bindings are linux-x64-musl, so
# the host's Node 22 glibc runtime cannot load them).
#
# Usage (from the repo root):
#   sh scripts/verify-daily-reading-drilldown.sh
#
# Every check is deterministic and fails loudly. No check may be skipped.
set -eu

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

IN_CONTAINER=${DRILLDOWN_GATE_IN_CONTAINER:-0}

if [ "$IN_CONTAINER" != "1" ]; then
  # Re-exec inside the container with the repo bind-mounted at the same path.
  exec sg docker -c "docker run --rm \
    -e DRILLDOWN_GATE_IN_CONTAINER=1 \
    -v $REPO_ROOT:$REPO_ROOT \
    -w $REPO_ROOT \
    node:24-alpine sh scripts/verify-daily-reading-drilldown.sh"
fi

fail() {
  echo "GATE FAIL: $1" >&2
  exit 1
}

echo "== [1/8] shared types build =="
(cd packages/types && node_modules/.bin/tsc -p tsconfig.json) || fail "packages/types build failed"

echo "== [2/8] server type-check =="
(cd server && node_modules/.bin/tsc --noEmit -p tsconfig.build.json) || fail "server type-check failed"

echo "== [3/8] server user-statistics tests =="
(cd server && node_modules/.bin/vitest run src/modules/user-statistics) || fail "server user-statistics tests failed"

echo "== [4/8] client type-check (vue-tsc) =="
(cd client && node_modules/.bin/vue-tsc --build) || fail "client type-check failed"

echo "== [5/8] client daily-reading component tests =="
(cd client && node_modules/.bin/vitest run --dir src/features/statistics) || fail "client statistics tests failed"

echo "== [6/8] every t() key used by the Daily Reading UI exists in en.json =="
# NOTE: the repo's own client/scripts/validate-locales.mjs is deliberately NOT used here.
# It requires all 16 catalogs to carry every key, and the pre-existing fork feature
# (commit 42e48f15, "add daily reading page") shipped English-only keys, so that
# validator already fails on this branch's base for ~21 keys across 15 languages.
# Machine-translating those is out of scope for this task, so the gate enforces the
# constraint that actually matters for new code: en.json is the source of truth and
# must define every key the Daily Reading components reference.
node scripts/check-daily-reading-locale-keys.mjs || fail "en.json is missing a referenced Daily Reading key"

echo "== [7/8] backend drill-down endpoint is wired =="
grep -q "daily-reading-detail" server/src/modules/user-statistics/user-statistics.controller.ts \
  || fail "controller does not expose the daily-reading-detail route"
grep -q "getDailyReadingDetail" server/src/modules/user-statistics/user-statistics.service.ts \
  || fail "service does not implement getDailyReadingDetail"
grep -q "getDailyReadingDetail" server/src/modules/user-statistics/user-statistics.repository.ts \
  || fail "repository does not implement getDailyReadingDetail"
grep -q "UserDailyReadingDetail" packages/types/src/user-statistics.ts \
  || fail "shared types do not define UserDailyReadingDetail"
# Timezone correctness: any grouped day/hour expression must convert, not read raw UTC.
grep -q "AT TIME ZONE" server/src/modules/user-statistics/user-statistics.repository.ts \
  || fail "repository lost its AT TIME ZONE conversion"

echo "== [8/8] client drill-down UI is reachable =="
grep -q "fetchUserDailyReadingDetail" client/src/features/statistics/api/statistics.api.ts \
  || fail "client api client lacks fetchUserDailyReadingDetail"
test -f client/src/features/statistics/components/DailyReadingDayDetail.vue \
  || fail "DailyReadingDayDetail.vue is missing"
grep -q "DailyReadingDayDetail" client/src/features/statistics/components/DailyReadingPage.vue \
  || fail "DailyReadingPage does not render the day detail panel"
# The day drill-down must be user-reachable from the chart, not dead code.
grep -qE "click|selectDay|handleDay" client/src/features/statistics/components/DailyReadingPage.vue \
  || fail "no day selection handler on the Daily Reading page"
# Regression guards for the two pitfalls this page already hit.
grep -q 'style="height: 100%' client/src/features/statistics/components/DailyReadingPage.vue \
  || fail "VChart lost its explicit height style (vue-echarts zero-height pitfall)"
grep -q "confine: true" client/src/features/statistics/components/DailyReadingPage.vue \
  || fail "chart tooltip lost confine:true (offscreen tooltip pitfall)"

echo
echo "GATE PASS: all 8 checks green"
