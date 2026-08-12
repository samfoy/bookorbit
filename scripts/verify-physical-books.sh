#!/bin/sh
# Acceptance gate for the physical-book tracking feature.
#
# Runs inside a node:24-alpine container because this checkout's node_modules were
# installed under musl (the rolldown/vitest native bindings are linux-x64-musl, so
# the host's Node 22 glibc runtime cannot load them).
#
# Usage (from the repo root, or from an AutoLoop worktree):
#   sh scripts/verify-physical-books.sh
#
# Set PHYSICAL_GATE_BASELINE=1 to run ONLY the pre-existing-state checks (types build,
# typechecks, full suites) without the feature-specific assertions. That establishes the
# reference numbers before any feature code exists, so a later failure is attributable.
#
# node_modules is gitignored, so a `git worktree` checkout does NOT contain it. When this
# script runs from a worktree it bind-mounts the dependency trees from the main checkout at
# the same relative paths. pnpm links packages with RELATIVE symlinks, so mounting all four
# trees at their normal locations resolves correctly.
#
# Every check is deterministic and fails loudly. No check may be skipped.
set -eu

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

IN_CONTAINER=${PHYSICAL_GATE_IN_CONTAINER:-0}
BASELINE=${PHYSICAL_GATE_BASELINE:-0}

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
    # Mounted READ-WRITE on purpose: vue-tsc writes client/node_modules/.tmp/*.tsbuildinfo
    # and Vite bundles its config through client/node_modules/.vite-temp. Read-only mounts
    # fail with EROFS, and a tmpfs overlay cannot help because the target must already
    # exist inside the parent mount (runc fails the container with exit 125).
    MOUNTS="$MOUNTS -v $MAIN_ROOT/node_modules:$REPO_ROOT/node_modules"
    MOUNTS="$MOUNTS -v $MAIN_ROOT/server/node_modules:$REPO_ROOT/server/node_modules"
    MOUNTS="$MOUNTS -v $MAIN_ROOT/client/node_modules:$REPO_ROOT/client/node_modules"
    MOUNTS="$MOUNTS -v $MAIN_ROOT/packages/types/node_modules:$REPO_ROOT/packages/types/node_modules"
  fi

  DOCKER_RUN="docker run --rm \
    -e PHYSICAL_GATE_IN_CONTAINER=1 \
    -e PHYSICAL_GATE_BASELINE=$BASELINE \
    -u $(id -u):$(id -g) \
    -e HOME=/tmp \
    -e npm_config_cache=/tmp/.npm \
    $MOUNTS \
    -w $REPO_ROOT \
    node:24-alpine sh scripts/verify-physical-books.sh"

  # This user is in the docker group but the login shell predates that change, so docker
  # normally needs `sg docker -c`. IMPORTANT: use the ABSOLUTE path /usr/bin/sg (a symlink
  # to newgrp). A plain `sg` resolves to ~/.local/bin/sg, which is ast-grep, and fails with
  # "unrecognized subcommand 'docker'".
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

# ---------------------------------------------------------------------------
# Baseline checks: these must pass BEFORE and AFTER the feature lands.
# Exit codes are captured directly from each command, never after a pipe to
# tail -- piping reports tail's status and every gate looks falsely green.
# ---------------------------------------------------------------------------

echo "== [1/5] shared types build =="
(cd packages/types && node_modules/.bin/tsc -p tsconfig.json) || fail "packages/types build failed"

echo "== [2/5] server type-check =="
(cd server && node_modules/.bin/tsc --noEmit -p tsconfig.build.json) || fail "server type-check failed"

echo "== [3/5] client type-check (vue-tsc; the exhaustive-Record gate) =="
(cd client && node_modules/.bin/vue-tsc --build) || fail "client type-check failed"

echo "== [4/5] server test suite =="
(cd server && node_modules/.bin/vitest run) || fail "server tests failed"

echo "== [5/5] client test suite =="
(cd client && node_modules/.bin/vitest run) || fail "client tests failed"

if [ "$BASELINE" = "1" ]; then
  echo
  echo "BASELINE PASS: all 5 pre-existing gates green (no feature assertions run)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Feature assertions. Each proves a REQUIREMENT is wired end to end, not merely
# that the code compiles. A build-green-only gate is unfalsifiable.
# ---------------------------------------------------------------------------

echo "== [6/10] schema: medium discriminator + physical copies table =="
grep -q "medium" server/src/db/schema/books.ts \
  || fail "books schema lacks the medium discriminator"
grep -q "books_medium_chk" server/src/db/schema/books.ts \
  || fail "books schema lacks the medium check constraint"
test -f server/src/db/schema/physical.ts \
  || fail "server/src/db/schema/physical.ts is missing"
grep -q "bookPhysicalCopies" server/src/db/schema/index.ts \
  || fail "physical copies table is not re-exported from the schema index"
# A physical-books migration must be ADDITIVE. It must never rewrite reading_progress,
# whose (book_file_id, user_id) primary key is load-bearing for Kobo + Hardcover sync.
# NOTE: match OUR migration by NAME, not by a number glob. The fork gets renumbered on every
# upstream rebase (0064 -> 0066 -> 0070), and a numeric range silently starts matching
# UPSTREAM migrations instead -- upstream's 0067_add_reading_progress_last_read_at legitimately
# adds a column to reading_progress and was failing this check as a false positive.
OUR_MIGRATION=$(ls server/src/db/migrations/*_fork_sources_and_physical_books.sql 2>/dev/null || true)
if [ -n "$OUR_MIGRATION" ]; then
  if grep -q "reading_progress" "$OUR_MIGRATION"; then
    fail "our migration touches reading_progress - that table must not be altered"
  fi
else
  fail "cannot find our *_fork_sources_and_physical_books.sql migration"
fi

echo "== [7/10] 'physical' reading-session source spans every required layer =="
grep -q "physical" packages/types/src/reading-session.ts \
  || fail "READING_SESSION_SOURCES lacks 'physical'"
grep -q "physical" packages/types/src/reading-session-source-bucket.ts \
  || fail "source bucket mapping lacks 'physical'"
grep -q "physical" server/src/db/schema/reader.ts \
  || fail "reading_sessions source check constraint lacks 'physical'"
grep -q "physical" client/src/features/book/components/detail/tabs/ReadingLogTable.vue \
  || fail "ReadingLogTable SESSION_SOURCE_PILLS lacks a physical pill"
grep -q "pill-physical" client/src/assets/theme/tokens.css \
  || fail "tokens.css lacks --pill-physical"
# The token must exist in BOTH light and dark blocks.
[ "$(grep -c 'pill-physical' client/src/assets/theme/tokens.css)" -ge 2 ] \
  || fail "--pill-physical is not defined in both light and dark theme blocks"

echo "== [8/10] ISBN import path (requirement B) =="
test -f server/src/common/utils/isbn.utils.ts \
  || fail "isbn.utils.ts is missing"
test -f server/src/common/utils/isbn.utils.test.ts \
  || fail "isbn.utils has no tests - checksum logic must be tested"
grep -qE "isbn13|toIsbn13|normalizeIsbn" server/src/common/utils/isbn.utils.ts \
  || fail "isbn.utils does not implement ISBN normalization/conversion"
test -d server/src/modules/physical-book \
  || fail "physical-book module is missing"
grep -rq "physical-books" server/src/modules/physical-book/ \
  || fail "physical-book controller does not expose a physical-books route"

echo "== [9/10] page progress emits real sessions (requirement D) =="
grep -rqE "currentPage" server/src/modules/physical-book/ \
  || fail "no currentPage handling in the physical-book module"
# Progress must go through the session repository so user_reading_daily_stats stays in
# sync; a hand-rolled INSERT desyncs daily stats and silently breaks the streak.
grep -rqE "ReadingSession|readingSession" server/src/modules/physical-book/ \
  || fail "page progress does not route through the reading-session layer"

echo "== [10/10] loan urgency + scanner guard (requirements A/C) =="
test -f server/src/modules/physical-book/utils/loan-urgency.utils.ts \
  || fail "loan-urgency.utils.ts is missing"
test -f server/src/modules/physical-book/utils/loan-urgency.utils.test.ts \
  || fail "loan urgency has no tests - the day-boundary math must be tested"
# Urgency day math must use the user's profile timezone, not raw UTC. Server runs
# Etc/UTC; a "due today" book must not flip a day early at 5pm Pacific.
grep -qE "timeZone|timezone|resolveTimeZone" server/src/modules/physical-book/utils/loan-urgency.utils.ts \
  || fail "loan urgency ignores timezone - day math must use the profile timezone"
# THE critical guard: without it every scan marks all physical books missing and
# fires "books unavailable" notifications.
grep -q "medium" server/src/modules/scanner/scanner.repository.ts \
  || fail "scanner repository does not filter on medium - physical books will be marked missing"

echo
echo "GATE PASS: all 10 checks green"
