import type { BookCard, ExternalBookSearchResult, KoreaderStoreShelf } from '@bookorbit/types';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { RequestUser } from '../../common/types/request-user';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { normalizeIsbn } from '../book-duplicates/book-duplicate-normalize';
import { DashboardService } from '../dashboard/dashboard.service';
import { ScrollerType } from '../dashboard/dto/scroller-type.enum';

type Db = NodePgDatabase<typeof schema>;

export interface KoreaderStoreRecommendationSeed {
  title: string;
  rating: number | null;
  author: string | null;
  genres: string[];
  seriesName: string | null;
}

const MAX_FOR_YOU_ITEMS = 12;

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase();
}

function dedupeKey(book: ExternalBookSearchResult): string {
  const isbn = normalizeIsbn(book.isbn13) || normalizeIsbn(book.isbn10);
  if (isbn) return `isbn:${isbn}`;
  return `text:${normalize(book.title)}|${normalize(book.authors[0])}`;
}

function reasonFor(book: ExternalBookSearchResult, seeds: KoreaderStoreRecommendationSeed[]): string | null {
  for (const seed of seeds) {
    const author = normalize(seed.author);
    if (author && book.authors.some((candidate) => normalize(candidate) === author)) return `More by ${seed.author}`;
  }
  for (const seed of seeds) {
    const series = normalize(seed.seriesName);
    if (series && normalize(book.seriesName) === series) return `More in the ${seed.seriesName} series`;
  }
  for (const seed of seeds) {
    const seedGenres = new Set(seed.genres.map(normalize).filter(Boolean));
    const genre = book.genres.find((candidate) => seedGenres.has(normalize(candidate.name)) || seedGenres.has(normalize(candidate.slug)));
    if (genre) return `${genre.name} matching your recent reading`;
  }
  return null;
}

export function buildPersonalizedForYou(
  candidates: ExternalBookSearchResult[],
  seeds: KoreaderStoreRecommendationSeed[],
): Array<ExternalBookSearchResult & { recommendationReason: string }> {
  const seen = new Set<string>();
  const output: Array<ExternalBookSearchResult & { recommendationReason: string }> = [];
  for (const book of candidates) {
    if (book.state?.alreadyOwned || book.state?.alreadyRead) continue;
    const key = dedupeKey(book);
    if (seen.has(key)) continue;
    seen.add(key);
    const recommendationReason = reasonFor(book, seeds);
    if (!recommendationReason) continue;
    output.push({ ...book, recommendationReason });
    if (output.length >= MAX_FOR_YOU_ITEMS) break;
  }
  return output;
}

function localUpNext(card: BookCard): ExternalBookSearchResult {
  const formats = [...new Set(card.files.filter((file) => file.role === 'content' && file.format).map((file) => file.format!.toLowerCase()))];
  return {
    id: `bookorbit:${card.id}`,
    title: card.title ?? 'Untitled',
    authors: card.authors,
    coverUrl: null,
    description: null,
    publishedYear: card.publishedYear,
    rating: card.rating,
    ratingsCount: null,
    isbn10: null,
    isbn13: card.isbn13,
    pageCount: card.pageCount,
    seriesName: card.seriesName,
    seriesPosition: card.seriesIndex,
    hasEbook: formats.some((format) => format === 'epub' || format === 'kepub'),
    genres: card.genres.map((name) => ({ name, slug: normalize(name).replace(/\s+/g, '-') })),
    sources: card.hardcoverId ? [{ source: 'hardcover', externalId: card.hardcoverId, url: `https://hardcover.app/books/${card.hardcoverId}` }] : [],
    recommendationReason: card.seriesName ? `Next in the ${card.seriesName} series` : 'Next in your series',
    state: {
      inBookOrbit: true,
      bookId: card.id,
      localFormats: formats,
      bookOrbitStatus: card.readStatus?.status ?? null,
      progressPercentage: card.readingProgress,
      hardcoverStatus: null,
      storygraphStatus: null,
      alreadyRead: false,
      alreadyOwned: true,
    },
  };
}

@Injectable()
export class KoreaderStorePersonalizationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly dashboard: DashboardService,
  ) {}

  async getShelves(user: RequestUser, candidates: ExternalBookSearchResult[]): Promise<KoreaderStoreShelf[]> {
    const [seeds, upNext] = await Promise.all([this.getSeeds(user.id), this.dashboard.getScroller(ScrollerType.UP_NEXT_IN_SERIES, user, 12)]);
    const forYou = buildPersonalizedForYou(candidates, seeds);
    const shelves: KoreaderStoreShelf[] = [];
    if (forYou.length > 0) {
      shelves.push({
        id: 'for-you',
        title: 'For You',
        subtitle: 'Based on books, authors, and genres you actually read',
        kind: 'for-you',
        items: forYou,
        available: true,
        message: null,
      });
    }
    if (upNext.length > 0) {
      shelves.push({
        id: 'up-next-series',
        title: 'Up Next in Your Series',
        subtitle: 'Strict series continuation from your BookOrbit library',
        kind: 'up-next',
        items: upNext.map(localUpNext),
        available: true,
        message: null,
      });
    }
    const currentYear = new Date().getUTCFullYear();
    const curated = [
      {
        id: 'new-releases',
        title: 'New releases',
        subtitle: 'Published in the last two years',
        items: candidates.filter((book) => (book.publishedYear ?? 0) >= currentYear - 1),
      },
      {
        id: 'short-reads',
        title: 'Short reads',
        subtitle: '300 pages or fewer',
        items: candidates.filter((book) => (book.pageCount ?? Number.MAX_SAFE_INTEGER) <= 300),
      },
      {
        id: 'highly-rated',
        title: 'Highly rated',
        subtitle: 'Rated 4.3 or higher',
        items: candidates.filter((book) => (book.rating ?? 0) >= 4.3),
      },
      {
        id: 'new-from-your-authors',
        title: 'New from authors you read',
        subtitle: 'Author matches from your real reading history',
        items: forYou.filter((book) => book.recommendationReason?.startsWith('More by ')),
      },
    ];
    for (const shelf of curated) {
      const items = shelf.items.filter((book) => !book.state?.alreadyRead && !book.state?.alreadyOwned).slice(0, 12);
      if (items.length > 0) shelves.push({ ...shelf, kind: 'curated', items, available: true, message: null });
    }
    return shelves;
  }

  private async getSeeds(userId: number): Promise<KoreaderStoreRecommendationSeed[]> {
    const rows = await this.db.execute<KoreaderStoreRecommendationSeed & Record<string, unknown>>(sql`
      SELECT
        COALESCE(${schema.bookMetadata.title}, '') AS title,
        ${schema.userBookRatings.rating} AS rating,
        primary_author.name AS author,
        COALESCE(book_genres.names, ARRAY[]::varchar[]) AS genres,
        ${schema.bookMetadata.seriesName} AS "seriesName"
      FROM ${schema.books}
      JOIN ${schema.bookMetadata} ON ${schema.bookMetadata.bookId} = ${schema.books.id}
      LEFT JOIN ${schema.userBookRatings}
        ON ${schema.userBookRatings.bookId} = ${schema.books.id} AND ${schema.userBookRatings.userId} = ${userId}
      LEFT JOIN ${schema.userBookStatus}
        ON ${schema.userBookStatus.bookId} = ${schema.books.id} AND ${schema.userBookStatus.userId} = ${userId}
      LEFT JOIN LATERAL (
        SELECT ${schema.authors.name} AS name
        FROM ${schema.bookAuthors}
        JOIN ${schema.authors} ON ${schema.authors.id} = ${schema.bookAuthors.authorId}
        WHERE ${schema.bookAuthors.bookId} = ${schema.books.id}
        ORDER BY ${schema.bookAuthors.displayOrder}, ${schema.authors.id}
        LIMIT 1
      ) primary_author ON true
      LEFT JOIN LATERAL (
        SELECT ARRAY_AGG(DISTINCT ${schema.genres.name}) AS names
        FROM ${schema.bookGenres}
        JOIN ${schema.genres} ON ${schema.genres.id} = ${schema.bookGenres.genreId}
        WHERE ${schema.bookGenres.bookId} = ${schema.books.id}
      ) book_genres ON true
      WHERE (${schema.userBookRatings.rating} >= 4 OR ${schema.userBookStatus.status} IN ('reading', 'rereading', 'read', 'skimmed'))
      ORDER BY ${schema.userBookRatings.rating} DESC NULLS LAST, ${schema.userBookStatus.updatedAt} DESC NULLS LAST
      LIMIT 12
    `);
    return rows.rows;
  }
}
