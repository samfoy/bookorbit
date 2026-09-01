# KOReader Store performance

## Goal

Make the native KOReader Book Store feel immediate on repeat opens and materially reduce first-load cover latency without adding a new service, route, schema, dependency, cache subsystem, or transport.

## Classification and ownership

This is a bounded performance repair on the completed Store implementation on branch `BO-external-book-discovery`.

Existing owners must remain the owners:

- `bookorbit_store.lua` owns Store home navigation and its persisted home payload.
- `KoreaderStoreService` owns Store response assembly and safe external cover proxying.
- `bookorbit_catalog_thumbnails.lua` owns the device cover queue and on-disk cache.
- Existing Hardcover and StoryGraph tracker services own their provider calls.

Do not add a new endpoint, provider client, service, database table, sidecar, transport, dependency, or persistent server cache. Reuse the existing home payload, cover endpoint, and thumbnail lifecycle.

## Root-cause evidence

1. `Store:loadStoreHome` reads `store_home_cache` only when offline. While connected, it blocks before showing any Store page.
2. `KoreaderStoreService.getHome` starts tracker calls only after base browse and result enrichment complete. It then calls `phase2.enrichResults` once per tracker shelf.
3. `HardcoverTrackerService.getShelves` loops over two independent definitions serially. `StorygraphTrackerService.getShelves` loops over three independent definitions serially.
4. The device thumbnail worker intentionally owns one subprocess per batch, but downloads the three covers in that child serially. Do not replace this with unsafe nested forking.
5. `KoreaderStoreService.streamCover` safely fetches and validates each remote image but neither resizes nor deduplicates/cache-hits repeated URLs. `sharp` already exists in `server/package.json`.

## Required behavior and TDD slices

Use strict RED-GREEN-REFACTOR. For every slice, add one focused test and run it to see the intended failure before production edits.

### Slice 1: instant cached Store home with in-place refresh

When `store_home_cache` exists, opening or reloading Store home while connected must:

1. Render cached shelves synchronously before entering the connected/network callback.
2. Mark that first render as stale or refreshing so the user is not misled.
3. Fetch fresh home data in the background through the existing request-generation guard.
4. Replace the cached page in place without pushing a duplicate navigation entry.
5. Persist the fresh payload.
6. Preserve current offline fallback, retry, acquisition resume, and stale-response behavior.

A Lua regression test must prove that cached content is switched to before the deferred connected callback runs and that fresh content later replaces it with `push=false`.

### Slice 2: overlap bounded Store home work

In `KoreaderStoreService.getHome`:

1. Start Hardcover and StoryGraph tracker promises before awaiting the base Hardcover browse work, so independent provider latency overlaps.
2. Preserve partial-shelf semantics via `Promise.allSettled` or equivalent.
3. Flatten all available tracker shelf items, call `phase2.enrichResults` once for that combined bounded list, then slice the enriched results back into the original shelves in order.
4. Do not change payload contracts, permissions, hide-read behavior, shelf ordering, or per-user scoping.

Tests must prove tracker work starts while base browse is unresolved and multiple tracker shelves require one combined enrichment call, not one call per shelf.

### Slice 3: bounded parallel tracker definitions

Run the two Hardcover tracker definitions concurrently and the three StoryGraph definitions concurrently. Concurrency is statically bounded by those definition arrays. Keep each shelf independently failure-tolerant and preserve deterministic output order. Do not raise provider result limits or add retries.

Tests must use deferred promises to prove all definition requests start before the first resolves, preserve order, and retain unavailable placeholders on individual failure.

### Slice 4: existing cover endpoint becomes a bounded thumbnail cache

Improve `KoreaderStoreService.streamCover` without a new service or route:

1. Extract one internal load path used by both requests and prewarming.
2. Keep the existing safe-redirect, content-type, maximum-byte, and image-signature validation before processing.
3. Use the existing `sharp` dependency to normalize remote covers to a device-appropriate JPEG thumbnail, maximum width 360 px, no enlargement, metadata removed, bounded quality. Return `image/jpeg`.
4. Add an in-memory, per-process LRU owned directly by `KoreaderStoreService`, keyed by the exact validated URL. Bound it by both entry count and total encoded bytes. Target limits: at most 128 entries and at most 48 MiB. TTL may be up to 24 hours.
5. Add an in-flight promise map so concurrent requests for one URL perform exactly one remote fetch and one resize. Always clear the in-flight entry on success and failure.
6. On a Store home response, fire-and-forget prewarm only the first visible shelf's first six valid HTTPS cover URLs through the same load path. Never await prewarming, never prewarm all shelves, and swallow/log per-cover failures without failing home.
7. Do not cache failures or invalid images. Do not leak credentials to upstream cover hosts.
8. Keep the response cache header private.

Tests must prove:

- two concurrent `streamCover` calls for one URL perform one fetch and one sharp pipeline;
- a later call is served from cache without another fetch;
- a failed load is retried on the next call;
- LRU byte/entry bounds evict old items;
- home returns without awaiting prewarm and starts no more than six unique valid cover loads;
- oversized and signature-invalid inputs remain rejected;
- output is JPEG and no wider than 360 px, verified from real generated image bytes rather than only a sharp mock.

If importing `sharp` complicates unit tests, test the real transformer with a small generated PNG fixture and mock only network fetch.

## Non-goals

- No new cover batch route or archive format.
- No unsafe nested device subprocesses.
- No persistent server disk cache or schema.
- No changes to acquisition, local book downloads, or general BookOrbit web cover handling.
- No deployment in this run.

## Acceptance ledger

### Done only when

- repeat Store opens paint cached shelves before any network completion;
- independent home provider work overlaps;
- tracker state enrichment is one bounded combined query;
- tracker definitions are bounded-parallel and independently resilient;
- visible cover URLs begin server prewarming through an in-flight-deduplicated, bounded thumbnail LRU;
- output cover bytes are smaller device JPEG thumbnails with width at most 360 px;
- all old Store behavior remains green.

### Verification

Run from repository root:

```bash
bash scripts/verify-koreader-store-performance.sh
```

The script must print `KOReader Store performance gate: PASS`.

Review the final diff once for reachable correctness, security regression in URL fetching, unbounded memory/concurrency, and stale navigation behavior. Fix concrete findings, then run one confirmation review. Commit the coherent change with a conventional message and no co-author trailer.
