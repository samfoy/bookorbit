# External Book Discovery and Acquisition

## Classification

Active fork implementation. The branch already contains substantial, verified BookOrbit customizations. This feature extends existing owners and does not replace them.

## User acceptance ledger

| Criterion                                                                    | Initial state | Completion evidence                                                                                                                                              |
| ---------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search books outside the local library with the user's Hardcover credential  | Done          | Exact service returned live results with the existing token; default-edition ISBN enrichment and authenticated mapping tests pass                                |
| Search books outside the local library with the user's StoryGraph credential | Done          | Exact service returned 10 live results with the stored cookies; authenticated parsing and expired-session tests pass                                             |
| Provide a polished responsive in-app discovery UI                            | Done          | Client interaction tests, Vue typecheck, production build, desktop browser QA, and a 390 px layout-viewport check pass with no page overflow                     |
| Fetch an EPUB from inside BookOrbit using the proven LibGen workflow         | Done          | Disposable full-stack run completed search, fresh-key download, verification, UploadService import, book/file creation, and authenticated EPUB download          |
| Support Anna's Archive without duplicating credentials                       | Done          | Optional member API uses `ANNAS_ARCHIVE_SECRET_KEY`; capability is explicitly disabled when absent; every redirect hop is SSRF-checked                           |
| Preserve downloader safety checks                                            | Done          | ISBN-first lookup, wrong-title/volume, bundle, exact-author-token, corrupt EPUB, size ceiling, redirect safety, and UploadService collision behavior are covered |
| Keep new acquisitions correct on CrossInk/Xteink devices                     | Done          | Full-stack served EPUB contained a 2,227-byte `META-INF/x-locations.json` manifest with 974 locations; fragmented-spine regression passes                        |
| Enforce multi-user permissions and library access                            | Done          | Backend upload permission, library access, user-scoped jobs, cancellation boundaries, and per-user/global concurrency caps are tested                            |

## Ownership gate

- Hardcover remains the owner of its per-user token and authenticated API client.
- StoryGraph remains the owner of its per-user cookies and authenticated, throttled client.
- Upload remains the owner of file naming, collision prevention, library access, book creation, metadata extraction, and post-import processing.
- Book discovery is a thin coordinator because no existing provider can own a combined search and acquisition UI lifecycle. It gets one module, one HTTP surface, and no database tables.
- Acquisition progress is transient and bounded in memory. No queue service, sidecar, cache, synchronization path, or deployment is added.
- The Anna's Archive key is optional runtime config because the official fast-download API requires a membership key. The key is never returned to the client or written to BookOrbit's database.

## Active slice

Complete. All original criteria have implementation evidence and bounded verification.

## Verification boundary

Real Hardcover, StoryGraph, and LibGen traffic were exercised from this host. StoryGraph provider failures remain source-level partial failures rather than hiding successful Hardcover results. Anna's fast-download API is contract-tested and capability-tested; a real Anna's file download remains unexercised because no member key is configured.
