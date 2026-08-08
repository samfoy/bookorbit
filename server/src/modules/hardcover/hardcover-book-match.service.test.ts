import { describe, it, expect, vi, beforeEach } from 'vitest';

import { HardcoverBookMatchService } from './hardcover-book-match.service';

const mockRepo = {
  findBookState: vi.fn(),
  upsertBookState: vi.fn(),
};

const mockClient = {
  query: vi.fn(),
};

function makeService() {
  return new HardcoverBookMatchService(mockRepo as any, mockClient as any);
}

const baseBook = {
  bookId: 42,
  isbn13: '9781234567890',
  isbn10: null,
  title: 'Test Book',
  authorName: 'Test Author',
  hardcoverMetadataId: null,
  status: 'reading',
  startedAt: null,
  finishedAt: null,
  rating: null,
  progress: null,
  pageCount: null,
  format: null,
  language: null,
};

describe('HardcoverBookMatchService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepo.upsertBookState.mockResolvedValue({});
  });

  it('returns cached match when state exists and no error', async () => {
    mockRepo.findBookState.mockResolvedValue({
      hardcoverBookId: 100,
      hardcoverEditionId: 200,
      matchError: null,
    });
    mockClient.query.mockResolvedValue({
      books: [{ id: 100, editions: [{ id: 200, pages: 320 }] }],
    });
    const result = await makeService().matchBook(1, 'tok', baseBook);
    expect(result).toEqual({ hardcoverBookId: 100, hardcoverEditionId: 200, editionPages: 320, matchMethod: 'cached' });
    expect(mockClient.query).toHaveBeenCalledTimes(1);
    expect(mockRepo.upsertBookState).not.toHaveBeenCalled();
  });

  it('keeps the cached edition even when it has no page count (no silent swap)', async () => {
    mockRepo.findBookState.mockResolvedValue({
      hardcoverBookId: 100,
      hardcoverEditionId: 200,
      matchError: null,
    });
    mockClient.query.mockResolvedValue({
      books: [
        {
          id: 100,
          editions: [
            { id: 200, pages: null, isbn_13: null, isbn_10: null, audio_seconds: null },
            { id: 201, pages: 544, isbn_13: null, isbn_10: null, audio_seconds: null },
          ],
        },
      ],
    });

    const result = await makeService().matchBook(1, 'tok', baseBook);

    expect(result).toEqual({ hardcoverBookId: 100, hardcoverEditionId: 200, editionPages: null, matchMethod: 'cached' });
    expect(mockRepo.upsertBookState).not.toHaveBeenCalled();
  });

  it('re-points a cached match when the cached edition no longer exists on Hardcover', async () => {
    mockRepo.findBookState.mockResolvedValue({
      hardcoverBookId: 100,
      hardcoverEditionId: 200,
      matchError: null,
    });
    mockClient.query.mockResolvedValue({
      books: [{ id: 100, editions: [{ id: 301, pages: 410, isbn_13: '9781234567890', isbn_10: null, audio_seconds: null }] }],
    });

    const result = await makeService().matchBook(1, 'tok', { ...baseBook, isbn13: '9781234567890', pageCount: 410 });

    expect(result?.hardcoverEditionId).toBe(301);
    expect(mockRepo.upsertBookState).toHaveBeenCalledWith(
      expect.objectContaining({ hardcoverBookId: 100, hardcoverEditionId: 301, matchMethod: 'cached' }),
    );
  });

  it('re-queries when cached state has match error', async () => {
    mockRepo.findBookState.mockResolvedValue({ hardcoverBookId: null, matchError: 'no_match' });
    mockClient.query.mockResolvedValue({ books: [{ id: 99, editions: [{ id: 55 }] }] });
    const result = await makeService().matchBook(1, 'tok', baseBook);
    expect(result?.hardcoverBookId).toBe(99);
    expect(result?.matchMethod).toBe('isbn');
  });

  it('matches by metadata_id when hardcoverMetadataId is set', async () => {
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query.mockResolvedValue({ books: [{ id: 77 }] });
    const book = { ...baseBook, hardcoverMetadataId: '77', isbn13: null };
    const result = await makeService().matchBook(1, 'tok', book);
    expect(result?.matchMethod).toBe('metadata_id');
    expect(result?.hardcoverBookId).toBe(77);
  });

  it('matches by metadata slug when hardcoverMetadataId is not numeric', async () => {
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query.mockResolvedValue({ books: [{ id: 686104, editions: [{ id: 30673405, pages: 382 }] }] });
    const book = { ...baseBook, hardcoverMetadataId: 'fyrebirds', isbn13: null };

    const result = await makeService().matchBook(1, 'tok', book);

    expect(result).toEqual({ hardcoverBookId: 686104, hardcoverEditionId: 30673405, editionPages: 382, matchMethod: 'metadata_id' });
    expect(mockClient.query).toHaveBeenCalledWith(
      1,
      'tok',
      expect.stringContaining('query FindBookBySlug'),
      expect.objectContaining({ slug: 'fyrebirds' }),
    );
  });

  it('falls back to isbn13 when metadata_id fails', async () => {
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query.mockRejectedValueOnce(new Error('not found')).mockResolvedValueOnce({ books: [{ id: 88, editions: [{ id: 11 }] }] });
    const book = { ...baseBook, hardcoverMetadataId: '99' };
    const result = await makeService().matchBook(1, 'tok', book);
    expect(result?.hardcoverBookId).toBe(88);
    expect(result?.matchMethod).toBe('isbn');
  });

  it('falls back to title+author when isbn fails', async () => {
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query
      .mockResolvedValueOnce({ books: [] })
      .mockResolvedValueOnce({ search: { ids: [123] } })
      .mockResolvedValueOnce({ books: [{ id: 123 }] });
    const result = await makeService().matchBook(1, 'tok', baseBook);
    expect(result?.matchMethod).toBe('title');
    expect(result?.hardcoverBookId).toBe(123);
    expect(mockClient.query).toHaveBeenNthCalledWith(
      2,
      1,
      'tok',
      expect.stringContaining('query SearchBooks'),
      expect.objectContaining({ query: 'Test Book Test Author' }),
    );
  });

  it('preserves Hardcover search ranking when hydrating title matches', async () => {
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query
      .mockResolvedValueOnce({ books: [] })
      .mockResolvedValueOnce({ search: { ids: [123, 456] } })
      .mockResolvedValueOnce({
        books: [
          { id: 456, editions: [{ id: 40 }] },
          { id: 123, editions: [{ id: 30 }] },
        ],
      });

    const result = await makeService().matchBook(1, 'tok', baseBook);

    expect(result).toEqual({ hardcoverBookId: 123, hardcoverEditionId: 30, editionPages: null, matchMethod: 'title' });
  });

  it('returns null and stores no_match when all strategies fail', async () => {
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query.mockResolvedValue({ books: [] });
    const result = await makeService().matchBook(1, 'tok', baseBook);
    expect(result).toBeNull();
    expect(mockRepo.upsertBookState).toHaveBeenCalledWith(expect.objectContaining({ matchError: 'no_match' }));
  });

  it('stores match result to cache on success', async () => {
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query.mockResolvedValue({ books: [{ id: 5, editions: [{ id: 6 }] }] });
    await makeService().matchBook(1, 'tok', baseBook);
    expect(mockRepo.upsertBookState).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        bookId: 42,
        hardcoverBookId: 5,
        hardcoverEditionId: 6,
        matchMethod: 'isbn',
      }),
    );
  });

  it('does not hardcode editions(limit: 1) on the metadata_id lookup', async () => {
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query.mockResolvedValue({ books: [{ id: 700, editions: [{ id: 901, pages: 512 }] }] });

    await makeService().matchBook(1, 'tok', { ...baseBook, hardcoverMetadataId: '700', isbn13: null, isbn10: null });

    const queryArg = mockClient.query.mock.calls[0][2] as string;
    expect(queryArg).toContain('query FindBookById');
    expect(queryArg).not.toContain('editions(limit: 1)');
  });

  it('selects the ISBN-matching edition on a metadata_id match instead of the first (audiobook) edition', async () => {
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query.mockResolvedValue({
      books: [
        {
          id: 700,
          editions: [
            { id: 900, pages: null, isbn_13: '9990000000000', isbn_10: null, audio_seconds: 36000 },
            { id: 901, pages: 512, isbn_13: '9781234567890', isbn_10: null, audio_seconds: null },
          ],
        },
      ],
    });

    const book = { ...baseBook, hardcoverMetadataId: '700', isbn13: '9781234567890', isbn10: null, pageCount: 512, format: 'epub' };
    const result = await makeService().matchBook(1, 'tok', book);

    expect(result).toEqual({ hardcoverBookId: 700, hardcoverEditionId: 901, editionPages: 512, matchMethod: 'metadata_id' });
  });

  it('selects the closest page-count, non-audiobook edition on a title match', async () => {
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query.mockResolvedValueOnce({ search: { ids: [123] } }).mockResolvedValueOnce({
      books: [
        {
          id: 123,
          editions: [
            { id: 800, pages: null, isbn_13: null, isbn_10: null, audio_seconds: 50000 },
            { id: 801, pages: 405, isbn_13: null, isbn_10: null, audio_seconds: null },
            { id: 802, pages: 980, isbn_13: null, isbn_10: null, audio_seconds: null },
          ],
        },
      ],
    });

    const book = { ...baseBook, isbn13: null, isbn10: null, pageCount: 400, format: 'epub' };
    const result = await makeService().matchBook(1, 'tok', book);

    expect(result).toEqual({ hardcoverBookId: 123, hardcoverEditionId: 801, editionPages: 405, matchMethod: 'title' });
  });

  it('prefers an English edition over a closer-page-count translation (Guards! Guards! regression)', async () => {
    // Real numbers from the live failure: a 377-page Catalan edition sat 1 page from the local
    // 376-page book and beat every English edition, so Hardcover tracked "Guàrdies! Guàrdies!".
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query.mockResolvedValueOnce({ search: { ids: [446212] } }).mockResolvedValueOnce({
      books: [
        {
          id: 446212,
          editions: [
            { id: 32181214, pages: 377, isbn_13: '9788412235616', isbn_10: null, audio_seconds: null, language_id: 27 },
            { id: 12591508, pages: 376, isbn_13: '9780061020643', isbn_10: null, audio_seconds: null, language_id: 1 },
          ],
        },
      ],
    });

    const book = { ...baseBook, isbn13: null, isbn10: null, pageCount: 376, format: 'epub', language: 'English' };
    const result = await makeService().matchBook(1, 'tok', book);

    expect(result.hardcoverEditionId).toBe(12591508);
  });

  it('prefers the English edition even when a translation is much closer on page count', async () => {
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query.mockResolvedValueOnce({ search: { ids: [446212] } }).mockResolvedValueOnce({
      books: [
        {
          id: 446212,
          editions: [
            { id: 900, pages: 376, isbn_13: null, isbn_10: null, audio_seconds: null, language_id: 148 },
            { id: 901, pages: 512, isbn_13: null, isbn_10: null, audio_seconds: null, language_id: 1 },
          ],
        },
      ],
    });

    const book = { ...baseBook, isbn13: null, isbn10: null, pageCount: 376, format: 'epub', language: 'en-US' };
    const result = await makeService().matchBook(1, 'tok', book);

    expect(result.hardcoverEditionId).toBe(901);
  });

  it('still honours an exact ISBN match even when the edition is a translation', async () => {
    // ISBN is a deliberate, specific signal: if the local file really IS the Spanish edition we
    // must not "correct" it to English. Routed via the metadata_id path so pickBestEdition runs
    // (a bare isbn13 uses the dedicated ISBN query, which returns the ISBN-filtered edition).
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query.mockResolvedValueOnce({
      books: [
        {
          id: 55,
          editions: [
            { id: 700, pages: 300, isbn_13: '9788497931861', isbn_10: null, audio_seconds: null, language_id: 148 },
            { id: 701, pages: 300, isbn_13: '9780061020643', isbn_10: null, audio_seconds: null, language_id: 1 },
          ],
        },
      ],
    });

    const book = {
      ...baseBook,
      isbn13: '9788497931861',
      isbn10: null,
      hardcoverMetadataId: '55',
      pageCount: 300,
      format: 'epub',
      language: 'Spanish; Castilian',
    };
    const result = await makeService().matchBook(1, 'tok', book);

    expect(result.hardcoverEditionId).toBe(700);
  });

  it('does not penalise editions with no language_id', async () => {
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query.mockResolvedValueOnce({ search: { ids: [77] } }).mockResolvedValueOnce({
      books: [
        {
          id: 77,
          editions: [
            { id: 810, pages: 400, isbn_13: null, isbn_10: null, audio_seconds: null, language_id: null },
            { id: 811, pages: 900, isbn_13: null, isbn_10: null, audio_seconds: null, language_id: 1 },
          ],
        },
      ],
    });

    const book = { ...baseBook, isbn13: null, isbn10: null, pageCount: 400, format: 'epub', language: 'en' };
    const result = await makeService().matchBook(1, 'tok', book);

    expect(result.hardcoverEditionId).toBe(810);
  });

  it('falls back to page ranking when the local language is unrecognised', async () => {
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query.mockResolvedValueOnce({ search: { ids: [88] } }).mockResolvedValueOnce({
      books: [
        {
          id: 88,
          editions: [
            { id: 820, pages: 401, isbn_13: null, isbn_10: null, audio_seconds: null, language_id: 47 },
            { id: 821, pages: 900, isbn_13: null, isbn_10: null, audio_seconds: null, language_id: 1 },
          ],
        },
      ],
    });

    const book = { ...baseBook, isbn13: null, isbn10: null, pageCount: 400, format: 'epub', language: 'und' };
    const result = await makeService().matchBook(1, 'tok', book);

    expect(result.hardcoverEditionId).toBe(820);
  });

  it('orders edition selection by reader count so popular editions survive truncation', async () => {
    // Guards! Guards! has 77 editions but the query fetches 50. Without an explicit order the
    // widely-read English edition was absent from the candidate set entirely.
    mockRepo.findBookState.mockResolvedValue(undefined);
    mockClient.query.mockResolvedValue({ books: [{ id: 700, editions: [{ id: 901, pages: 512, language_id: 1 }] }] });

    const book = { ...baseBook, isbn13: null, isbn10: null, hardcoverMetadataId: '700' };
    await makeService().matchBook(1, 'tok', book);

    // client.query(userId, token, query, variables) -> the GraphQL document is arg index 2.
    const queryArg = mockClient.query.mock.calls[0]![2];
    expect(queryArg).toContain('users_count: desc');
    expect(queryArg).toContain('language_id');
  });
});
