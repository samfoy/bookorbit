# Mobile discovery polish

## Goal

Make the existing `/discover` search, browse, read-filter, acquisition, and queue flows feel native and efficient on phone-sized BookOrbit layouts, then verify and deploy the result.

## Ownership and scope

- Client-only refinement inside `client/src/features/discovery/` and English discovery locale strings.
- Preserve the existing Hardcover/StoryGraph browse APIs, read filtering, acquisition jobs, permissions, and UploadService pipeline.
- Do not add a service, endpoint, schema, state store, design system, or dependency.
- Preserve desktop behavior while adding purposeful phone layouts.

## Required mobile behavior

1. At 390 x 844 and 360 x 800, the first screen presents a compact title and a usable search control without the hero consuming nearly the entire viewport.
2. Search input and submit action remain at least 44 px tall; source selectors and the read-filter control are easy to tap and stay logically grouped with discovery controls.
3. Browse-home genre controls are horizontally scrollable or compact rather than a tall multi-row wall.
4. Every horizontal shelf has an obvious swipe affordance, edge preview, snap behavior, and no page-level horizontal overflow.
5. Shelf cards use a mobile-specific compact presentation so at least one complete card action row is reachable without a very tall card. Grid/search results remain readable and use the full phone width.
6. Author, genre, similar, source, and acquisition actions have accessible names and touch targets of roughly 44 px where practical.
7. The acquisition sheet works as a bottom-sheet-like full-height phone flow: content scrolls, controls are 44 px or taller, and the confirm action stays reachable above mobile safe areas and the virtual keyboard.
8. Acquisition queue rows wrap cleanly on narrow screens, retain status/error information, and expose a 44 px cancel target.
9. Active browse headers, result counts, load-more, loading, error, and empty states fit at 360 px with no clipping or page-level overflow.
10. No JavaScript console errors during browse home, genre browse, similar browse, acquisition-sheet open/close, and read-filter toggling.

## Test-driven implementation

- Add failing component/view tests before each behavior change and run each focused test red then green.
- Prefer semantic/data-testid assertions for mobile-specific structure, touch target classes, and compact card mode.
- Keep event handlers as named method references per `AGENTS.md`.

## Acceptance

- Focused discovery tests pass.
- Client `vue-tsc --build`, oxlint, ESLint, Prettier, style validation, and production client build pass under Node 24.
- Browser QA passes at 390 x 844 and 360 x 800 for home, paginated browse, and acquisition sheet with zero page-level horizontal overflow and zero console errors.
- Desktop smoke test remains sound.
- Final diff contains no em dashes and no unrelated files.
- Commit the verified implementation without a `Co-authored-by` trailer. Do not deploy from inside AutoLoop; the parent Hermes session owns independent verification, image build, backup, deployment, and public checks.
