# Task: physical book tracking for BookOrbit (owned + borrowed, ISBN import, page progress)

## Objective

BookOrbit tracks ebooks and audiobooks, both of which are backed by a file on disk. Sam also
reads **physical books** — ones he owns, and ones he borrows from a library or a person. Those
are currently invisible to the app: there is no way to shelve them, no way to log progress, and
no way to know a library loan is due before it is overdue.

Add physical book tracking:

1. **Owned physical books** — shelve a real-world copy with no file on disk.
2. **Import by barcode / ISBN** — scan or type an ISBN and get a fully populated book.
3. **Loaned / library books** — track lender, due date, and renewals, with interface
   encouragement to finish in time (pace-aware, not just a deadline).
4. **Page-based progress** — log "I'm on page 143" and have it flow into the existing
   streak / Daily Reading / statistics stack.

This is an **ADDITIVE** feature. Do not redesign the library, the reader, the scanner, or the
statistics pages. Do not change existing endpoint response shapes — other consumers and their
tests depend on them.

## ⚠️ The single most important architectural rule

**Physical books are fileless `books` rows, not a parallel entity.**

A separate `physical_books` table was explicitly rejected during design: every downstream
feature (search, smart scopes, collections, series, statistics, dashboard, Hardcover/StoryGraph
sync) keys off `books.id`, so a parallel entity would fork all of them. Instead, `books` gets a
`medium` discriminator column, and physical books reuse the entire existing stack.

Exactly **one** new table is authorized: `book_physical_copies`. Do not add a second. Do not add
a new service, transport, cache, or sidecar. If you believe you need one, stop and record it as
a blocker instead of building it.

## Repository facts (VERIFIED against the code — trust these over your own assumptions)

- Repo: `/home/sam/workspace/bookorbit-fork` — fork of BookOrbit (AGPL-3.0).
- pnpm monorepo: `server/` (NestJS 11 + Fastify), `client/` (Vue 3), `packages/types/` (shared).
- Branch: **`BO-physical-books`**. Base has one commit made for you: the acceptance gate
  (`scripts/verify-physical-books.sh`) and this brief. Preserve both.
- **Read `AGENTS.md` at the repo root and follow it exactly.** Non-negotiable highlights:
  - Vue 3 `<script setup lang="ts">` only, Composition API only.
  - **All template event handlers must be bare method references** (`@click="handleSave"`).
    No inline calls, no inline arrows. ESLint `vue/v-on-handler-style` blocks commits.
  - Tailwind v4 utility classes only; theme tokens as CSS variables. Never hardcode colors.
  - Icons from `lucide-vue-next` only. HTTP via native `fetch` only.
  - Shared types live in `packages/types/` and are imported via `@bookorbit/types`.
    Never hand-write DB row types — use `typeof table.$inferSelect`.
  - Server logs use `[event] [phase] key=value - message`, phases `[start]/[end]/[fail]`.
    Wrap dynamic values in `sanitizeLogValue()`.
  - Every feature is user-scoped: filter by `userId`, inject `@CurrentUser()`, pass it down.
    Throw `ForbiddenException` for non-owners (superuser may bypass — see `SmartScopeService`).
  - DTOs use `class-validator`. `ValidationPipe` is global with `forbidNonWhitelisted: true`.
  - Throw NestJS `HttpException` subclasses, never raw `Error`.
  - Never hand-write migration SQL — always generate from a schema diff with drizzle-kit.
  - **NEVER add a `Co-authored-by` trailer to any commit.** Hard rule, no exceptions.
  - Conventional commit format. Branch is already correct; commit onto it.
- **Scale rules apply**: assume tens of thousands of books. No unbounded queries, no loading a
  full library into memory, no N+1. Paginate, index, and scope by user.

### Load-bearing schema facts (each verified by reading the file)

| Fact | Location | Why it matters |
|---|---|---|
| `reading_sessions.book_file_id` is **nullable** — comment says *"manual sessions are book-level and have no file"* | `server/src/db/schema/reader.ts:198` | **Keystone.** Sessions already work for fileless books. Do not alter this table's shape. |
| `reading_sessions.source` is `varchar(20)` + check constraint, 6 values | `reader.ts:207`, `packages/types/src/reading-session.ts:3` | `'physical'` is 8 chars, **fits in 20** — do NOT widen the column. |
| `reading_attempts` is book-level (userId + bookId, no file); `origin` check constraint | `reader.ts:46-81` | Add `'physical'` to the origin check. Completion counting then works unchanged. |
| `user_book_status` is book-level | `reader.ts:9-27` | Read status works unchanged. |
| `reading_progress` PK is `(book_file_id, user_id)`, `book_file_id` **NOT NULL**, used in 134 non-test spots / 34 joins | `reader.ts:143-151` | ❌ **DO NOT TOUCH.** Unusable for physical books. Kobo + Hardcover progress sync join through it. Current page goes on the copy row instead. The gate FAILS if a new migration mentions `reading_progress`. |
| `books` requires `libraryId`, `libraryFolderId`, `folderPath` (unique per library) | `server/src/db/schema/books.ts:7-47` | Physical books need a synthetic sentinel `folderPath` = `physical://<uuid>`. Never matches a real FS path. |
| `books.primaryFileId` is already nullable | `books.ts:16` | A zero-file book is already representable. |
| `books.status` check is `('present','missing','processing')` | `books.ts:46` | Physical books are `'present'`. Do not add a status value. |
| `books` rows are created in exactly 2 places, both needing a real file | `scanner.repository.ts`, `upload-processor.service.ts:90` | You add a third path. **Mirror `upload-processor.service.ts:90-94`**: always insert an empty `book_metadata` row so joins never return null. |
| `markBooksAsMissing(ids)` is a **single choke point** | `server/src/modules/scanner/scanner.repository.ts:187-190` | The critical guard is a one-line `AND medium = 'file'` here. Not a scattered refactor. |
| Metadata search DTO **already accepts `isbn`** | `server/src/modules/metadata-fetch/dto/metadata-search.dto.ts:23,65` | ISBN import is wiring, **not** a new provider. Reuse the existing pipeline. |
| `book_metadata` already has `isbn10`, `isbn13`, `pageCount` | `server/src/db/schema/metadata.ts:45-51` | No metadata schema change needed. |
| `notifications` table has `type/title/message/actionUrl/meta/read` | `server/src/db/schema/notifications.ts` | Reuse for due-date nudges. Do not build a notification subsystem. |
| Filter fields are a typed registry `FIELD_OPERATORS: Record<StaticRuleField, RuleOperator[]>` | `packages/types/src/query.ts:101,132` | New scope fields are additive and compiler-enforced. |
| Dashboard widgets are a flat controller registry (12 today) | `server/src/modules/dashboard/dashboard.controller.ts:26-81` | Follow the established pattern for `due-soon`. |
| Latest migration is `0063_crosspoint_audiobookshelf_sources.sql` | `server/src/db/migrations/` | Your work generates **0064**. Exactly one new migration file. |
| Library creation requires ≥1 real folder path validated against `LIBRARY_BROWSE_ROOT` | `library.service.ts:105-145`, `assertFolderPathsWithinBrowseRoot:382` | Sam will create the "Physical" library himself with a real empty dir. **Do not attempt to create a library in code.** Accept `libraryId` as input. |
| `pathsOverlap` is used ONLY in the prescan preview (advisory `overlapLibrary` warning), never enforced in `create`/`update` | `library.service.ts:278-285` | A nested folder is therefore permitted. On the live deploy `LIBRARY_BROWSE_ROOT=/books` and library 1 ("Ebooks") already scans `/books`, so the Physical library will point at **`/books/_physical`** (an empty dir). Expect an advisory overlap warning in the UI — it is not an error. An empty dir yields `candidateCount=0` and imports nothing (`scanner.service.ts:836-841`), so the folder stays permanently empty and harmless. |
| No barcode/camera library exists in the client | `client/package.json` | You must add one — see the client section. |

### The `'physical'` source spans 12 files + tests (all confirmed to exist)

> ⚠️ **CORRECTION (authoritative — overrides any conflicting text below).** There are **THREE
> DISTINCT unions**, not one. Do not conflate them:
> 1. `READING_SESSION_SOURCES` (`packages/types/src/reading-session.ts`) — drives
>    `reading_sessions_source_chk`.
> 2. `READING_ATTEMPT_ORIGINS` (`packages/types/src/book.ts:40`) — drives
>    `reading_attempts_origin_chk`. **This is a separate list** and its members differ
>    (`manual, bookorbit, kobo, koreader, hardcover, migration`).
> 3. `READING_SESSION_SOURCE_BUCKETS` (`packages/types/src/reading-session-source-bucket.ts`) —
>    the display/grouping list, a third distinct set (`bookorbit, koreader, kobo, ...`).
>
> Also: **`fileAvailability` is NOT a standalone case.** It delegates to the shared
> `statusRuleToSql` (`book-query-builder.service.ts:785`, called from line 194). That helper has
> exactly one caller, so guarding it there is safe — but verify callers before editing.
>
> Also add `BOOK_MEDIUMS`/`BookMedium` to `packages/types/src/book.ts` and type the column
> `$type<BookMedium>()`.

Adding a reading-session source value has been done twice before on this fork (`crosspoint`,
`audiobookshelf`). **Every one of these must be updated or TypeScript exhaustiveness fails:**

| Path | What to add |
|---|---|
| `packages/types/src/reading-session.ts` | `'physical'` in `READING_SESSION_SOURCES` |
| `packages/types/src/reading-session-source-bucket.ts` | bucket in `READING_SESSION_SOURCE_BUCKETS`, a label, a branch in `toReadingSessionSourceBucket`, a key in `emptySourceBucketRecord` |
| `server/src/db/schema/reader.ts` | `reading_sessions_source_chk` + `reading_attempts_origin_chk` |
| `client/src/features/book/components/detail/tabs/ReadingLogTable.vue` | `SESSION_SOURCE_PILLS` entry (line ~89) |
| `client/src/features/book/components/detail/tabs/ReadingLogSourceSplit.vue` | `BUCKET_TOKEN` entry |
| `client/src/features/statistics/lib/source-bucket-colors.ts` | `SOURCE_BUCKET_COLOR_TOKENS` + the resolver |
| `client/src/assets/theme/tokens.css` | `--pill-physical` in **BOTH** light and dark blocks |
| `client/src/locales/en.json` | `sourceNames.physical` |
| `packages/types/src/__tests__/reading-session-source-bucket.spec.ts` | extend the exhaustive assertions |
| `client/src/features/statistics/lib/source-bucket-colors.test.ts` | extend |
| `client/src/features/statistics/lib/breakdown.test.ts` | extend the ordered key list |
| `client/src/features/statistics/components/DailyReadingDayDetail.test.ts` | extend the `bySource` literal |
| `server/src/modules/user-statistics/user-statistics.service.test.ts` | extend **every** `bySource: { ... }` literal — they spell out all sources exhaustively |

## Work plan — 6 slices, commit after each

> ⚠️ **WORKFLOW RULE (authoritative — a previous run died ignoring this).** The full gate
> (`sh scripts/verify-physical-books.sh`) takes **~12 minutes**: server typecheck + client
> vue-tsc + BOTH full suites. A previous run was killed by its iteration timeout while running
> the full gate mid-slice, leaving 22 files of finished work uncommitted.
>
> **COMMIT FIRST, VALIDATE SECOND.**
> 1. Write a slice's code.
> 2. Run only the **cheap targeted** checks for it (seconds to ~1 min each).
> 3. **COMMIT IMMEDIATELY.** A commit is cheap and recoverable; uncommitted work dies at an
>    iteration boundary.
> 4. Only run the FULL gate **once, at the very end**, after all slices are committed.
>
> Cheap targeted checks (all must run inside `node:24-alpine` with `node_modules` bind-mounted
> exactly as the gate script does — host Node 22 is glibc and cannot load the musl bindings):
> ```
> (cd packages/types && node_modules/.bin/tsc -p tsconfig.json)
> (cd server && node_modules/.bin/tsc --noEmit -p tsconfig.build.json)
> (cd server && node_modules/.bin/vitest run src/modules/<module>)
> (cd client && node_modules/.bin/vitest run <single-path>)
> ```
> Do NOT run `vitest run` with no path filter mid-slice — that is the 6-minute full suite.

**SLICE 1 IS ALREADY DONE AND COMMITTED** (`a4df6401`) — schema, `books.medium`,
`book_physical_copies`, migration `0064`, and `'physical'` across all three unions. Types build
and server typecheck verified passing. **Do NOT redo, revert, or regenerate any of it, and do
NOT create another migration for it.** Start at slice 2.

Build in this order. Each slice must leave the repo green on the gate's baseline checks.

### Slice 1 — schema + the `'physical'` source

- `books.medium`: `varchar('medium', {length: 20}).notNull().default('file')`, plus
  `check('books_medium_chk', sql\`${t.medium} in ('file', 'physical')\`)` and
  `index('books_library_medium_idx').on(t.libraryId, t.medium)`.
- New `server/src/db/schema/physical.ts` with `bookPhysicalCopies`, re-exported from
  `server/src/db/schema/index.ts`. Columns:
  - `userId`, `bookId` (composite PK, both cascade-delete)
  - `acquisition` `varchar(20)` not null default `'owned'`, check in
    `('owned','borrowed_library','borrowed_personal')`
  - `pageCount` int nullable (copy-specific; overrides `book_metadata.pageCount` because a
    reprint rarely matches the matched edition), `currentPage` int not null default 0, check `>= 0`
  - `lender` `varchar(255)` nullable, `dueOn` date nullable, `renewalsUsed` int not null
    default 0, `renewalLimit` int nullable, `returnedOn` date nullable
  - `binding` `varchar(20)` nullable, check in `('hardcover','paperback','mass_market','other')`
  - `shelfLocation` `varchar(255)` nullable, `acquiredOn` date nullable, `notes` text nullable
  - `createdAt` / `updatedAt` timestamps with `$onUpdateFn`
  - Indexes: `bpc_book_id_idx`; partial `bpc_user_due_on_idx` on `(userId, dueOn)`
    `where dueOn is not null and returnedOn is null`
  - Check: `bpc_due_requires_lender_chk` — `acquisition = 'owned' or lender is not null`
- Shared types in `packages/types/src/physical-book.ts`: `PHYSICAL_ACQUISITIONS`,
  `PhysicalAcquisition`, `PHYSICAL_BINDINGS`, `PhysicalBinding`, `PhysicalCopy`,
  `PhysicalCopySummary`, `DueSoonEntry`, `LoanUrgency`. Re-export from the package index.
- All 13 rows of the `'physical'` source table above.
- Generate the migration (see the exact container command below). Verify it is **additive only**
  and does not mention `reading_progress`.

### Slice 2 — guards (do this BEFORE any physical row can exist)

These are not optional polish; without them the feature actively breaks the app.

1. **Scanner** — `markBooksAsMissing` (`scanner.repository.ts:187`) must add
   `and(eq(books.medium, 'file'))` to its `where`. Without this, **every scan marks all physical
   books missing and fires "books unavailable" notifications.** Also check the callers in
   `scanner.service.ts:419-438` (`flushBookMissingEmit`, `flushBooksUnavailableNotification`)
   so physical books never enter those buffers.
2. **`fileAvailability` filter** — `book-query-builder.service.ts` `case 'fileAvailability'`
   must exclude `medium='physical'`; nothing is "missing" about a physical book.
3. **File-resolution paths** — `book.service.ts` `verifyFileAccess` and the download/reader
   routes must throw `BadRequestException('Physical books have no files')` rather than 500.
   Exclude `medium='physical'` from Kobo sync and OPDS feed queries.
4. **Duplicate scan / book-dock** — exclude physical books from candidates.
5. **Delete** — `DELETE /api/v1/books` must be a clean no-op for zero-file books (it deletes
   files from disk for normal ones). Add a regression test proving delete succeeds and the copy
   row cascades away.

Write a regression test for #1 and #2 specifically. They are the ones that would surface as
"BookOrbit is broken" rather than "the feature is missing".

### Slice 3 — ISBN import (requirement 2)

- `server/src/common/utils/isbn.utils.ts` (+ `.test.ts`): normalize (strip separators,
  uppercase `X`), validate **ISBN-10 mod-11 and ISBN-13/EAN-13 mod-10 checksums**, convert
  10→13. Pure functions, cheap to test, and they catch most barcode misreads before any network
  call. This file having tests is a gate assertion.
- New module `server/src/modules/physical-book/` (controller / service / repository / module /
  `dto/` / `utils/`). Routes:
  - `POST /api/v1/physical-books/lookup` `{isbn}` → `MetadataCandidate | null` (preview, no write)
  - `POST /api/v1/physical-books` → `{bookId, copy}`
  - `POST /api/v1/physical-books/bulk` `{libraryId, isbns[], acquisition}` → `{created[], failed[]}`
- Create flow: validate ISBN → **409 `ConflictException`** if that ISBN already has a physical
  copy for this user in that library (return the existing `bookId` so the UI can say "already on
  your shelf") → resolve metadata through the existing `MetadataFetchService.search({isbn})` →
  insert in ONE transaction, mirroring `upload-processor.service.ts:90-94`:
  `books` (with `folderPath: 'physical://' + randomUUID()`, `medium: 'physical'`,
  `status: 'present'`) → **always** an empty `book_metadata` row, then apply resolved fields →
  `book_physical_copies` → `user_book_status`.
- `DTO`: at least one of `isbn` or `title` required — mirror the `atLeastOneSearchTerm`
  validator already in `metadata-search.dto.ts`.
- Bulk import: bounded concurrency (≤3), per-ISBN error capture. Providers rate-limit, and a
  40-book haul must not fail wholesale on one bad scan.

### Slice 4 — page progress (requirement 4)

- `PATCH /api/v1/physical-books/:bookId/progress` `{currentPage, minutes?, startedAt?}`:
  1. Clamp `currentPage` to `0..effectivePageCount`. Allow a decrease only when `minutes` is
     absent (a correction is legitimate; a session that goes backwards is not).
  2. `effectivePageCount = copy.pageCount ?? book_metadata.pageCount`. Compute
     `endProgress = round(currentPage / effectivePageCount * 100, 2)`. If **neither** page count
     exists, store the page and leave `endProgress = null` — that column is nullable for exactly
     this reason. **Never invent a denominator.**
  3. When `minutes` is given, create a `reading_sessions` row with `source='physical'`,
     `bookFileId=null`. **Route this through the existing reading-session repository path**
     (`insertManualSession` + `upsertDailyStats`, see
     `reading-session.service.ts:102-147`) — a hand-rolled INSERT desyncs
     `user_reading_daily_stats` and silently breaks the streak.
- Reaching 100% flips `user_book_status` to `read` and closes the open `reading_attempt` as
  `completed`, matching ebook behaviour.
- `GET /api/v1/physical-books/:bookId` returns the copy plus **derived** (computed, never
  stored): `percentage`, `pagesRemaining`, `daysRemaining`, `pagesPerDayNeeded`,
  `paceLast7Days`, `onTrack`, `urgency`.
- Also: `PATCH /api/v1/physical-books/:bookId` (update copy),
  `DELETE /api/v1/physical-books/:bookId`, `POST /api/v1/physical-books/:bookId/return`.

### Slice 5 — loans + encouragement (requirements 1 and 3)

- `server/src/modules/physical-book/utils/loan-urgency.utils.ts` (+ `.test.ts`), a **pure**
  function:
  ```
  daysRemaining     = dueOn - today            (USER'S PROFILE TIMEZONE, not UTC)
  pagesRemaining    = effectivePageCount - currentPage
  pagesPerDayNeeded = ceil(pagesRemaining / max(daysRemaining, 1))
  paceLast7Days     = pages read in last 7d / 7
  onTrack           = paceLast7Days >= pagesPerDayNeeded
  urgency           = overdue     if daysRemaining < 0
                      urgent      if daysRemaining <= 2 or (!onTrack and daysRemaining <= 5)
                      tight       if !onTrack
                      comfortable otherwise
  ```
- ⚠️ **Timezone is a real trap this fork has already hit twice.** Server runs `Etc/UTC`; Sam is
  `America/Los_Angeles`. Use `resolveTimeZone(user.settings.timezone)` from
  `server/src/common/utils/timezone.utils.ts`. A "due today" book must not flip a day early at
  5pm Pacific. For the 7-day pace window reuse `getDayRangeForDateKeys(days, timeZone)` from
  `server/src/common/utils/reading-daily-stats.utils.ts` — do NOT hand-roll boundaries.
  Test the day boundary explicitly.
- ⚠️ **Postgres error 42803 trap**: if you GROUP BY a parameterized `AT TIME ZONE` expression,
  the timezone binds as different placeholders in SELECT vs GROUP BY and Postgres rejects it.
  Alias the expression in a subquery and group by the alias (see `getPeakReadingHours`).
  Filtering (not grouping) on it is safe.
- `GET /api/v1/dashboard/widgets/due-soon`: borrowed copies with `dueOn` not null and
  `returnedOn` null, sorted by `dueOn`, **capped at 10**, each with `urgency` and
  `pagesPerDayNeeded`. Register alongside the existing 12 widgets. Respect the established
  per-user cache (live 120s / stale 300s).
- Notification sweep at 7 / 3 / 1 days out and on the overdue day, inserting `notifications`
  rows (`type='physical_due_soon'`, `actionUrl='/book/:id'`). **Idempotent** — guard on
  `(userId, type, meta->>'bookId', meta->>'milestone')` so a re-run never double-notifies.
  Message carries encouragement, not just a deadline:
  *"Due in 3 days — 96 pages left, about 32/day. You've been averaging 24."*
- Smart scope fields in `packages/types/src/query.ts` + a `case` each in
  `book-query-builder.service.ts` + locale labels + `group-rule.validator` tests:
  - `medium` → `includesAny | excludesAll`
  - `acquisition` → `includesAny | excludesAll`
  - `dueOn` → `before | after | between | withinLast | isEmpty | isNotEmpty`

### Slice 6 — client

New feature folder `client/src/features/physical-book/` (components + composables).

- **Barcode dependency (approved by Sam): the `barcode-detector` polyfill.** It exposes the
  native `BarcodeDetector` API, using the native implementation on Android Chrome and a
  ZXing-backed WASM fallback on iOS Safari (which has no native support — the case that
  matters). **Lazy-load it only when the scan sheet opens** so the main bundle is untouched.
  Formats: `ean_13` (all modern ISBN barcodes) plus `ean_8` / `upc_a` for older stock.
  Requires HTTPS — satisfied by `samfp.tech/books`.
- `AddPhysicalBookSheet.vue` — camera scan / type ISBN / paste many. Live metadata preview
  (cover, title, author, page count) before commit. Acquisition selector that reveals lender +
  due date only for borrowed copies. Feed every decode through the ISBN checksum validator
  before any network call; debounce duplicate decodes; keep the camera open for continuous
  multi-book scanning (scan → confirm toast → next).
- `LogPagesDialog.vue` — **the primary daily interaction, so make it fast.** Big current-page
  number input, `+`/`−` steppers, optional minutes field, progress bar showing page →
  percentage. One tap from the book card. Reuse patterns from the existing
  `AddSessionDialog.vue`.
- `PhysicalCopyPanel.vue` — book-detail panel: binding, shelf location, acquisition, and for
  loans the due date, urgency chip, pages/day needed, and on-track indicator.
- `DueSoonWidget.vue` — dashboard card, urgency-sorted, rows deep-link to `/book/:id`.
- Composables: `usePhysicalCopy`, `useLogPages`, `useBarcodeScanner`, `useDueSoon`.
- Hide the reader entry point, Files tab, and Download actions when `medium === 'physical'`;
  render the physical panel instead.
- Add any urgency colors as theme tokens in **both** light and dark blocks. Never hardcode.

## Migration command (exact — do not hand-write SQL)

```bash
cd /home/sam/workspace/bookorbit-fork
/usr/bin/sg docker -c "docker run --rm -u \$(id -u):\$(id -g) -e HOME=/tmp \
  -v \$HOME/workspace/bookorbit-fork:/app -w /app node:24-alpine sh -c '
  npm i -g pnpm@10.33.4 >/dev/null 2>&1; pnpm install --frozen-lockfile >/dev/null 2>&1
  pnpm --filter @bookorbit/types build >/dev/null 2>&1
  cd server && pnpm exec drizzle-kit generate --name physical_books'"
# that container leaves a root-owned /app/.pnpm-store; remove it via a container:
/usr/bin/sg docker -c "docker run --rm -v \$HOME/workspace/bookorbit-fork:/app alpine rm -rf /app/.pnpm-store"
```

Expect exactly **one** new file, `0064_physical_books.sql`. Inspect it before committing.

## Acceptance gate

```bash
sh scripts/verify-physical-books.sh
```

It runs in `node:24-alpine` (this checkout's `node_modules` are musl-built; host Node 22 cannot
load the vitest/rolldown native bindings) and asserts, beyond compiling: the schema changes and
their check constraints exist; no new migration touches `reading_progress`; the `'physical'`
source spans every required layer including both theme blocks; the ISBN utils exist **with
tests**; the physical-book module exposes its routes; page progress routes through the
reading-session layer; loan urgency exists **with tests** and references timezone handling; and
the scanner filters on `medium`.

**Pre-existing failures — NOT caused by you, do not "fix" them inside this feature:**
- `validate:locales` is already red on this branch's base (~360 missing-key lines, ~301 of them
  `statistics.dailyReading.*`) because a prior fork feature shipped English-only keys. English-only
  work here **adds** `15 × <new keys>` complaints. Be honest about that delta; do not claim it
  changes nothing, and do not machine-translate 15 catalogs.
- `format:client` flags exactly one file, `ReadingLogTable.vue`, which is byte-identical to
  `origin/main` (upstream formatting debt). You WILL be editing that file — keep your edit
  consistent with the surrounding style and do not reformat the whole file.
- `oxlint` is **not** in the gate but enforces extra rules that block commits (e.g.
  `vitest/require-mock-type-parameters` rejects a bare `vi.fn()`). Run
  `client/node_modules/.bin/oxlint src/...` on files you touch.

## Definition of done

Every item below must be true, verified from files and real execution — not self-reported:

1. `sh scripts/verify-physical-books.sh` exits 0.
2. Exactly one new migration, `0064_*`, additive only, never mentioning `reading_progress`.
3. A physical book can be created from an ISBN and appears in the library with real metadata.
4. Logging pages creates a `source='physical'` reading session that moves the streak and shows
   on the Daily Reading page.
5. A borrowed book with a due date surfaces in the due-soon widget with correct urgency and a
   pace-aware message.
6. A library scan with physical books present marks **zero** of them missing and sends no
   "books unavailable" notification.
7. Download / reader / OPDS / Kobo paths degrade cleanly (400, not 500) on a fileless book.
8. Server + client typechecks and full test suites pass.
9. Commits are conventional-format, on `BO-physical-books`, with **no `Co-authored-by` trailer**.

## Explicit non-goals

- Do **not** make `reading_progress.book_file_id` nullable.
- Do **not** create the Physical library in code — accept `libraryId` as input.
- Do **not** add a second new table, service, transport, or cache.
- Do **not** attempt to sync physical progress to Hardcover/StoryGraph. Their progress sync
  `innerJoin`s `reading_progress` through `bookFiles`, so it is structurally file-keyed.
  Status and read dates still sync via the existing status path. Note the limitation in the PR
  description; a later follow-up maps `currentPage` → Hardcover's page-based `progress_pages`.
- Do **not** redesign the reader, scanner, statistics pages, or library browse UI.
