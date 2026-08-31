import type { ExternalBookSearchResult } from '@bookorbit/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BookDiscoveryService } from './book-discovery.service';

const hardcoverBook: ExternalBookSearchResult = {
  id: 'hardcover:1',
  title: 'Piranesi',
  authors: ['Susanna Clarke'],
  coverUrl: 'https://covers.example/piranesi.jpg',
  description: 'A labyrinth, a mystery, and an ocean.',
  publishedYear: 2020,
  rating: 4.2,
  ratingsCount: 1000,
  isbn10: null,
  isbn13: '9781635575637',
  pageCount: 272,
  seriesName: null,
  seriesPosition: null,
  hasEbook: true,
  genres: [{ name: 'Fantasy', slug: 'fantasy' }],
  sources: [{ source: 'hardcover', externalId: '1', url: 'https://hardcover.app/books/piranesi' }],
};

const storygraphBook: ExternalBookSearchResult = {
  id: 'storygraph:piranesi',
  title: 'Piranesi',
  authors: ['Susanna Clarke'],
  coverUrl: null,
  description: null,
  publishedYear: null,
  rating: null,
  ratingsCount: null,
  isbn10: null,
  isbn13: null,
  pageCount: null,
  seriesName: null,
  seriesPosition: null,
  hasEbook: null,
  genres: [],
  sources: [{ source: 'storygraph', externalId: 'piranesi', url: 'https://app.thestorygraph.com/books/piranesi' }],
};

const mockHardcoverCatalog = { search: vi.fn() };
const mockStorygraphCatalog = { search: vi.fn() };
const mockHardcoverSettings = { getSettings: vi.fn() };
const mockStorygraphSettings = { getSettings: vi.fn() };

function makeService() {
  return new BookDiscoveryService(
    mockHardcoverCatalog as never,
    mockStorygraphCatalog as never,
    mockHardcoverSettings as never,
    mockStorygraphSettings as never,
  );
}

describe('BookDiscoveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHardcoverSettings.getSettings.mockResolvedValue({ tokenConfigured: true, enabled: true, effectiveEnabled: true });
    mockStorygraphSettings.getSettings.mockResolvedValue({ cookiesConfigured: true, enabled: true, effectiveEnabled: true });
    mockHardcoverCatalog.search.mockResolvedValue([hardcoverBook]);
    mockStorygraphCatalog.search.mockResolvedValue([storygraphBook]);
  });

  it('merges duplicate books from enabled external catalogs', async () => {
    const result = await makeService().search(5, {
      query: 'Piranesi',
      sources: ['hardcover', 'storygraph'],
    });

    expect(result.results).toEqual([
      {
        ...hardcoverBook,
        sources: [...hardcoverBook.sources, ...storygraphBook.sources],
      },
    ]);
    expect(result.sources).toEqual([
      { source: 'hardcover', configured: true, available: true, resultCount: 1, message: null },
      { source: 'storygraph', configured: true, available: true, resultCount: 1, message: null },
    ]);
  });

  it('keeps successful results when another catalog fails', async () => {
    mockStorygraphCatalog.search.mockRejectedValue(new Error('Cloudflare challenge'));

    const result = await makeService().search(5, {
      query: 'Piranesi',
      sources: ['hardcover', 'storygraph'],
    });

    expect(result.results).toEqual([hardcoverBook]);
    expect(result.sources).toEqual([
      { source: 'hardcover', configured: true, available: true, resultCount: 1, message: null },
      {
        source: 'storygraph',
        configured: true,
        available: false,
        resultCount: 0,
        message: 'StoryGraph search is temporarily unavailable',
      },
    ]);
  });
});
