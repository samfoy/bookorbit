import { describe, expect, it } from 'vitest'

import type { Library } from '@bookorbit/types'

import { resolveDefaultPhysicalLibrary, shouldPromptForLibrary } from '../default-library'

function lib(over: Partial<Library> & { id: number; name: string }): Library {
  return {
    displayOrder: 0,
    coverAspectRatio: '2/3',
    watch: false,
    metadataPrecedence: [],
    formatPriority: [],
    allowedFormats: [],
    organizationMode: 'book_per_folder',
    excludePatterns: [],
    readingThreshold: 0.25,
    markAsFinishedPercentComplete: 98,
    fileWriteEnabled: false,
    fileWriteWriteCover: true,
    fileWriteEpubEnabled: true,
    fileWriteEpubMaxFileSizeMb: 100,
    fileWriteFb2Enabled: false,
    fileWriteFb2MaxFileSizeMb: 100,
    fileWritePdfEnabled: true,
    fileWritePdfMaxFileSizeMb: 100,
    fileWriteCbxEnabled: false,
    fileWriteCbxMaxFileSizeMb: 500,
    fileWriteKindleEnabled: false,
    fileWriteKindleMaxFileSizeMb: 100,
    fileWriteAudioEnabled: true,
    fileWriteAudioMaxFileSizeMb: 500,
    fileRenameEnabled: false,
    folders: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Library
}

describe('resolveDefaultPhysicalLibrary', () => {
  it('returns null with no libraries', () => {
    expect(resolveDefaultPhysicalLibrary([])).toBeNull()
  })

  it('prefers the library that already holds physical books', () => {
    const picked = resolveDefaultPhysicalLibrary([
      lib({ id: 1, name: 'Ebooks', bookCount: 500, physicalBookCount: 0 }),
      lib({ id: 2, name: 'Shelf B', bookCount: 3, physicalBookCount: 3 }),
    ])
    expect(picked?.id).toBe(2)
  })

  it('prefers the library with the MOST physical books when several qualify', () => {
    const picked = resolveDefaultPhysicalLibrary([
      lib({ id: 1, name: 'Upstairs', physicalBookCount: 2 }),
      lib({ id: 2, name: 'Downstairs', physicalBookCount: 9 }),
      lib({ id: 3, name: 'Ebooks', physicalBookCount: 0 }),
    ])
    expect(picked?.id).toBe(2)
  })

  /**
   * The case that makes option 1 usable at all: a just-created "Physical" library is
   * still empty, so a count-only rule would send the very first physical book into
   * the ebook library.
   */
  it('falls back to a physical-sounding NAME when no library has physical books yet', () => {
    const picked = resolveDefaultPhysicalLibrary([
      lib({ id: 1, name: 'Ebooks', bookCount: 562, physicalBookCount: 0 }),
      lib({ id: 2, name: 'Physical', bookCount: 0, physicalBookCount: 0 }),
    ])
    expect(picked?.id).toBe(2)
  })

  it('matches other physical-shelf phrasings', () => {
    for (const name of ['Print', 'Paper books', 'Hardcopy', 'My Shelves']) {
      const picked = resolveDefaultPhysicalLibrary([
        lib({ id: 1, name: 'Ebooks' }),
        lib({ id: 2, name }),
      ])
      expect(picked?.id).toBe(2)
    }
  })

  it('does not match a name that merely contains a substring', () => {
    // 'Shelfless' should not count as a shelf; the pattern is word-bounded.
    const picked = resolveDefaultPhysicalLibrary([
      lib({ id: 1, name: 'Ebooks' }),
      lib({ id: 2, name: 'Shelfless Archive' }),
    ])
    expect(picked).toBeNull()
  })

  it('uses the only library when there is exactly one', () => {
    const picked = resolveDefaultPhysicalLibrary([lib({ id: 7, name: 'Everything' })])
    expect(picked?.id).toBe(7)
  })

  it('returns null when several libraries exist and none is an obvious shelf', () => {
    expect(
      resolveDefaultPhysicalLibrary([
        lib({ id: 1, name: 'Ebooks' }),
        lib({ id: 2, name: 'Comics' }),
      ]),
    ).toBeNull()
  })

  it('breaks ties stably on displayOrder then id, not array order', () => {
    const a = lib({ id: 9, name: 'Physical A', displayOrder: 5 })
    const b = lib({ id: 3, name: 'Physical B', displayOrder: 1 })
    expect(resolveDefaultPhysicalLibrary([a, b])?.id).toBe(3)
    expect(resolveDefaultPhysicalLibrary([b, a])?.id).toBe(3)
  })

  it('treats a missing physicalBookCount as zero rather than throwing', () => {
    const picked = resolveDefaultPhysicalLibrary([
      lib({ id: 1, name: 'Ebooks' }),
      lib({ id: 2, name: 'Physical' }),
    ])
    expect(picked?.id).toBe(2)
  })
})

describe('shouldPromptForLibrary', () => {
  it('does not prompt when a default can be resolved', () => {
    expect(
      shouldPromptForLibrary([
        lib({ id: 1, name: 'Ebooks' }),
        lib({ id: 2, name: 'Physical' }),
      ]),
    ).toBe(false)
  })

  it('prompts when the guess would be wrong', () => {
    expect(
      shouldPromptForLibrary([
        lib({ id: 1, name: 'Ebooks' }),
        lib({ id: 2, name: 'Comics' }),
      ]),
    ).toBe(true)
  })

  it('does not prompt for a single library', () => {
    expect(shouldPromptForLibrary([lib({ id: 1, name: 'Only' })])).toBe(false)
  })
})
