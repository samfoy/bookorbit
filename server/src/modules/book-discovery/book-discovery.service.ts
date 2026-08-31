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

    this.logSourceFailure(userId, 'hardcover', hardcoverOutcome);
    this.logSourceFailure(userId, 'storygraph', storygraphOutcome);

    return {
      results: this.mergeBooks([...hardcoverBooks, ...storygraphBooks]),
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

  private logSourceFailure(userId: number, source: ExternalCatalogSource, outcome: PromiseSettledResult<ExternalBookSearchResult[]>): void {
    if (outcome.status !== 'rejected') return;
    const errorClass = outcome.reason instanceof Error ? outcome.reason.constructor.name : 'Error';
    const error = sanitizeLogValue(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
    this.logger.warn(
      `[book_discovery.search] [fail] userId=${userId} source=${source} errorClass=${errorClass} error="${error}" - catalog source failed`,
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
    return `${this.normalize(book.title)}|${this.normalize(book.authors[0] ?? '')}`;
  }

  private normalize(value: string): string {
    return value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
}
