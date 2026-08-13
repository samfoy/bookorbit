import type { Library } from '@bookorbit/types'

/**
 * Pick the default library for a new physical book.
 *
 * Rule, in order:
 *   1. The library that already holds physical books (most of them, if several do).
 *   2. Otherwise a library whose name looks like a physical shelf, so a freshly
 *      created "Physical" library is chosen before it holds anything -- without
 *      that, the very first add would land in the ebook library.
 *   3. Otherwise the only library, when there is exactly one.
 *   4. Otherwise null, meaning the caller must ask.
 *
 * Ties break on displayOrder then id so the choice is stable across reloads
 * rather than depending on array order.
 */

const PHYSICAL_NAME_PATTERN = /\b(physical|print|paper|hardcopy|hard copy|shelf|shelves)\b/i

function byDisplayOrderThenId(a: Library, b: Library): number {
  const orderA = a.displayOrder ?? 0
  const orderB = b.displayOrder ?? 0
  if (orderA !== orderB) return orderA - orderB
  return a.id - b.id
}

export function resolveDefaultPhysicalLibrary(libraries: Library[]): Library | null {
  if (!libraries.length) return null

  const withPhysical = libraries.filter((l) => (l.physicalBookCount ?? 0) > 0)
  if (withPhysical.length > 0) {
    // Most physical books wins; ties fall back to a stable order.
    const [best] = [...withPhysical].sort((a, b) => {
      const diff = (b.physicalBookCount ?? 0) - (a.physicalBookCount ?? 0)
      return diff !== 0 ? diff : byDisplayOrderThenId(a, b)
    })
    return best ?? null
  }

  const namedPhysical = libraries.filter((l) => PHYSICAL_NAME_PATTERN.test(l.name ?? ''))
  if (namedPhysical.length > 0) return [...namedPhysical].sort(byDisplayOrderThenId)[0] ?? null

  if (libraries.length === 1) return libraries[0] ?? null

  return null
}

/**
 * Whether the caller should show a library picker.
 *
 * True when more than one library exists AND none is an obvious physical shelf --
 * i.e. exactly the case where guessing would be wrong.
 */
export function shouldPromptForLibrary(libraries: Library[]): boolean {
  return libraries.length > 1 && resolveDefaultPhysicalLibrary(libraries) === null
}
