import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HardcoverCatalogService } from './hardcover-catalog.service';

const mockClient = {
  query: vi.fn(),
};

const mockSettings = {
  getTokenForUser: vi.fn(),
};

function makeService() {
  return new HardcoverCatalogService(mockClient as never, mockSettings as never);
}

function searchResponse(document: Record<string, unknown>) {
  return { search: { results: { hits: [{ document }] } } };
}

const duneDocument = {
  id: '312460',
  slug: 'dune',
  title: 'Dune',
  description: 'Set on the desert planet Arrakis.',
  author_names: ['Frank Herbert', 'Brian Herbert'],
  contributions: [
    { primary: true, contribution: 'Author', author: { name: 'Frank Herbert' } },
    { primary: false, contribution: 'Afterword', author: { name: 'Brian Herbert' } },
  ],
  image: { url: 'https://assets.hardcover.app/dune.jpg' },
  isbns: ['3-453-32198-7', '978-3-453-32198-4'],
  pages: 704,
  rating: 4.3244,
  ratings_count: 6436,
  release_year: 1965,
  has_ebook: true,
  cached_tags: {
    Genre: [{ tag: 'Science Fiction', tagSlug: 'science-fiction' }],
  },
  featured_series: { position: 1, series: { name: 'Dune' } },
};

describe('HardcoverCatalogService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.getTokenForUser.mockResolvedValue('stored-token');
  });

  it('maps authenticated Hardcover search hits with exactly one client query', async () => {
    mockClient.query.mockResolvedValueOnce(searchResponse(duneDocument));

    const result = await makeService().search(7, 'Dune');

    expect(mockClient.query).toHaveBeenCalledTimes(1);
    expect(mockClient.query).toHaveBeenNthCalledWith(1, 7, 'stored-token', expect.stringContaining('query SearchCatalog'), { query: 'Dune' });
    const query = mockClient.query.mock.calls[0]?.[2] as string;
    expect(query).not.toContain('fields:');
    expect(query).not.toContain('weights:');
    expect(result).toEqual([
      {
        id: 'hardcover:312460',
        title: 'Dune',
        authors: ['Frank Herbert'],
        coverUrl: 'https://assets.hardcover.app/dune.jpg',
        description: 'Set on the desert planet Arrakis.',
        publishedYear: 1965,
        rating: 4.3244,
        ratingsCount: 6436,
        isbn10: '3453321987',
        isbn13: '9783453321984',
        pageCount: 704,
        seriesName: 'Dune',
        seriesPosition: 1,
        hasEbook: true,
        genres: [{ name: 'Science Fiction', slug: 'science-fiction' }],
        sources: [
          {
            source: 'hardcover',
            externalId: '312460',
            url: 'https://hardcover.app/books/dune',
          },
        ],
      },
    ]);
  });

  it('never issues a follow-up editions query for search hits', async () => {
    mockClient.query.mockResolvedValueOnce(searchResponse(duneDocument));

    await makeService().search(7, 'Dune');

    const queries = mockClient.query.mock.calls.map((call) => call[2] as string);
    expect(queries.some((query) => query.includes('CatalogEditions'))).toBe(false);
  });

  it('prefers embedded default editions over the search isbns array', async () => {
    mockClient.query.mockResolvedValueOnce(
      searchResponse({
        ...duneDocument,
        pages: null,
        has_ebook: null,
        default_ebook_edition: { isbn_10: '0441013597', isbn_13: '9780441013593', pages: 604 },
        default_physical_edition: { isbn_10: '0441172717', isbn_13: '9780441172719', pages: 704 },
      }),
    );

    const [book] = await makeService().search(7, 'Dune');

    expect(mockClient.query).toHaveBeenCalledTimes(1);
    expect(book).toMatchObject({
      isbn10: '0441013597',
      isbn13: '9780441013593',
      pageCount: 704,
      hasEbook: true,
    });
  });

  it('returns no results without an enabled stored token', async () => {
    mockSettings.getTokenForUser.mockResolvedValue(null);

    await expect(makeService().search(7, 'Dune')).resolves.toEqual([]);
    expect(mockClient.query).not.toHaveBeenCalled();
  });
});
