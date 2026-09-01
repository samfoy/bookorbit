# KOReader Store UX 1.8

## Goal

Replace the current shelf-as-pages BookOrbit Store with a fast, ranked, native KOReader storefront. The user must be able to open Store, understand the available browse paths immediately, search by title or author and get the intended book first, inspect a concise detail page, and start the correct acquisition without feeling like they are navigating an API response.

This is a product-quality repair of the existing Store on `BO-external-book-discovery`, not a new application.

## Measured baseline (2026-09-01)

Live production measurements through the KOReader-authenticated route:

- `Klara and the Sun`: 2.26 s, 14 results. Exact book ranks first, followed by summaries, interpretations, and bundles.
- `Dune`: 1.77 s, 20 results. Criticism books titled _Dune_ rank before Frank Herbert books; the exact read book may be removed by `hideRead=true`.
- `Project Hail Mary`: 1.95 s, 13 results. Exact book ranks first, then summaries, collections, notebooks, and study material.
- `Kazuo Ishiguro`: 2.13 s, 20 results. Criticism books whose title is the author's name rank before novels by the author.
- Hardcover-only search: ~1.80 s. StoryGraph-only: ~2.52 s. Combined: ~2.01 s.

Root causes verified in source:

1. `BookDiscoveryService.mergeBooks()` preserves provider insertion order and does no global relevance ranking.
2. `Store.loadStoreSearch()` passes the home-level hide-read preference into explicit search, hiding exact owned/read matches.
3. `HardcoverCatalogService.search()` performs a second GraphQL edition query for all hits before returning any result.
4. Store home maps every shelf to a separate `page`; the initial screen is one shelf's book grid with `Page 1 of N`, not a navigable Store index.
5. Search is a blocking input-dialog -> wait-message -> result-grid path with no recent query, no intent context, and no concise explanation when one provider is slow or unavailable.
6. External detail reuses a broad catalog detail shell and exposes too much metadata before the primary action.

Baseline emulator artifacts:

- `.hermes/store-ux-baseline-600/koreader-600x800-store-home.png`
- `.hermes/store-ux-baseline-758/koreader-758x1024-store-detail.png`

## Ownership gate

Keep all behavior in existing owners:

- `BookDiscoveryService` owns merged external search and ranking.
- `HardcoverCatalogService` and `StorygraphCatalogService` own provider calls and mapping.
- `KoreaderStoreService` owns the KOReader Store response facade and state enrichment.
- `bookorbit_store.lua` owns Store index/search/browse/detail/acquisition navigation.
- Existing catalog widgets, stack, focus, thumbnail cache, downloader, and acquisition lifecycle remain the only UI/network owners.

Forbidden:

- No new service, endpoint, database table, daemon, sidecar, provider client, device credential, downloader, queue, navigation stack, dependency, or persistent server cache.
- Do not build a second Store UI beside the existing catalog.
- Do not weaken acquisition title/author/volume/bundle verification.

## Required vertical slices

Use strict RED-GREEN-REFACTOR. For each slice, create a focused test and run it to observe the intended failure before editing production code. Commit each coherent slice before expensive gates.

### Slice 1: ranked, honest search

Add one exported pure ranking function in the existing discovery owner and apply it after cross-provider deduplication.

Ranking requirements:

- Exact normalized title is strongest.
- Exact normalized primary-author match is also a first-class intent, so `Kazuo Ishiguro` returns books authored by him ahead of criticism books titled with his name.
- Strong title-prefix/token coverage follows.
- Multi-provider consensus, ebook availability, rating, and rating count may break close ties.
- Down-rank obvious derivatives when the query is for the original: summary, analysis, study guide, workbook, notebook, interpretation, collection/box set/omnibus, review, and companion.
- Ranking must be deterministic and stable for equal scores.
- Preserve deduplication and source links.

Focused fixtures must prove:

- `Dune` by Frank Herbert outranks criticism books titled `Dune`.
- `Project Hail Mary` outranks summaries, notebooks, and collections.
- `Kazuo Ishiguro` ranks novels authored by Kazuo Ishiguro above criticism titled `Kazuo Ishiguro`.
- Exact title/source consensus stays ahead of derivatives.
- A read/owned exact match remains present in explicit search.

Explicit Store search must send `hideRead=false`. Read/owned/on-device state appears as a badge instead of suppressing the result. Home/browse retain the user's hide-read preference.

### Slice 2: faster first results

Remove the mandatory second Hardcover editions GraphQL request from the interactive search critical path.

- Map ISBN/page/ebook fields already present in the search document (`isbns`, `pages`, `has_ebook`, embedded default editions) without a follow-up query.
- Search must require exactly one Hardcover network call in focused tests.
- Do not change richer browse/detail paths that genuinely need edition hydration.
- Continue running Hardcover and StoryGraph concurrently with partial-provider resilience.
- Add duration instrumentation using the repository log convention for Store search, with total duration and per-source result counts; no query text or credentials in logs.
- Do not add sleeps, retries, or a cache to make tests/benchmarks look fast.

Live acceptance target after deployment: median of three localhost searches for `Project Hail Mary` is materially lower than the measured 1.95 s combined baseline, with a target <=1.3 s when providers are healthy. If the external provider itself prevents the numeric target, report the measured breakdown honestly; do not fake or hide provider results.

### Slice 3: native Store index and search lifecycle

Replace shelf-as-page Store home with a native list index rendered through the existing catalog menu stack.

Index requirements, in this order:

1. `Search books` - prominent first row.
2. `For You` when available.
3. `Trending this week`.
4. `Up Next in Your Series` when available.
5. Provider tracker shelves with concise provider labels.
6. `Browse genres` leading to native genre rows.
7. `Downloads` / acquisition queue with an active count when non-zero.

Each shelf row opens an existing cover grid/list page containing that shelf's books. Home itself must not show `Page 1 of N` or force horizontal shelf paging. It should make all browse paths legible in one screen or ordinary vertical menu pages.

Search requirements:

- Use KOReader's native input dialog, titled simply `Search books` with hint `Title, author, or ISBN`.
- Persist up to five recent non-empty queries in plugin settings, deduplicated most-recent-first.
- Show recent searches as native rows beneath `Search books`; selecting one reruns it.
- Search result subtitle reports result count and concise partial-provider status, not raw API wording.
- Empty search shows a clear native empty state with `Search again`, not a blank grid.
- Back returns to the Store index with its focus preserved.
- Search and all shelf transitions remain generation guarded.
- Touch and D-pad must both reach Search, shelves, result books, Back, and acquisition actions.

Use the cached whole home payload as the index source. Opening Store while connected paints cached index immediately, then refreshes in place. Offline cached index is explicitly labeled.

### Slice 4: native result and detail hierarchy

Improve external result cards/detail using existing widgets and detail owner only.

- Mosaic/list cards show title and primary author reliably; status badge remains concise.
- External detail's first visible action is explicit: `Get`, `Download`, `Open`, or `On device` according to state. Do not use vague `Get & explore` language.
- Primary action must be a large native row/button reachable first by D-pad.
- Follow with `Description`, `More by <author>`, `Similar books`, and one genre browse action when available.
- Group secondary metadata into at most two concise lines: series/year/pages/language and rating/provider.
- Hide empty cover/metadata placeholders instead of rendering `No cover` or empty admin fields.
- Remove irrelevant `Book 1 of 1`/catalog-pagination chrome from a standalone external detail.
- Preserve existing acquisition confirmation, source/destination selection, queue, Get-and-Open, owned-book handoff, and local download/open lifecycle.

### Slice 5: release and real rendering

- Bump plugin from 1.7.2 to 1.8.0 in `main.lua`, package/source assertions, emulator fixture, and Store gates.
- Add emulator scenarios `store-index`, `store-search-results`, and updated `store-detail` that use deterministic mock data.
- Capture and inspect 600x800 and 758x1024 screenshots.
- Request logs must prove the intended index/search/detail routes were reached.
- No clipping, blank dominant canvas, orphaned overlays, or zero-height content.
- D-pad-only emulator pass must reach Store index -> Search or shelf -> book -> primary action.

## Acceptance ledger

### Done

- Existing Store acquisition, queue, safety, cache, and direct menu entry are already implemented and must be preserved.

### Missing

- Ranked cross-provider search.
- Search that does not hide exact read/owned books.
- One-call Hardcover search critical path.
- Native Store index instead of shelf pagination.
- Recent search lifecycle and useful empty/partial states.
- Clear result/detail primary-action hierarchy.
- 1.8.0 release and real emulator proof.

### Verified only when

1. `bash scripts/verify-koreader-store-ux.sh` prints `KOReader Store UX gate: PASS`.
2. Existing `scripts/verify-koreader-store-phase2.sh` remains green.
3. Focused search ranking/provider-call tests and all Store Lua specs pass.
4. Server typecheck, touched ESLint/Prettier, all Lua 5.1 syntax checks pass.
5. Emulator artifacts and mock request logs prove index/search/detail reachability at both target sizes.
6. One adversarial review of the integrated diff finds no concrete reachable defect after fixes, followed by one confirmation review.
7. Every slice is committed; tracked tree is clean. `.autoloop/` and `.hermes/` remain untracked runtime evidence and are not committed.

## Review bounds

One integrated adversarial review. Fix concrete defects in the accepted path. One confirmation review. If a reviewer requests a second Store app, new endpoint family, persistent search cache, or direct provider calls from the device, reject it via the ownership gate.

## Deployment

Do not deploy from AutoLoop. Parent Hermes independently verifies exact commits, builds a commit-tagged image, backs up env/database, deploys, verifies health/migrations, checks both public front doors, fetches the live 1.8.0 plugin ZIP, and performs live ranked-search timing and result-order probes. Physical-device feel remains a final hardware gate even after emulator proof.
