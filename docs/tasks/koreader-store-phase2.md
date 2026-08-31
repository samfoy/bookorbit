# KOReader Store Phase 2: personalized, state-aware, one-tap reading

## Goal

Complete the native BookOrbit Store roadmap. The Store should know the reader, explain recommendations, continue series, reconcile reading/ownership state, expose tracker shelves, make acquisition smarter, support richer browsing, respect device constraints, and provide a resumable batch-capable Get-and-Open lifecycle.

This extends the deployed Store at commit `2b94e67a`. Preserve every existing Store safety invariant and the headless KOReader emulator gate.

## Ownership gate

### Existing owners to extend

- `RecommendationService`, dashboard/scroller services, BookOrbit book/status/progress/series query owners: personalization, local ownership, local read state, series continuation.
- `HardcoverModule`: Hardcover Read/Want to Read/Currently Reading/custom lists and provider-specific metadata.
- `StorygraphModule`: StoryGraph To Read/Currently Reading/provider-specific metadata and challenge shelves where the authenticated session exposes them.
- `BookDiscoveryService` and `HardcoverCatalogBrowseService`: external result mapping, search, browse, filtering, pagination.
- `BookAcquisitionService` and `EpubAcquisitionDownloaderService`: one and only acquisition job, source selection, candidate validation, retry/fallback, X3 optimization, UploadService ingestion.
- `KoreaderCatalogService`: local BookOrbit catalog details/download URLs.
- `bookorbit.koplugin`: device state, free-space checks, Wi-Fi/charging policy, persisted acquisition intentions, batch sequencing, Store UI, final existing catalog download/open.

### Forbidden

- No provider credentials on-device.
- No second server acquisition queue, downloader, scanner, upload owner, database queue, daemon, or sidecar.
- No duplicate book/state database table.
- No direct device requests to Hardcover, StoryGraph, LibGen, or Anna's Archive.
- No fabricated recommendation explanations or remote state.
- No automatic destructive cleanup by default.

### Persistence decision

Server acquisition jobs remain intentionally transient and in-memory. Durable user intent belongs to the KOReader device's existing settings state. If a server restart loses a job, the plugin reconciles the missing job and offers or automatically performs one bounded retry from the persisted intention. Do not add a persistent server queue.

## Whole-task acceptance ledger

### 1. Unified state and duplicate prevention

Every external Store result carries a user-scoped state projection:

- `inBookOrbit`, `bookId`, and available local formats
- BookOrbit status and progress
- Hardcover status when matched
- StoryGraph status when matched/available
- `alreadyRead` derived from any authoritative read state
- `alreadyOwned` derived from BookOrbit ownership
- device state is overlaid by the plugin's existing on-device hash/path maps

Matching order: normalized ISBN-13, ISBN-10, provider pinned ID, then normalized title + primary author. Use existing match/normalization helpers rather than a new fuzzy engine.

UI badges/actions must distinguish Read, Want to Read, In BookOrbit, On Device, Reading, Acquiring, and Not owned. An owned result never starts a duplicate acquisition: it opens/downloads the existing local BookOrbit book. A read result remains hidden by default but can be revealed.

### 2. For You with honest explanations

Add a user-scoped `For You` shelf that uses existing BookOrbit recommendation/rating/status/genre/author data and provider similarity/trending only as inputs. Each item has one explanation from real evidence, for example:

- `Because you rated Piranesi 5 stars`
- `More by Ursula K. Le Guin`
- `Next in the Red Rising series`
- `Fantasy matching your recent reading`
- `Popular with readers of Dungeon Crawler Carl`

Do not emit an explanation unless the cited book/author/genre/series signal exists in the source data. Exclude read and owned books by default. Keep all candidate pools bounded and deduplicate by normalized ISBN then title/author.

### 3. Up Next in Your Series

Add an `Up Next in Your Series` shelf using BookOrbit's existing strict up-next/series semantics where available. Each result includes series name/index and the predecessor signal that made it eligible. It must not suggest volume N when an earlier unread owned/missing volume exists. Owned next volumes open/download; missing next volumes acquire.

### 4. Tracker shelves

Expose provider-owned shelves through the Store facade:

- Hardcover Want to Read, Currently Reading, and recently added tracker books
- StoryGraph To Read, Currently Reading, and recently added tracker books
- Hardcover custom lists when discoverable from the current API token
- StoryGraph challenges/prompts when discoverable from the authenticated session

Provider-specific scraping/query code stays in the provider module. A provider/session/list that is unavailable returns a source-level unavailable status and does not suppress other shelves. Never pretend a challenge/list exists.

Support Get, Get all visible, and Get unread series from tracker/browse shelves through the one acquisition owner. Add an opt-in device setting to mirror a selected tracker shelf on explicit refresh; do not add a background server cron.

### 5. True Get and Open

Add explicit actions:

- `Get`
- `Get and download`
- `Get and open`

Get and Open performs one lifecycle:

1. Start the existing acquisition job.
2. Poll through verification, optimization, and import.
3. Fetch the imported local BookOrbit detail by `bookId`.
4. Reuse the existing catalog downloader, destination/collision rules, partial-MD5 verification, match-link registration, and open-file action.

Do not implement a second file downloader. Persist the selected completion action with the device intention. Duplicate taps are blocked before POST.

### 6. Smarter acquisition and edition visibility

Before confirmation, show the metadata BookOrbit actually knows: provider, language, year, publisher when available, page count, ISBN, ebook availability, and estimated/known file size when available.

The server's automatic source path must:

- prefer verified retail-quality EPUB candidates
- prefer the user's/app's language when known
- continue to reject bundles, wrong volumes, author/title mismatch, corruption, and oversized files
- fall back to the next safe source/candidate when download or post-download verification fails
- return concise attempt/failure information on the job without leaking mirror URLs or secrets

Add `Retry another edition/source` for failed jobs and completed-but-rejected intentions. Retry must create a new bounded existing acquisition job with exclusions/attempt context; it must not mutate an irreversible completed import.

### 7. Rich browsing

Store browse supports bounded server-side sorting/filtering where the provider can honor it:

- relevance, rating, popularity, newest, shortest, longest
- language
- publication-year range
- page-count range
- ebook-only
- series-only/standalone

Add curated shelves from verified metadata: New releases, Award winners where tags support it, Short reads, Highly rated, and New from authors you read. Unsupported provider/filter combinations report the limitation rather than silently lying.

### 8. Device-aware downloads and cleanup

The plugin reports/display-only device facts locally; do not send them to providers:

- free storage before download
- expected size when known
- insufficient-space refusal with the needed/free values
- EPUB/KEPUB choice only where an existing conversion/download path supports it
- Wi-Fi-only queue option
- charging-only batch option when the device API exposes charging state
- `Remove from device, keep in BookOrbit`
- opt-in cleanup of finished local files after a configurable age, with a confirmation preview and never automatic by default

No cleanup may delete the BookOrbit server file or metadata.

### 9. Resumable queue and batch actions

The native queue persists device-side intentions and includes:

- queued, acquiring, downloading, ready, failed, cancelled
- current phase and useful server error
- retry with same source and retry another source/edition
- cancel one; cancel remaining batch
- Get all visible
- Get unread series
- wait for Wi-Fi/charging
- resume after plugin/KOReader restart
- reconcile a missing transient server job after server restart
- notifications when ready

Batch processing is sequential or uses a small bounded concurrency that cannot exceed the server's existing per-user limit. It must never issue an unbounded set of POSTs.

### 10. Native UI and compatibility

- Extend the existing Store navigation stack, cover grids, detail page, action dialogs, focus maps, and thumbnail cache.
- Touch and D-pad paths are both reachable.
- Older servers hide Phase 2 entry points using a new capability while retaining the v1.6 Store.
- Offline caches clearly mark stale data.
- Every async response is generation guarded across newer navigation, Back, dashboard jumps, and close.
- Bump plugin to `1.7.0` and update package/source/version/docs assertions.

## API shape

Prefer one enriched Store payload and existing endpoints over many narrow calls. Allowed additions beneath the current KOReader Store facade:

- enriched `/store/home`
- `/store/shelves` and `/store/shelves/:id` only if home payload + existing browse cannot carry tracker/personalized shelves cleanly
- enriched `/store/browse` and `/store/search`
- enriched `/store/config`
- existing `/store/acquisitions` lifecycle with retry/batch DTO fields only where needed
- local BookOrbit catalog detail/download routes remain the post-import handoff

No database migration should be needed. If inspection proves otherwise, stop and record the exact unmet lifecycle before adding schema.

## TDD slices

Use vertical RED-GREEN-REFACTOR slices and commit before expensive full gates:

1. Unified result state and duplicate prevention.
2. For You explanations.
3. Up Next series.
4. Hardcover tracker shelves.
5. StoryGraph tracker/challenge shelves.
6. Rich browse filters/shelves.
7. Smarter acquisition fallback/retry metadata.
8. Get and Open handoff.
9. Device policy/storage/cleanup.
10. Resumable/batch queue.
11. Plugin 1.7.0 compatibility/docs.

## Deterministic acceptance

- Existing `scripts/verify-koreader-store.sh` remains green.
- Add `scripts/verify-koreader-store-phase2.sh`, prove it red before implementation, and make it assert real call sites/contracts for all ten acceptance groups.
- Focused server tests cover state matching, explanation provenance, series order, provider partial failures, filter DTOs, fallback attempts, retry, permissions, and no-secret payloads.
- Lua specs cover badges/actions, duplicate prevention, Get-and-Open, missing-job reconciliation, batch bounds, Wi-Fi/charging waits, storage refusal, cleanup preview, Back/navigation races, and legacy capability fallback.
- All plugin Lua compiles with Lua 5.1; all existing plugin specs pass.
- Server/shared/client typechecks, ESLint/oxlint/Prettier/style checks, and production builds pass under Node 24.
- Official KOReader Linux emulator screenshots at 758x1024 and 600x800 prove For You, Up Next, tracker shelf, state badges, Get-and-Open confirmation, and queue views with no clipping and no runtime errors.
- Disposable full-stack acceptance uses KOReader headers and real provider credentials, acquires a non-duplicate EPUB, verifies X3 manifest, downloads/opens through the local catalog path, and cleans every disposable artifact.
- One adversarial review of the integrated diff, fixes for concrete reachable findings, then one confirmation review.

## Deployment

Parent Hermes session independently verifies exact commits, builds a commit-tagged image, confirms plugin 1.7.0 and Phase 2 capability in the artifact, checks no active production acquisition, backs up DB/env, deploys, verifies migrations unchanged, tests local/domain/IP KOReader Store routes and package ZIP, runs one safe non-importing production probe, checks logs, and leaves physical-device install as the only explicit hardware limitation if no device is connected.
