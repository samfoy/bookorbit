import type { ExternalBookSearchResult } from '@bookorbit/types';
import { describe, expect, it } from 'vitest';

import { rankExternalBookSearchResults } from './book-discovery.service';

function book(id: string, title: string, author: string, overrides: Partial<ExternalBookSearchResult> = {}): ExternalBookSearchResult {
  return {
    id,
    title,
    authors: [author],
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
    sources: [{ source: 'hardcover', externalId: id, url: `https://example.com/${id}` }],
    ...overrides,
  };
}

function ids(query: string, books: ExternalBookSearchResult[]): string[] {
  return rankExternalBookSearchResults(query, books).map((item) => item.id);
}

describe('rankExternalBookSearchResults', () => {
  it('ranks the original Dune ahead of criticism with the same title', () => {
    const criticism = book('criticism', 'Dune', 'John Doe', { rating: 4.8, ratingsCount: 20 });
    const original = book('original', 'Dune', 'Frank Herbert', {
      hasEbook: true,
      rating: 4.3,
      ratingsCount: 2_000_000,
      sources: [
        { source: 'hardcover', externalId: 'original', url: 'https://hardcover.app/original' },
        { source: 'storygraph', externalId: 'original', url: 'https://thestorygraph.com/original' },
      ],
    });

    expect(ids('Dune', [criticism, original])).toEqual(['original', 'criticism']);
  });

  it('ranks Project Hail Mary ahead of derivative products', () => {
    const results = [
      book('summary', 'Project Hail Mary Summary and Analysis', 'Study Press'),
      book('notebook', 'Project Hail Mary Notebook', 'Paper Goods'),
      book('collection', 'Project Hail Mary Collection', 'Various Authors'),
      book('original', 'Project Hail Mary', 'Andy Weir'),
      book('companion', 'Project Hail Mary Companion', 'Reader Guides'),
    ];

    expect(ids('Project Hail Mary', results)[0]).toBe('original');
  });

  it('treats an exact primary-author match as author intent', () => {
    const criticism = book('criticism', 'Kazuo Ishiguro', 'Barry Lewis');
    const novels = [book('remains', 'The Remains of the Day', 'Kazuo Ishiguro'), book('klara', 'Klara and the Sun', 'Kazuo Ishiguro')];

    expect(ids('Kazuo Ishiguro', [criticism, ...novels])).toEqual(['remains', 'klara', 'criticism']);
  });

  it('keeps exact title consensus ahead of derivatives', () => {
    const derivative = book('guide', 'Piranesi Study Guide', 'Study Press', {
      rating: 5,
      ratingsCount: 5_000_000,
      hasEbook: true,
    });
    const exact = book('exact', 'Piranesi', 'Susanna Clarke', {
      sources: [
        { source: 'hardcover', externalId: 'exact', url: 'https://hardcover.app/exact' },
        { source: 'storygraph', externalId: 'exact', url: 'https://thestorygraph.com/exact' },
      ],
    });

    expect(ids('Piranesi', [derivative, exact])).toEqual(['exact', 'guide']);
  });

  it('preserves input order for equal scores', () => {
    const first = book('first', 'Dune Reader', 'One');
    const second = book('second', 'Dune Reader', 'Two');

    expect(ids('Dune', [first, second])).toEqual(['first', 'second']);
  });
});
