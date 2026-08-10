# Task: add drill-down detail to the BookOrbit Daily Reading page

## Objective

The Daily Reading page (`/daily-reading`) currently shows aggregate-only data: 4 summary
cards, one stacked bar per day, and a flat "Time by book" list. There is no way to answer
"what actually happened on that day?" — which sessions ran, when, on which device, for how
long, and how much progress they moved.

Add drill-down detail: clicking a day on the chart opens a per-day panel listing that day's
individual reading sessions with time, duration, book, source device, and progress delta,
plus richer per-day and per-book context.

This is an ADDITIVE feature on an existing, working page. Do not redesign the page, do not
rewrite the existing chart, and do not change the existing `daily-reading-by-book` endpoint's
response shape (other consumers and its tests depend on it).

## Repository facts (VERIFIED — trust these over your own assumptions)

- Repo: `/home/sam/workspace/bookorbit-fork` — a fork of BookOrbit (AGPL-3.0).
- pnpm monorepo: `server/` (NestJS 11 + Fastify), `client/` (Vue 3), `packages/types/` (shared).
- Branch: `BO-daily-reading-drilldown`. Base has two commits already made for you:
  a stale-test fix and the acceptance gate. Preserve both.
- **Read `AGENTS.md` at the repo root and follow it exactly.** Non-negotiable highlights:
  - Vue 3 `<script setup lang="ts">` only, Composition API only.
  - **All template event handlers must be bare method references** (`@click="handleFoo"`).
    No inline calls, no inline arrows. ESLint `vue/v-on-handler-style` blocks commits.
  - Tailwind v4 utility classes only; theme tokens as CSS variables. Never hardcode colors.
  - Icons from `lucide-vue-next` only. HTTP via native `fetch` only.
  - Shared types live in `packages/types/` and are imported via `@bookorbit/types`.
  - Server logs use `[event] [phase] key=value - message` with phases `[start]/[end]/[fail]`.
  - Every feature is user-scoped: filter by `userId`, inject `@CurrentUser()`, pass it down.
  - DTOs use `class-validator`. `ValidationPipe` is global with `forbidNonWhitelisted: true`.
  - **NEVER add a `Co-authored-by` trailer to any commit.** Hard rule.
  - Conventional commit format. Branch is already correct; commit onto it.

### Existing code you will extend (all paths confirmed to exist)

| Path | Role |
|---|---|
| `client/src/features/statistics/components/DailyReadingPage.vue` | the page (359 lines) |
| `client/src/features/statistics/composables/useUserDailyReadingByBook.ts` | existing fetch composable; copy its request-id race pattern |
| `client/src/features/statistics/api/statistics.api.ts` | api client; `fetchUserDailyReadingByBook` is at ~line 142 |
| `client/src/features/statistics/components/ChartEmptyState.vue` | empty-state component to reuse |
| `client/src/features/statistics/lib/source-bucket-colors.ts` | `resolveSourceBucketColors(themeKey)` → per-bucket hex |
| `server/src/modules/user-statistics/user-statistics.controller.ts` | routes |
| `server/src/modules/user-statistics/user-statistics.service.ts` | caching + timezone resolution |
| `server/src/modules/user-statistics/user-statistics.repository.ts` | Drizzle queries |
| `packages/types/src/user-statistics.ts` | shared stat types |
| `server/src/common/utils/timezone.utils.ts` | `resolveTimeZone(value, fallback)` |

Source-bucket helpers in `packages/types/src/reading-session-source-bucket.ts`:
`READING_SESSION_SOURCE_BUCKETS`, `READING_SESSION_SOURCE_BUCKET_LABELS`,
`toReadingSessionSourceBucket(source)`, `emptySourceBucketRecord()`. Buckets are
`bookorbit | koreader | kobo | crosspoint | audiobookshelf`. **These Records are
exhaustive — TS fails if you add a bucket and miss one. Do not add new buckets.**

### Data model (`reading_sessions`, in `server/src/db/schema/reader.ts`)

Columns available: `id`, `userId`, `bookId`, `bookFileId` (nullable — manual sessions are
book-level), `attemptId`, `sessionId`, `source` (nullable enum: web/koreader/manual/kobo/
crosspoint/audiobookshelf), `startedAt`, `endedAt`, `durationSeconds`, `progressDelta`
(nullable real), `endProgress` (nullable real 0–100).

Live data available for manual verification (user 1): 341 sessions, 5 sources
(audiobookshelf 175, koreader 110, crosspoint 34, manual 21, web 1), spanning
2026-07-12 → 2026-08-10, all with non-null `progressDelta`.

Book title comes from `bookMetadata.title` via `leftJoin`. File format comes from
`bookFiles.format` via `leftJoin` on `bookFileId`. Library scoping goes through
`innerJoin(books)` plus the repository's existing `libraryFilter(...)` helper.

## ⚠️ Three pitfalls this exact page already hit in production — do not regress them

1. **Postgres 42803 with parameterized `AT TIME ZONE` in `GROUP BY`.** A parameterized
   timezone binds as a DIFFERENT placeholder in `SELECT` vs `GROUP BY`, so Postgres refuses
   to match the expressions and errors with "must appear in the GROUP BY clause". This took
   the endpoint down with a live 500. **Fix pattern, already used twice in this repo — copy
   it:** alias the converted expression inside a subquery (`dayExpr.as('day')` +
   `.as('session_days')`) and have the OUTER query group by the alias. See
   `getDailyReadingSecondsByBook` and `getPeakReadingHours` in the repository.
   Ungrouped queries may inline the conversion safely.
2. **Day bucketing must use the USER'S PROFILE TIMEZONE, not UTC.** The server runs
   `Etc/UTC`; the user is `America/Los_Angeles`. Reading raw `started_at` plots 8pm PT
   reading onto the next day. Resolve with
   `resolveTimeZone((user.settings as { timezone?: unknown } | undefined)?.timezone, 'UTC')`
   and thread `timeZone` through service → repo. **Also add `timeZone` to the
   `buildUserCacheKey` payload**, or a timezone change serves stale buckets.
3. **vue-echarts zero-height.** `<VChart class="h-[380px]">` renders at ZERO height because
   the component's base CSS layer beats the Tailwind arbitrary-height class — the chart goes
   blank while tooltips still exist in the DOM. Always wrap in a sized div and give VChart
   `style="height: 100%"`. The existing page does this correctly; keep it.

## Required work

### 1. Backend: a new day-scoped detail endpoint

Add `GET /api/v1/user-statistics/daily-reading-detail?day=YYYY-MM-DD`.

- New DTO (e.g. `dto/user-daily-reading-detail-query.dto.ts`) extending the existing
  filter DTO, with a required `day` string validated as `YYYY-MM-DD` (`@Matches` or
  `@IsISO8601`-style). Reject malformed input with a 400 via the global ValidationPipe.
- Repository method `getDailyReadingDetail(userId, isSuperuser, filterLibraryIds, day, timeZone)`
  returning that day's individual sessions. Select at minimum: session id, book id, book
  title, book format, source, startedAt, endedAt, durationSeconds, progressDelta, endProgress.
  - Resolve the day window **in the user's timezone** (the day the user perceives), not UTC.
  - User-scoped and library-scoped like every sibling query. Reuse `getAccessibleLibraryIds`,
    `intersectLibraryIds`, `libraryFilter`.
  - **Bound the result** with an explicit `.limit(...)` — per AGENTS.md scale rules, no
    unbounded queries. A day cannot realistically exceed a few hundred sessions; pick a
    sane cap (e.g. 500) and order by `startedAt`.
- Service method `getDailyReadingDetail(user, query)` that resolves the timezone, caches via
  `this.cache.get` with the existing `buildUserCacheKey` pattern (include `day` AND
  `timeZone` in the key), and maps rows into the shared type. Round `progressDelta` using the
  existing `roundProgressDelta` helper for consistency with sibling endpoints.
- Controller route wired with `@CurrentUser()` + `@Query()`.
- Shared type **named exactly `UserDailyReadingDetail`** in `packages/types/src/user-statistics.ts`
  (the gate greps for this name), plus a per-session item type. Include the day, a total, and
  the session list. Add a `bySource` breakdown for the day if useful — if you do, build it
  with `emptySourceBucketRecord()` + `toReadingSessionSourceBucket()` so it stays exhaustive.

### 2. Frontend: day drill-down panel + richer detail

- `client/src/features/statistics/api/statistics.api.ts`: add **`fetchUserDailyReadingDetail`**
  (exact name — the gate greps it), following the existing fetch/throw-on-!ok style.
- New composable for the detail fetch, mirroring `useUserDailyReadingByBook`'s
  `latestRequestId` race guard so out-of-order responses cannot clobber newer state.
- **New component `client/src/features/statistics/components/DailyReadingDayDetail.vue`**
  (exact path — the gate checks it exists). It renders the selected day's detail:
  - a session list: start time (in the user's local time), duration, book title, source
    badge, progress delta, and format when meaningful;
  - per-day totals and a source breakdown;
  - loading skeletons, an error state, and an empty state (reuse `ChartEmptyState`);
  - source colors from `resolveSourceBucketColors`, labels from
    `READING_SESSION_SOURCE_BUCKET_LABELS`. Never hardcode a color.
  - Book rows should click through to `{ name: 'book-detail', params: { bookId } }`,
    matching how the existing "Time by book" list already links.
- `DailyReadingPage.vue`: make the chart **clickable to select a day** and render
  `DailyReadingDayDetail` for the selection. Requirements:
  - Wire ECharts' click event to a **named handler** (bare method reference in template).
  - Make the selected day visually obvious, and allow clearing the selection.
  - Keyboard/mobile reachability matters — the day must be selectable without a precise
    mouse hover only. Responsive design is required (desktop + mobile).
  - Keep `confine: true` on the tooltip and the `style="height: 100%"` on VChart.
- Also deepen the existing aggregate detail where it is cheap and honest to do so, e.g.
  per-book session counts / average session length in the "Time by book" list (the existing
  endpoint already returns `sessionsCount`), and a "busiest day" summary card (`summary`
  already computes `busiestDay` but the UI never displays it).
- **All new i18n strings go in `client/src/locales/en.json`.** No hardcoded user-facing
  English in components. Keys must live under the existing `statistics.dailyReading` group.
  No em dashes and no HTML in locale messages (the repo validator forbids both).

### 3. Tests

- Server: extend `user-statistics.repository.test.ts`, `user-statistics.service.test.ts`,
  and `user-statistics.controller.test.ts` for the new method. Follow the existing
  `makeDb([...])` pattern — **note it shifts ONE queue entry per `select()` call, so a
  subquery consumes an extra entry**; add a `[]` placeholder accordingly. Assert the
  compiled SQL contains `AT TIME ZONE` and that the timezone is threaded through, mirroring
  how sibling tests assert query shape.
- Client: add a test for the new api client function (there is an existing
  `statistics.api.test.ts` with 67 tests — extend it) and a component test for
  `DailyReadingDayDetail.vue` covering loading, empty, populated, and error states.
- Do not weaken or delete existing assertions to make things pass.

## Acceptance criteria — the definition of done

Run the committed gate from the repo root and it must print `GATE PASS`:

```
sh scripts/verify-daily-reading-drilldown.sh
```

It runs, in order: shared-types build, server type-check, server user-statistics tests,
client `vue-tsc --build`, client statistics tests, the en.json key check, and grep probes
proving the endpoint and the day-detail UI are wired (not merely compiling).

**It executes inside a `node:24-alpine` container** because this checkout's `node_modules`
carry `linux-x64-musl` native bindings that the host's glibc Node 22 cannot load. Do not
try to run vitest/vue-tsc directly on the host — it fails with `MODULE_NOT_FOUND` on the
rolldown binding. Do not "fix" this by reinstalling dependencies.

The gate was verified against this base: checks 1–5 pass, and 6–8 fail only because the
feature does not exist yet. It is falsifiable, so do not modify it to make it pass. If you
believe a check is genuinely wrong, say so explicitly in your final report rather than
quietly weakening it.

Also required, beyond the gate:

- `git status` clean at the end (no stray files, no `.autoloop` noise committed).
- Focused conventional commits on `BO-daily-reading-drilldown`, no `Co-authored-by`.
- The two pre-existing commits on this branch preserved.

## Explicitly out of scope

- No DB migration. Everything needed is already in `reading_sessions`.
- No new source enum values, no new buckets.
- No changes to the deployed server, no Docker image build, no Caddy config.
- No translating the 15 non-English locale catalogs.
- Do not change the existing `daily-reading-by-book` response shape.
- Do not add a new service, cache layer, or second endpoint beyond the one described.

## Reporting

State plainly what you verified by execution versus what remains unverified. In particular:
the gate proves types, tests, and wiring, but it does **not** prove the page renders
correctly in a real browser against live data — that check requires the deployed stack and
is not part of this task. Say so rather than implying visual confirmation.
