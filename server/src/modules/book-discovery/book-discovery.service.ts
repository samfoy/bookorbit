import type {
  ExternalBookSearchRequest,
  ExternalBookSearchResponse,
  ExternalBookSearchResult,
  ExternalCatalogSource,
  ExternalCatalogSourceStatus,
} from '@bookorbit/types';
import { Injectable, Logger } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';

import { HardcoverCatalogService } from '../hardcover/hardcover-catalog.service';
import { HardcoverSettingsService } from '../hardcover/hardcover-settings.service';
import { StorygraphCatalogService } from '../storygraph/storygraph-catalog.service';
import { StorygraphSettingsService } from '../storygraph/storygraph-settings.service';

const DERIVATIVE_TITLE_PHRASES = [
  'summary',
  'analysis',
  'study guide',
  'workbook',
  'notebook',
  'interpretation',
  'collection',
  'box set',
  'omnibus',
  'review',
  'companion',
] as const;

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface SearchRank {
  intent: number;
  derivative: number;
  titleCoverage: number;
  consensus: number;
  ebook: number;
  rating: number;
  ratingsCount: number;
  index: number;
}

function compareRank(left: SearchRank, right: SearchRank): number {
  return (
    right.intent - left.intent ||
    left.derivative - right.derivative ||
    right.titleCoverage - left.titleCoverage ||
    right.consensus - left.consensus ||
    right.ebook - left.ebook ||
    right.rating - left.rating ||
    right.ratingsCount - left.ratingsCount ||
    left.index - right.index
  );
}

export function rankExternalBookSearchResults(query: string, books: ExternalBookSearchResult[]): ExternalBookSearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [...books];

  const queryTokens = normalizedQuery.split(' ');
  const authorIntent = books.some((book) => normalizeSearchText(book.authors[0] ?? '') === normalizedQuery);
  const strongAuthorIntent = authorIntent && queryTokens.length > 1;

  return books
    .map((book, index) => {
      const title = normalizeSearchText(book.title);
      const primaryAuthor = normalizeSearchText(book.authors[0] ?? '');
      const exactTitle = title === normalizedQuery;
      const exactAuthor = primaryAuthor === normalizedQuery;
      const titleTokens = new Set(title.split(' ').filter(Boolean));
      const matchingTokens = queryTokens.filter((token) => titleTokens.has(token)).length;
      const titleCoverage = queryTokens.length === 0 ? 0 : matchingTokens / queryTokens.length;
      const titlePrefix = title.startsWith(normalizedQuery);
      const paddedTitle = ` ${title} `;
      const derivative = DERIVATIVE_TITLE_PHRASES.some((phrase) => paddedTitle.includes(` ${phrase} `));
      const sources = new Set(book.sources.map((source) => source.source));
      const credibleExactTitle = exactTitle && (book.hasEbook === true || (book.ratingsCount ?? 0) >= 1_000 || sources.size > 1);
      let intent = 0;
      if (strongAuthorIntent && exactAuthor) intent = 7;
      else if (credibleExactTitle) intent = 6;
      else if (authorIntent && exactAuthor) intent = 5;
      else if (exactTitle) intent = 4;
      else if (titlePrefix && titleCoverage === 1) intent = 3;
      else if (titleCoverage === 1) intent = 2;
      else if (titleCoverage > 0) intent = 1;

      const rank: SearchRank = {
        intent,
        derivative: derivative ? 1 : 0,
        titleCoverage,
        consensus: sources.size,
        ebook: book.hasEbook === true ? 1 : 0,
        rating: book.rating ?? 0,
        ratingsCount: book.ratingsCount ?? 0,
        index,
      };
      return { book, rank };
    })
    .sort((left, right) => compareRank(left.rank, right.rank))
    .map(({ book }) => book);
}

@Injectable()
export class BookDiscoveryService {
  private readonly logger = new Logger(BookDiscoveryService.name);

  constructor(
    private readonly hardcoverCatalog: HardcoverCatalogService,
    private readonly storygraphCatalog: StorygraphCatalogService,
    private readonly hardcoverSettings: HardcoverSettingsService,
    private readonly storygraphSettings: StorygraphSettingsService,
  ) {}

  async search(userId: number, request: ExternalBookSearchRequest): Promise<ExternalBookSearchResponse> {
    const requested = new Set(request.sources);
    const startedAtMs = Date.now();
    this.logger.log(
      `[book_discovery.search] [start] userId=${userId} sourceCount=${requested.size} hardcover=${requested.has('hardcover')} storygraph=${requested.has('storygraph')} - external search started`,
    );

    const [hardcoverSettings, storygraphSettings] = await Promise.all([
      this.hardcoverSettings.getSettings(userId),
      this.storygraphSettings.getSettings(userId),
    ]);

    const hardcoverPromise =
      requested.has('hardcover') && hardcoverSettings.effectiveEnabled ? this.hardcoverCatalog.search(userId, request.query) : Promise.resolve([]);
    const storygraphPromise =
      requested.has('storygraph') && storygraphSettings.effectiveEnabled ? this.storygraphCatalog.search(userId, request.query) : Promise.resolve([]);
    const [hardcoverOutcome, storygraphOutcome] = await Promise.allSettled([hardcoverPromise, storygraphPromise]);
    const hardcoverBooks = hardcoverOutcome.status === 'fulfilled' ? hardcoverOutcome.value : [];
    const storygraphBooks = storygraphOutcome.status === 'fulfilled' ? storygraphOutcome.value : [];

    this.logSourceFailure(userId, 'hardcover', hardcoverOutcome, startedAtMs);
    this.logSourceFailure(userId, 'storygraph', storygraphOutcome, startedAtMs);

    const results = rankExternalBookSearchResults(request.query, this.mergeBooks([...hardcoverBooks, ...storygraphBooks]));
    const failedSources = [
      ...(hardcoverOutcome.status === 'rejected' ? ['hardcover'] : []),
      ...(storygraphOutcome.status === 'rejected' ? ['storygraph'] : []),
    ];
    this.logger.log(
      `[book_discovery.search] [end] userId=${userId} sourceCount=${requested.size} durationMs=${Date.now() - startedAtMs} hardcoverResults=${hardcoverBooks.length} storygraphResults=${storygraphBooks.length} resultCount=${results.length} failedSources=${failedSources.join(',') || 'none'} - external search completed`,
    );

    return {
      results,
      sources: [
        this.sourceStatus(
          'hardcover',
          requested.has('hardcover'),
          hardcoverSettings.tokenConfigured,
          hardcoverSettings.effectiveEnabled,
          hardcoverBooks.length,
          hardcoverOutcome.status === 'rejected',
        ),
        this.sourceStatus(
          'storygraph',
          requested.has('storygraph'),
          storygraphSettings.cookiesConfigured,
          storygraphSettings.effectiveEnabled,
          storygraphBooks.length,
          storygraphOutcome.status === 'rejected',
        ),
      ].filter((status): status is ExternalCatalogSourceStatus => status !== null),
    };
  }

  private sourceStatus(
    source: ExternalCatalogSource,
    requested: boolean,
    configured: boolean,
    enabled: boolean,
    resultCount: number,
    failed: boolean,
  ): ExternalCatalogSourceStatus | null {
    if (!requested) return null;
    const label = source === 'hardcover' ? 'Hardcover' : 'StoryGraph';
    return {
      source,
      configured,
      available: enabled && !failed,
      resultCount,
      message: failed
        ? `${label} search is temporarily unavailable`
        : enabled
          ? null
          : configured
            ? 'Integration is disabled'
            : 'Integration is not configured',
    };
  }

  private logSourceFailure(
    userId: number,
    source: ExternalCatalogSource,
    outcome: PromiseSettledResult<ExternalBookSearchResult[]>,
    startedAtMs: number,
  ): void {
    if (outcome.status !== 'rejected') return;
    const errorClass = outcome.reason instanceof Error ? outcome.reason.constructor.name : 'Error';
    const error = sanitizeLogValue(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
    this.logger.warn(
      `[book_discovery.search] [fail] userId=${userId} source=${source} durationMs=${Date.now() - startedAtMs} errorClass=${errorClass} error="${error}" - catalog source failed`,
    );
  }

  private mergeBooks(books: ExternalBookSearchResult[]): ExternalBookSearchResult[] {
    const merged = new Map<string, ExternalBookSearchResult>();

    for (const book of books) {
      const key = this.bookKey(book);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...book, sources: [...book.sources] });
        continue;
      }
      existing.sources = [...existing.sources, ...book.sources.filter((source) => !existing.sources.some((item) => item.source === source.source))];
    }

    return [...merged.values()];
  }

  private bookKey(book: ExternalBookSearchResult): string {
    return `${normalizeSearchText(book.title)}|${normalizeSearchText(book.authors[0] ?? '')}`;
  }
}
