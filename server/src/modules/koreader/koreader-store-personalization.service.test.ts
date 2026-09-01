import type { BookCard, ExternalBookSearchResult } from '@bookorbit/types';
import { describe, expect, it, vi } from 'vitest';

import { makeRequestUser } from '../upload/test-helpers';
import { KoreaderStorePersonalizationService } from './koreader-store-personalization.service';

const user = makeRequestUser({ id: 7 });

function external(title: string, author: string, genre: string): ExternalBookSearchResult {
  return {
    id: `hardcover:${title}`,
    title,
    authors: [author],
    coverUrl: null,
    description: null,
    publishedYear: 2025,
    rating: 4.2,
    ratingsCount: 10,
    isbn10: null,
    isbn13: null,
    pageCount: 300,
    seriesName: null,
    seriesPosition: null,
    hasEbook: true,
    genres: [{ name: genre, slug: genre.toLowerCase() }],
    sources: [{ source: 'hardcover', externalId: title, url: 'https://hardcover.app' }],
  };
}

describe('KoreaderStorePersonalizationService', () => {
  it('builds an explained For You shelf from bounded user evidence', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ title: 'Piranesi', rating: 5, author: 'Susanna Clarke', genres: ['Fantasy'], seriesName: null }],
      }),
    };
    const dashboard = { getScroller: vi.fn().mockResolvedValue([]) };
    const service = new KoreaderStorePersonalizationService(db as never, dashboard as never);

    const shelves = await service.getShelves(user, [external('Jonathan Strange', 'Susanna Clarke', 'Fantasy')]);

    expect(shelves[0]).toEqual(expect.objectContaining({ id: 'for-you', title: 'For You', available: true }));
    expect(shelves[0]?.items[0]?.recommendationReason).toBe('More by Susanna Clarke');
    expect(db.execute).toHaveBeenCalledOnce();
  });

  it('maps the existing strict dashboard up-next owner into an owned Store shelf', async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    const card = {
      id: 42,
      title: 'The Tombs of Atuan',
      authors: ['Ursula K. Le Guin'],
      files: [{ id: 9, format: 'epub', role: 'content', sizeBytes: 123 }],
      seriesName: 'Earthsea Cycle',
      seriesIndex: 2,
      publishedYear: 1971,
      genres: ['Fantasy'],
      rating: 4.4,
      readingProgress: null,
      readStatus: { status: 'unread' },
      pageCount: 192,
      isbn13: '9780000000042',
      hardcoverId: '420',
      hasCover: true,
    } as unknown as BookCard;
    const dashboard = { getScroller: vi.fn().mockResolvedValue([card]) };
    const service = new KoreaderStorePersonalizationService(db as never, dashboard as never);

    const shelves = await service.getShelves(user, []);
    const upNext = shelves.find((shelf) => shelf.id === 'up-next-series');

    expect(upNext?.items[0]).toEqual(
      expect.objectContaining({
        title: 'The Tombs of Atuan',
        recommendationReason: 'Next in the Earthsea Cycle series',
        state: expect.objectContaining({ inBookOrbit: true, alreadyOwned: true, bookId: 42 }),
      }),
    );
  });
});
