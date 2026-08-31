import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HardcoverCatalogService } from './hardcover-catalog.service';
import { HardcoverCatalogBrowseService } from './hardcover-catalog-browse.service';

const mockClient = { query: vi.fn() };
const mockSettings = { getTokenForUser: vi.fn() };

function makeService() {
  const catalog = new HardcoverCatalogService(mockClient as never, mockSettings as never);
  return new HardcoverCatalogBrowseService(mockClient as never, mockSettings as never, catalog);
}

function book(id: number, title: string, genres: Array<{ tag: string; tagSlug: string }>, author = 'Author One') {
  return {
    id,
    title,
    slug: title.toLowerCase().replaceAll(' ', '-'),
    description: `${title} description`,
    pages: 320,
    rating: 4.2,
    ratings_count: 500,
    release_year: 2025,
    users_count: 900,
    cached_tags: { Genre: genres },
    cached_contributors: [{ author: { id: 8, name: author }, contribution: null }],
    cached_featured_series: {},
    image: { url: `https://covers.example/${id}.jpg` },
    default_ebook_edition: { isbn_10: '123456789X', isbn_13: `978000000${String(id).padStart(4, '0')}`.slice(0, 13), pages: 300 },
    default_physical_edition: null,
  };
}

const fantasy = { tag: 'Fantasy', tagSlug: 'fantasy' };
const mystery = { tag: 'Mystery', tagSlug: 'mystery' };

describe('HardcoverCatalogService browse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.getTokenForUser.mockResolvedValue('stored-token');
  });

  it('builds auto-updating trending and genre shelves from one ranked snapshot', async () => {
    mockClient.query
      .mockResolvedValueOnce({ books_trending: { ids: [1, 2, 3], error: null } })
      .mockResolvedValueOnce({ books: [book(3, 'Mystery Book', [mystery]), book(1, 'Fantasy One', [fantasy]), book(2, 'Fantasy Two', [fantasy])] });

    const result = await makeService().getBrowseHome(7);

    expect(mockClient.query).toHaveBeenNthCalledWith(1, 7, 'stored-token', expect.stringContaining('books_trending'), expect.any(Object));
    expect(result.trending.items.map((item) => item.title)).toEqual(['Fantasy One', 'Fantasy Two', 'Mystery Book']);
    expect(result.genreShelves.find((section) => section.value === 'fantasy')?.items.map((item) => item.title)).toEqual([
      'Fantasy One',
      'Fantasy Two',
    ]);
    expect(result.genres).toContainEqual({ name: 'Fantasy', slug: 'fantasy' });
  });

  it('paginates a genre browse and reports more results', async () => {
    mockClient.query.mockResolvedValueOnce({
      books: [book(1, 'Fantasy One', [fantasy]), book(2, 'Fantasy Two', [fantasy]), book(3, 'Fantasy Three', [fantasy])],
    });

    const result = await makeService().browse(7, { kind: 'genre', value: 'fantasy', page: 1, pageSize: 2 });

    expect(result).toMatchObject({ kind: 'genre', value: 'fantasy', page: 1, pageSize: 2, hasMore: true });
    expect(result.items.map((item) => item.title)).toEqual(['Fantasy One', 'Fantasy Two']);
    expect(mockClient.query).toHaveBeenCalledWith(
      7,
      'stored-token',
      expect.stringContaining('cached_tags'),
      expect.objectContaining({ filter: { Genre: [{ tagSlug: 'fantasy' }] }, limit: 3, offset: 0 }),
    );
  });

  it('resolves an author id then pages that authors books', async () => {
    mockClient.query
      .mockResolvedValueOnce({ search: { results: { hits: [{ document: { id: '88', name: 'Ursula K. Le Guin' } }] } } })
      .mockResolvedValueOnce({ books: [book(4, 'The Dispossessed', [{ tag: 'Science Fiction', tagSlug: 'science-fiction' }], 'Ursula K. Le Guin')] });

    const result = await makeService().browse(7, { kind: 'author', value: 'Ursula K. Le Guin', page: 1, pageSize: 12 });

    expect(result.title).toBe('Books by Ursula K. Le Guin');
    expect(result.items[0]?.authors).toEqual(['Ursula K. Le Guin']);
    expect(mockClient.query).toHaveBeenNthCalledWith(
      2,
      7,
      'stored-token',
      expect.stringContaining('author_id'),
      expect.objectContaining({ authorId: 88 }),
    );
  });

  it('preserves Hardcover similar-book ranking across pages', async () => {
    mockClient.query
      .mockResolvedValueOnce({ books: [{ id: 10, title: 'Seed', cached_similar_book_ids: [3, 1, 2] }] })
      .mockResolvedValueOnce({ books: [book(1, 'First Similar', [fantasy]), book(3, 'Top Similar', [mystery])] });

    const result = await makeService().browse(7, { kind: 'similar', value: '10', page: 1, pageSize: 2 });

    expect(result.title).toBe('More like Seed');
    expect(result.items.map((item) => item.title)).toEqual(['Top Similar', 'First Similar']);
    expect(result.hasMore).toBe(true);
  });
});
