import type { ExternalBookSearchResult } from '@bookorbit/types';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as cheerio from 'cheerio';

import { STORYGRAPH_BASE_URL } from './storygraph.constants';
import { StorygraphClientService } from './storygraph-client.service';
import { StorygraphSettingsService } from './storygraph-settings.service';

const MAX_CATALOG_RESULTS = 20;

@Injectable()
export class StorygraphCatalogService {
  constructor(
    private readonly client: StorygraphClientService,
    private readonly settings: StorygraphSettingsService,
  ) {}

  async search(userId: number, query: string): Promise<ExternalBookSearchResult[]> {
    const cookies = await this.settings.getCookiesForUser(userId);
    if (!cookies) return [];

    const response = await this.client.get(userId, cookies, `/browse?search_term=${encodeURIComponent(query)}`);
    if (response.redirectedToSignIn) throw new UnauthorizedException('StoryGraph session has expired');
    if (response.status !== 200) return [];

    const $ = cheerio.load(response.html);
    const books: ExternalBookSearchResult[] = [];
    const seen = new Set<string>();

    $('.book-title-author-and-series').each((_, element) => {
      if (books.length >= MAX_CATALOG_RESULTS) return false;

      const block = $(element);
      const titleLink = block.find("a[href^='/books/']").first();
      const href = titleLink.attr('href');
      const externalId = this.extractBookId(href);
      const title = titleLink.text().trim();
      if (!externalId || !title || seen.has(externalId)) return;

      const pane = block.closest('.book-pane');
      const authors = pane
        .find("a[href^='/authors/']")
        .map((__, author) => $(author).text().trim())
        .get()
        .filter(Boolean);
      const coverSrc = pane.find('img').first().attr('src')?.trim();

      seen.add(externalId);
      books.push({
        id: `storygraph:${externalId}`,
        title,
        authors: [...new Set(authors)],
        coverUrl: coverSrc ? new URL(coverSrc, STORYGRAPH_BASE_URL).toString() : null,
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
        sources: [
          {
            source: 'storygraph',
            externalId,
            url: `${STORYGRAPH_BASE_URL}/books/${encodeURIComponent(externalId)}`,
          },
        ],
      });
    });

    return books;
  }

  private extractBookId(href: string | undefined): string | null {
    const match = /^\/books\/([^/?#]+)/.exec(href ?? '');
    return match?.[1] ?? null;
  }
}
