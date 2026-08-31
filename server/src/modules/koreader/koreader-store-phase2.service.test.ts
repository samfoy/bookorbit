import type { ExternalBookSearchResult } from '@bookorbit/types';
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { makeRequestUser } from '../upload/test-helpers';
import { KoreaderStorePhase2Service, matchStoreState, type StoreStateCandidate } from './koreader-store-phase2.service';

const dialect = new PgDialect();
const user = makeRequestUser({ id: 17 });

function result(overrides: Partial<ExternalBookSearchResult> = {}): ExternalBookSearchResult {
  return {
    id: 'hardcover:10',
    title: 'Piranesi',
    authors: ['Susanna Clarke'],
    coverUrl: null,
    description: null,
    publishedYear: 2020,
    rating: null,
    ratingsCount: null,
    isbn10: '163557563X',
    isbn13: '9781635575637',
    pageCount: 272,
    seriesName: null,
    seriesPosition: null,
    hasEbook: true,
    genres: [],
    sources: [{ source: 'hardcover', externalId: '10', url: 'https://hardcover.app/books/10' }],
    ...overrides,
  };
}

function candidate(overrides: Partial<StoreStateCandidate> = {}): StoreStateCandidate {
  return {
    bookId: 42,
    isbn10: null,
    isbn13: null,
    title: 'Piranesi',
    primaryAuthor: 'Susanna Clarke',
    formats: ['epub'],
    bookOrbitStatus: 'reading',
    progress: 35,
    hardcoverBookId: null,
    hardcoverStatus: null,
    storygraphBookId: null,
    storygraphStatus: null,
    ...overrides,
  };
}

describe('matchStoreState', () => {
  it('matches ISBN-13 before ISBN-10, pinned provider id, and normalized title/author', () => {
    const matched = matchStoreState(result(), [
      candidate({ bookId: 1, isbn10: '163557563X' }),
      candidate({ bookId: 2, hardcoverBookId: '10' }),
      candidate({ bookId: 3, title: 'Píranesi!', primaryAuthor: 'Susanna  Clarke' }),
      candidate({ bookId: 4, isbn13: '978-1-63557-563-7' }),
    ]);

    expect(matched.bookId).toBe(4);
  });

  it('falls through ISBN-10, pinned provider id, then normalized title plus primary author', () => {
    expect(matchStoreState(result({ isbn13: null }), [candidate({ bookId: 1, isbn10: '1-63557-563-X' })]).bookId).toBe(1);
    expect(matchStoreState(result({ isbn10: null, isbn13: null }), [candidate({ bookId: 2, hardcoverBookId: '10' })]).bookId).toBe(2);
    expect(
      matchStoreState(result({ isbn10: null, isbn13: null, sources: [] }), [
        candidate({ bookId: 3, title: 'Píranesi!', primaryAuthor: 'Susanna  Clarke' }),
      ]).bookId,
    ).toBe(3);
    expect(matchStoreState(result({ isbn10: null, isbn13: null, sources: [] }), [candidate({ primaryAuthor: 'Another Author' })]).inBookOrbit).toBe(
      false,
    );
  });

  it('derives owned/read state, bounded formats, progress, and partial provider statuses', () => {
    const matched = matchStoreState(result(), [
      candidate({
        isbn13: '9781635575637',
        formats: ['pdf', 'epub', 'epub', 'mobi', 'azw3', 'fb2', 'kepub'],
        bookOrbitStatus: 'read',
        progress: 100,
        hardcoverStatus: 'read',
        storygraphStatus: null,
      }),
    ]);

    expect(matched).toEqual({
      inBookOrbit: true,
      bookId: 42,
      localFormats: ['azw3', 'epub', 'fb2', 'kepub', 'mobi', 'pdf'],
      bookOrbitStatus: 'read',
      progressPercentage: 100,
      hardcoverStatus: 'read',
      storygraphStatus: null,
      alreadyRead: true,
      alreadyOwned: true,
    });
  });

  it('derives read state from an authoritative provider when the local status is not finished', () => {
    const matched = matchStoreState(result(), [candidate({ isbn13: '9781635575637', bookOrbitStatus: 'want_to_read', storygraphStatus: 'read' })]);
    expect(matched.alreadyRead).toBe(true);
  });
});

describe('KoreaderStorePhase2Service', () => {
  it('loads a bounded candidate projection only from libraries visible to the authenticated user', async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [candidate({ isbn13: '9781635575637' })] }) };
    const libraries = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([3, 9]) };
    const service = new KoreaderStorePhase2Service(db as never, libraries as never);

    const enriched = await service.enrichResults(user, [result()]);

    expect(enriched[0]?.state.bookId).toBe(42);
    expect(libraries.findAccessibleLibraryIds).toHaveBeenCalledWith(user);
    const query = dialect.sqlToQuery(db.execute.mock.calls[0]?.[0] as SQL);
    expect(query.params).toEqual(expect.arrayContaining([3, 9, 17]));
    expect(query.sql.toLowerCase()).toContain('limit');
  });

  it('does not query or claim ownership when the user has no accessible libraries', async () => {
    const db = { execute: vi.fn() };
    const libraries = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([]) };
    const service = new KoreaderStorePhase2Service(db as never, libraries as never);

    const enriched = await service.enrichResults(user, [result()]);

    expect(db.execute).not.toHaveBeenCalled();
    expect(enriched[0]?.state).toEqual(expect.objectContaining({ inBookOrbit: false, alreadyOwned: false, alreadyRead: false }));
  });
});
