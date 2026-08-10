#!/bin/sh
# Acceptance gate for the Daily Reading drill-down feature.
#
# Runs inside a node:24-alpine container because this checkout's node_modules were
# installed under musl (the rolldown/vitest native bindings are linux-x64-musl, so
# the host's Node 22 glibc runtime cannot load them).
#
# Usage (from the repo root, or from an AutoLoop worktree):
#   sh scripts/verify-daily-reading-drilldown.sh
#
# node_modules is gitignored, so a `git worktree` checkout does NOT contain it. When
# this script runs from a worktree it bind-mounts the dependency trees from the main
# checkout at the same relative paths. pnpm links packages with RELATIVE symlinks
# (e.g. server/node_modules/@nestjs/common -> ../../../node_modules/.pnpm/...), so
# mounting all four trees at their normal locations resolves correctly.
#
# Every check is deterministic and fails loudly. No check may be skipped.
set -eu

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

IN_CONTAINER=${DRILLDOWN_GATE_IN_CONTAINER:-0}

if [ "$IN_CONTAINER" != "1" ]; then
  # Resolve the main checkout: for a worktree, --git-common-dir points at the primary
  # .git directory, whose parent holds the installed node_modules.
  GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null || echo "")
  if [ -n "$GIT_COMMON" ]; then
    MAIN_ROOT=$(cd "$(dirname "$GIT_COMMON")" && pwd)
  else
    MAIN_ROOT="$REPO_ROOT"
  fi

  if [ ! -d "$MAIN_ROOT/node_modules" ]; then
    echo "GATE FAIL: no node_modules found in $MAIN_ROOT - install dependencies first" >&2
    exit 1
  fi

  MOUNTS="-v $REPO_ROOT:$REPO_ROOT"
  if [ "$MAIN_ROOT" != "$REPO_ROOT" ]; then
    echo "(running from a worktree; mounting node_modules from $MAIN_ROOT)"
    # Mounted READ-WRITE on purpose. The toolchain writes several scratch paths inside
    # node_modules -- vue-tsc puts .tsbuildinfo in client/node_modules/.tmp, and Vite
    # bundles the config through client/node_modules/.vite-temp before loading it.
    # Read-only mounts fail these with EROFS, and tmpfs overlays cannot help because a
    # tmpfs target must already exist inside the parent mount (runc cannot mkdir a new
    # mountpoint under a read-only rootfs, which fails the container with exit 125).
    # Only build caches are written, never package contents.
    MOUNTS="$MOUNTS -v $MAIN_ROOT/node_modules:$REPO_ROOT/node_modules"
    MOUNTS="$MOUNTS -v $MAIN_ROOT/server/node_modules:$REPO_ROOT/server/node_modules"
    MOUNTS="$MOUNTS -v $MAIN_ROOT/client/node_modules:$REPO_ROOT/client/node_modules"
    MOUNTS="$MOUNTS -v $MAIN_ROOT/packages/types/node_modules:$REPO_ROOT/packages/types/node_modules"
  fi

  DOCKER_RUN="docker run --rm \
    -e DRILLDOWN_GATE_IN_CONTAINER=1 \
    -u $(id -u):$(id -g) \
    -e HOME=/tmp \
    -e npm_config_cache=/tmp/.npm \
    $MOUNTS \
    -w $REPO_ROOT \
    node:24-alpine sh scripts/verify-daily-reading-drilldown.sh"

  # Re-exec inside the container with the repo bind-mounted at the same path.
  #
  # This user is in the docker group but the login shell predates that change, so
  # docker normally needs `sg docker -c`. IMPORTANT: use the ABSOLUTE path
  # /usr/bin/sg (a symlink to newgrp). A plain `sg` resolves to ~/.local/bin/sg,
  # which is ast-grep, and fails with "unrecognized subcommand 'docker'".
  if docker info >/dev/null 2>&1; then
    exec sh -c "$DOCKER_RUN"
  elif [ -x /usr/bin/sg ]; then
    exec /usr/bin/sg docker -c "$DOCKER_RUN"
  else
    echo "GATE FAIL: cannot access docker (no direct access and /usr/bin/sg missing)" >&2
    exit 1
  fi
fi

fail() {
  echo "GATE FAIL: $1" >&2
  exit 1
}

echo "== [1/8] shared types build =="
# tsc writes packages/types/dist, which must be writable even when node_modules is
# mounted read-only. dist is part of the checkout, so it is writable.
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
