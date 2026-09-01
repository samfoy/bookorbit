import type { ExternalBookSearchResult } from '@bookorbit/types';
import { Logger } from '@nestjs/common';
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
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockHardcoverSettings.getSettings.mockResolvedValue({ tokenConfigured: true, enabled: true, effectiveEnabled: true });
    mockStorygraphSettings.getSettings.mockResolvedValue({ cookiesConfigured: true, enabled: true, effectiveEnabled: true });
    mockHardcoverCatalog.search.mockResolvedValue([hardcoverBook]);
    mockStorygraphCatalog.search.mockResolvedValue([storygraphBook]);
  });

  function loggedMessages(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls.map((call) => String(call[0]));
  }

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

  it('logs a convention-compliant start and end pair with duration and per-source counts', async () => {
    await makeService().search(5, { query: 'Piranesi', sources: ['hardcover', 'storygraph'] });

    const messages = loggedMessages(logSpy);
    const start = messages.find((message) => message.startsWith('[book_discovery.search] [start]'));
    const end = messages.find((message) => message.startsWith('[book_discovery.search] [end]'));

    expect(start).toBeDefined();
    expect(start).toContain('userId=5');
    expect(start).toContain('sourceCount=2');
    expect(start).toContain('hardcover=true');
    expect(start).toContain('storygraph=true');

    expect(end).toBeDefined();
    expect(end).toContain('userId=5');
    expect(end).toMatch(/durationMs=\d+/);
    expect(end).toContain('hardcoverResults=1');
    expect(end).toContain('storygraphResults=1');
    expect(end).toContain('resultCount=1');
  });

  it('never logs query text or credentials', async () => {
    mockHardcoverSettings.getSettings.mockResolvedValue({
      tokenConfigured: true,
      enabled: true,
      effectiveEnabled: true,
      token: 'super-secret-token',
    });
    mockStorygraphCatalog.search.mockRejectedValue(new Error('Cloudflare challenge for cookie=abc'));

    await makeService().search(5, { query: 'Piranesi', sources: ['hardcover', 'storygraph'] });

    const messages = [...loggedMessages(logSpy), ...loggedMessages(warnSpy)];
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message).not.toContain('Piranesi');
      expect(message).not.toContain('super-secret-token');
    }
  });

  it('logs a sanitized per-source failure and still emits the end log', async () => {
    mockStorygraphCatalog.search.mockRejectedValue(new Error('Cloudflare\nchallenge "blocked"'));

    await makeService().search(5, { query: 'Piranesi', sources: ['hardcover', 'storygraph'] });

    const failure = loggedMessages(warnSpy).find((message) => message.startsWith('[book_discovery.search] [fail]'));
    expect(failure).toBeDefined();
    expect(failure).toContain('userId=5');
    expect(failure).toContain('source=storygraph');
    expect(failure).toContain('errorClass=Error');
    expect(failure).toMatch(/durationMs=\d+/);
    expect(failure).toContain('error="Cloudflare challenge \\"blocked\\""');
    expect(failure).not.toContain('\n');

    const end = loggedMessages(logSpy).find((message) => message.startsWith('[book_discovery.search] [end]'));
    expect(end).toContain('hardcoverResults=1');
    expect(end).toContain('storygraphResults=0');
    expect(end).toContain('failedSources=storygraph');
  });

  it('reports requested-source flags for a single-source search', async () => {
    await makeService().search(9, { query: 'Piranesi', sources: ['hardcover'] });

    const start = loggedMessages(logSpy).find((message) => message.startsWith('[book_discovery.search] [start]'));
    expect(start).toContain('userId=9');
    expect(start).toContain('sourceCount=1');
    expect(start).toContain('hardcover=true');
    expect(start).toContain('storygraph=false');
  });
});
