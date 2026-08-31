# KOReader native BookOrbit Store

## Goal

Turn the existing BookOrbit KOReader catalog plugin into a native-feeling ebook storefront. A reader should be able to open BookOrbit on a KOReader device, browse external trending/genre/author/similar shelves, search Hardcover and StoryGraph, inspect a storefront-style external book detail page, acquire a verified EPUB into BookOrbit, follow progress, and download/open the imported book on the device without using the web UI.

The experience should feel closer to the built-in Kobo/Kindle store flow than an admin API client, while retaining KOReader interaction conventions, e-ink performance, offline tolerance, D-pad focus, and BookOrbit's existing safety boundaries.

## Verified ownership facts

- `koreader-plugin/bookorbit.koplugin/` already owns the native device catalog, cover grids, detail views, offline caches, downloads, progress UI, D-pad focus, and device settings.
- `KoreaderCatalogController` already owns KOReader-credential-authenticated catalog routes beneath `/api/v1/koreader/plugin/catalog`.
- `BookDiscoveryService`, `HardcoverCatalogBrowseService`, and `BookAcquisitionService` already own external search/browse and guarded acquisition. Do not duplicate provider clients, credentials, matching, LibGen/Anna's logic, X3 optimization, job state, or UploadService ingestion.
- The ordinary `/api/v1/discovery` routes require a web JWT. The device has KOReader credentials, so the existing KOReader controller needs a store facade that delegates to the existing discovery/acquisition owners.
- `@Public()` causes the global permission guard to bypass `@RequirePermission`; KOReader store acquisition must explicitly verify `Permission.LibraryUpload` after `KoreaderAuthGuard` has attached the user.
- `LibraryService.findAll(user)` already returns user-visible libraries with folders. Reuse it for acquisition destination options.
- The plugin package and self-update system ships the bundled plugin from the production image and advertises wire capabilities through `KoreaderPackageService`.

## Ownership gate

Allowed additions:

1. One narrow KOReader store service/controller surface within the existing `KoreaderModule`, delegating to exported discovery/acquisition/library owners.
2. Shared wire types for the KOReader store only where existing external-discovery types are insufficient.
3. One cohesive plugin store mixin/module plus small integration hooks into the existing catalog, API client, thumbnail cache, actions, and updater capability handling.

Forbidden:

- Provider credentials on the device.
- A second downloader, acquisition queue, scanner, upload path, database table, daemon, sidecar, or persistent server store.
- A parallel plugin application or separate navigation stack.
- Direct device calls to Hardcover, StoryGraph, LibGen, or Anna's Archive.
- Weakening existing KOReader auth, cross-origin redirect safety, acquisition validation, concurrency, or permissions.

## Server wire surface

All routes remain beneath the KOReader-authenticated catalog owner:

- `GET /koreader/plugin/catalog/store/home?hideRead=true`
- `GET /koreader/plugin/catalog/store/browse?...`
- `GET /koreader/plugin/catalog/store/search?...`
- `GET /koreader/plugin/catalog/store/config`
- `GET /koreader/plugin/catalog/store/acquisitions`
- `POST /koreader/plugin/catalog/store/acquisitions`
- `GET /koreader/plugin/catalog/store/acquisitions/:jobId`
- `DELETE /koreader/plugin/catalog/store/acquisitions/:jobId`

Requirements:

- Delegate home/browse/search to the existing services and preserve user scoping, provider partial-failure behavior, read filtering, bounded pagination, and Hardcover/StoryGraph credential ownership.
- Config returns only safe acquisition capabilities plus accessible library/folder choices. Never return provider credentials or secrets.
- Acquisition methods explicitly enforce `LibraryUpload`, verify library access through the existing service, and delegate to `BookAcquisitionService`.
- Route DTOs reuse/extend validated discovery DTOs; invalid kind, page, pageSize, ISBN, UUID, source, or library data returns 400.
- Add a `catalogStore` server capability. Older plugins/servers continue using the legacy catalog without store controls.
- Export/import existing owner services/modules rather than reconstructing them.

## Native device experience

### Entry and home

- Add a prominent `Store` entry to the BookOrbit dashboard/browse actions and Tools menu, gated by the advertised capability.
- Store opens immediately from a cached home payload when available, marks stale/offline state, then refreshes in the background.
- Store home shows a branded header, weekly trending cover shelf, genre shortcuts, and genre shelves using existing native cover-grid primitives, measured layouts, page controls, and D-pad focus.
- Keep e-ink updates bounded: no animation loops, no unnecessary full refreshes, and progressive cover loading through a dedicated bounded cache.

### Search and browse

- Store search uses the existing KOReader text input idiom and searches Hardcover + StoryGraph through BookOrbit.
- Browse trending, genres, authors, and similar books with bounded pages, next/previous navigation, total/current context, read-filter toggle, and refresh.
- Search provider status is presented concisely when one source is unavailable; valid results from the other remain usable.
- Preserve the default `hideRead=true` behavior and expose a native toggle to show books already read.

### External book cards and details

- External results are visually distinct from library books but reuse native mosaic/list conventions.
- Cards show cover, title, primary author, year/rating where available, source, and an acquisition state badge.
- Tapping an external book opens a native detail page with cover, title, author, description, series, genres, metadata, provider source information, and actions for `Get`, `More by author`, `Similar books`, and genre browsing.
- External covers are public images. If fetched directly by the device, accept HTTPS only, omit BookOrbit auth cross-origin, cap bytes, validate image content, follow only safe HTTPS redirects, and store them in a bounded dedicated cache. Never send KOReader credentials to a third-party origin.

### Get-book flow

- `Get` presents a native confirmation/options dialog using safe config data: destination library/folder and Auto/LibGen/Anna's source availability. Remember the last valid destination/source in device settings, but never secrets.
- Starting acquisition returns immediately to a native progress view. Poll at a bounded cadence and show queued, downloading, optimizing, importing, completed, failed, or cancelled states with meaningful error text.
- Cancellation is offered only for reversible statuses, matching server semantics.
- Persist only active job IDs/options locally so reopening the Store resumes status tracking. A server restart may lose transient jobs; surface this honestly and let the user retry.
- On completion, fetch the imported local BookOrbit detail by `bookId`, then offer `Download`, `Download and open`, and `View in library`. Reuse the existing catalog download, hash verification, destination, collision, match-link, and open-file lifecycle. Do not write a second file downloader.
- Ensure repeated taps cannot start duplicate jobs while one acquisition for that external book is active.

### Queue

- Add a compact Store downloads/acquisitions view reachable from the store home and catalog actions.
- It lists active and recent jobs, supports valid cancellation, opens completed local books, and recovers active tracking after plugin reopen.

### Input and resilience

- All screens work with touch and D-pad. Focus rows contain only drawn controls.
- Back/close behavior returns through the existing catalog stack without orphaned dialogs.
- Network work runs through the existing subprocess/Trapper path so navigation never freezes KOReader.
- Guard async callbacks with catalog/request generation so stale responses never replace a newer page/book.
- Offline mode serves cached store home/details/covers and clearly labels staleness; acquisition requires connectivity.

## Versioning and docs

- Bump the plugin from 1.5.0 to 1.6.0 in the authoritative `main.lua` version and every package/version assertion that exists.
- Update `_meta.lua` description and `koreader-plugin/README.md` to describe native external discovery/acquisition.
- Keep plugin state outside the plugin directory so self-update preserves settings, cover caches, and active job references.

## TDD and verification

Use strict vertical TDD. For each slice, write a focused test and observe the intended failure before implementation.

Required automated evidence:

1. Server controller/service/module tests for every route, delegation, validation, user scoping, library options, explicit upload permission denial, capability advertisement, and acquisition lifecycle.
2. Plugin API tests/specs for exact paths/query/body shapes and no credentials on external cover requests.
3. Lua host specs for store navigation/context mapping, pagination, read toggle, cache/stale behavior, acquisition state transitions, duplicate-tap prevention, cancellation semantics, resume behavior, completed local-book handoff, D-pad focus rows, and error/partial-provider states.
4. Static source/package tests proving the Store has real call sites, version 1.6.0, required modules bundled, settings/cache external to plugin dir, and no forbidden execution/file traversal APIs.
5. `luac5.1` syntax check for every plugin Lua file and execution of every `koreader-plugin/spec/*_test.lua` under Lua 5.1.
6. Focused server tests, server and shared-types typechecks, ESLint, Prettier, full plugin source/package tests, and production server/client builds.
7. A disposable full-stack acceptance using KOReader headers against the new routes: live Hardcover trending/search/genre/similar, config without secrets, one safe acquisition through the existing pipeline, completed local `bookId`, catalog detail, and served EPUB containing `META-INF/x-locations.json`. Do not duplicate a book already in the live library.
8. Host-rendered/stubbed KOReader interaction proof where possible. State clearly that host Lua/widget tests do not replace final on-device hardware validation.

## Review bounds

- One adversarial review of the integrated server + plugin store diff.
- Fix concrete reproducible findings on the accepted path.
- One confirmation review.
- If review requests a second architecture, persistent server queue, provider credentials on device, or another download stack, rerun the ownership gate instead of expanding.

## Completion and deployment

- Commit verified work with conventional commits and no `Co-authored-by` trailer.
- Parent Hermes session independently verifies the exact committed source, builds a commit-tagged image, backs up BookOrbit, deploys it, verifies health and migrations unchanged, exercises the KOReader-authenticated store API publicly through both front doors, confirms the bundled 1.6.0 plugin/update package, and validates no production errors.
- The deployed server making 1.6.0 available for plugin self-update is required. Actual installation and UX on a physical KOReader device remains a separate hardware confirmation unless the device is reachable during this run.
