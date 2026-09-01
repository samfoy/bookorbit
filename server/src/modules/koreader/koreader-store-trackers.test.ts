import { describe, expect, it, vi } from 'vitest';

import { HardcoverTrackerService } from '../hardcover/hardcover-tracker.service';
import { StorygraphTrackerService } from '../storygraph/storygraph-tracker.service';

const book = {
  id: 'hardcover:10',
  title: 'Piranesi',
  authors: ['Susanna Clarke'],
  coverUrl: null,
  description: null,
  publishedYear: 2020,
  rating: 4.5,
  ratingsCount: 1,
  isbn10: null,
  isbn13: null,
  pageCount: 272,
  seriesName: null,
  seriesPosition: null,
  hasEbook: true,
  genres: [],
  sources: [{ source: 'hardcover', externalId: '10', url: 'https://hardcover.app/books/10' }],
} as const;

describe('provider tracker shelves', () => {
  it('loads bounded Hardcover Want to Read and Currently Reading IDs through provider ownership', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ me: [{ user_books: [{ book_id: 10 }] }] })
        .mockResolvedValueOnce({ me: [{ user_books: [] }] }),
    };
    const settings = { getTokenForUser: vi.fn().mockResolvedValue('token') };
    const browse = { getBooksByIds: vi.fn().mockResolvedValue([book]) };
    const service = new HardcoverTrackerService(client as never, settings as never, browse as never);

    const shelves = await service.getShelves(7);

    expect(shelves[0]).toEqual(expect.objectContaining({ id: 'hardcover-want-to-read', available: true, items: [book] }));
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(browse.getBooksByIds).toHaveBeenCalledWith(7, [10]);
    expect(shelves.at(-1)).toEqual(expect.objectContaining({ id: 'hardcover-custom-lists', available: false }));
  });

  it('parses authenticated StoryGraph tracker pages and reports challenges unavailable honestly', async () => {
    const html = `<div class="book-pane"><div class="book-title-author-and-series"><a href="/books/abc">Piranesi</a></div><a href="/authors/susanna">Susanna Clarke</a></div>`;
    const client = { get: vi.fn().mockResolvedValue({ status: 200, html, redirectedToSignIn: false }) };
    const settings = { getCookiesForUser: vi.fn().mockResolvedValue({ sessionCookie: 's', rememberToken: 'r' }) };
    const catalog = { parseBooks: vi.fn().mockReturnValue([{ ...book, id: 'storygraph:abc', sources: [] }]) };
    const service = new StorygraphTrackerService(client as never, settings as never, catalog as never);

    const shelves = await service.getShelves(7);

    expect(shelves.filter((shelf) => shelf.available)).toHaveLength(3);
    expect(shelves.find((shelf) => shelf.id === 'storygraph-challenges')).toEqual(expect.objectContaining({ available: false }));
    expect(client.get).toHaveBeenCalledWith(7, expect.anything(), '/to-read');
  });
});
