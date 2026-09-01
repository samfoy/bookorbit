import type { ExternalBookSearchResult } from '@bookorbit/types';
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { makeRequestUser } from '../upload/test-helpers';
import { buildPersonalizedForYou } from './koreader-store-personalization.service';
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

describe('buildPersonalizedForYou', () => {
  it('explains recommendations only with real author or genre evidence', () => {
    const candidates = [
      result({ id: 'hardcover:11', title: 'Jonathan Strange', authors: ['Susanna Clarke'], isbn10: null, isbn13: null }),
      result({
        id: 'hardcover:12',
        title: 'A Fantasy',
        authors: ['Someone Else'],
        isbn10: null,
        isbn13: null,
        genres: [{ name: 'Fantasy', slug: 'fantasy' }],
      }),
      result({ id: 'hardcover:13', title: 'Unrelated', authors: ['Nobody'], isbn10: null, isbn13: null, genres: [] }),
    ];
    const personalized = buildPersonalizedForYou(candidates, [
      { title: 'Piranesi', rating: 5, author: 'Susanna Clarke', genres: ['Fantasy'], seriesName: null },
    ]);
    expect(personalized.map((book) => book.recommendationReason)).toEqual(['More by Susanna Clarke', 'Fantasy matching your recent reading']);
    expect(personalized.some((book) => book.title === 'Unrelated')).toBe(false);
  });

  it('excludes books already read or owned and deduplicates by ISBN before title/author', () => {
    const empty = matchStoreState(result(), []);
    const first = result({ id: 'hardcover:21', isbn13: '9780000000001', state: empty });
    const duplicate = result({ id: 'storygraph:21', isbn13: '978-0-00000-000-1', state: empty });
    const read = result({ id: 'hardcover:22', isbn13: null, state: { ...empty, alreadyRead: true } });
    const personalized = buildPersonalizedForYou(
      [first, duplicate, read],
      [{ title: 'Piranesi', rating: 5, author: 'Susanna Clarke', genres: [], seriesName: null }],
    );
    expect(personalized).toHaveLength(1);
    expect(personalized[0]?.id).toBe('hardcover:21');
  });
});
