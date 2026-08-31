import type { ExternalBookSearchResult, KoreaderStoreResultState, ReadStatus } from '@bookorbit/types';
import { Inject, Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { RequestUser } from '../../common/types/request-user';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { normalizeIsbn } from '../book-duplicates/book-duplicate-normalize';
import { LibraryService } from '../library/library.service';

type Db = NodePgDatabase<typeof schema>;

const MAX_STATE_RESULTS = 200;
const MAX_STATE_CANDIDATES = 600;
const MAX_LOCAL_FORMATS = 6;
const FINISHED_STATUSES = new Set(['read', 'finished', 'skimmed', 'completed']);

export interface StoreStateCandidate {
  bookId: number;
  isbn10: string | null;
  isbn13: string | null;
  title: string | null;
  primaryAuthor: string | null;
  formats: (string | null)[];
  bookOrbitStatus: ReadStatus | null;
  progress: number | null;
  hardcoverBookId: string | null;
  hardcoverStatus: string | null;
  storygraphBookId: string | null;
  storygraphStatus: string | null;
}

function emptyState(): KoreaderStoreResultState {
  return {
    inBookOrbit: false,
    bookId: null,
    localFormats: [],
    bookOrbitStatus: null,
    progressPercentage: null,
    hardcoverStatus: null,
    storygraphStatus: null,
    alreadyRead: false,
    alreadyOwned: false,
  };
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function providerIds(book: ExternalBookSearchResult): { hardcover: Set<string>; storygraph: Set<string> } {
  const ids = { hardcover: new Set<string>(), storygraph: new Set<string>() };
  for (const source of book.sources) ids[source.source].add(String(source.externalId));
  return ids;
}

function isFinished(value: string | null | undefined): boolean {
  return FINISHED_STATUSES.has(normalizeText(value).replace(/ /g, '_'));
}

export function matchStoreState(book: ExternalBookSearchResult, candidates: StoreStateCandidate[]): KoreaderStoreResultState {
  const isbn13 = normalizeIsbn(book.isbn13);
  const isbn10 = normalizeIsbn(book.isbn10);
  const ids = providerIds(book);
  const title = normalizeText(book.title);
  const author = normalizeText(book.authors[0]);
  const match =
    (isbn13 && candidates.find((candidate) => normalizeIsbn(candidate.isbn13) === isbn13)) ||
    (isbn10 && candidates.find((candidate) => normalizeIsbn(candidate.isbn10) === isbn10)) ||
    candidates.find(
      (candidate) =>
        (candidate.hardcoverBookId !== null && ids.hardcover.has(String(candidate.hardcoverBookId))) ||
        (candidate.storygraphBookId !== null && ids.storygraph.has(candidate.storygraphBookId)),
    ) ||
    (title && author
      ? candidates.find((candidate) => normalizeText(candidate.title) === title && normalizeText(candidate.primaryAuthor) === author)
      : undefined);

  if (!match) return emptyState();
  const formats = [...new Set(match.formats.filter((format): format is string => Boolean(format)).map((format) => format.toLowerCase()))]
    .sort()
    .slice(0, MAX_LOCAL_FORMATS);
  return {
    inBookOrbit: true,
    bookId: match.bookId,
    localFormats: formats,
    bookOrbitStatus: match.bookOrbitStatus,
    progressPercentage: match.progress,
    hardcoverStatus: match.hardcoverStatus,
    storygraphStatus: match.storygraphStatus,
    alreadyRead: isFinished(match.bookOrbitStatus) || isFinished(match.hardcoverStatus) || isFinished(match.storygraphStatus),
    alreadyOwned: true,
  };
}

@Injectable()
export class KoreaderStorePhase2Service {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly libraries: LibraryService,
  ) {}

  async enrichResults(
    user: RequestUser,
    results: ExternalBookSearchResult[],
  ): Promise<Array<ExternalBookSearchResult & { state: KoreaderStoreResultState }>> {
    if (results.length === 0) return [];
    const boundedResults = results.slice(0, MAX_STATE_RESULTS);
    const libraryIds = await this.libraries.findAccessibleLibraryIds(user);
    const candidates = libraryIds.length === 0 ? [] : await this.findCandidates(user.id, libraryIds, boundedResults);
    return results.map((book, index) => ({ ...book, state: index < MAX_STATE_RESULTS ? matchStoreState(book, candidates) : emptyState() }));
  }

  private async findCandidates(userId: number, libraryIds: number[], results: ExternalBookSearchResult[]): Promise<StoreStateCandidate[]> {
    const isbn13s = [...new Set(results.map((book) => normalizeIsbn(book.isbn13)).filter((value): value is string => Boolean(value)))];
    const isbn10s = [...new Set(results.map((book) => normalizeIsbn(book.isbn10)).filter((value): value is string => Boolean(value)))];
    const hardcoverIds = results.flatMap((book) => book.sources.filter((source) => source.source === 'hardcover').map((source) => source.externalId));
    const storygraphIds = results.flatMap((book) =>
      book.sources.filter((source) => source.source === 'storygraph').map((source) => source.externalId),
    );
    const titleKeys = [...new Set(results.map((book) => normalizeText(book.title)).filter(Boolean))];
    const authorKeys = [...new Set(results.map((book) => normalizeText(book.authors[0])).filter(Boolean))];
    const list = (values: Array<string | number>) =>
      sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      );
    const normalizedTitle = sql`lower(btrim(regexp_replace(regexp_replace(public.bookorbit_unaccent(coalesce(${schema.bookMetadata.title}, '')), '[^[:alnum:]]+', ' ', 'g'), '[[:space:]]+', ' ', 'g')))`;
    const normalizedAuthor = sql`lower(btrim(regexp_replace(regexp_replace(public.bookorbit_unaccent(coalesce(primary_author.name, '')), '[^[:alnum:]]+', ' ', 'g'), '[[:space:]]+', ' ', 'g')))`;
    const conditions = [
      isbn13s.length > 0 ? sql`${schema.bookMetadata.isbn13} IN (${list(isbn13s)})` : null,
      isbn10s.length > 0 ? sql`${schema.bookMetadata.isbn10} IN (${list(isbn10s)})` : null,
      hardcoverIds.length > 0
        ? sql`(${schema.bookMetadata.hardcoverId} IN (${list(hardcoverIds)}) OR ${schema.hardcoverBookState.hardcoverBookId}::text IN (${list(hardcoverIds)}))`
        : null,
      storygraphIds.length > 0 ? sql`${schema.storygraphBookState.storygraphBookId} IN (${list(storygraphIds)})` : null,
      titleKeys.length > 0 && authorKeys.length > 0
        ? sql`(${normalizedTitle} IN (${list(titleKeys)}) AND ${normalizedAuthor} IN (${list(authorKeys)}))`
        : null,
    ].filter((condition): condition is SQL => condition !== null);
    if (conditions.length === 0) return [];

    const query = await this.db.execute<StoreStateCandidate & Record<string, unknown>>(sql`
      SELECT
        ${schema.books.id} AS "bookId",
        ${schema.bookMetadata.isbn10} AS "isbn10",
        ${schema.bookMetadata.isbn13} AS "isbn13",
        ${schema.bookMetadata.title} AS "title",
        primary_author.name AS "primaryAuthor",
        COALESCE(local_files.formats, ARRAY[]::varchar[]) AS "formats",
        ${schema.userBookStatus.status} AS "bookOrbitStatus",
        local_progress.percentage AS "progress",
        COALESCE(${schema.hardcoverBookState.hardcoverBookId}::text, ${schema.bookMetadata.hardcoverId}) AS "hardcoverBookId",
        ${schema.hardcoverBookState.lastSyncedStatus} AS "hardcoverStatus",
        ${schema.storygraphBookState.storygraphBookId} AS "storygraphBookId",
        ${schema.storygraphBookState.lastSyncedStatus} AS "storygraphStatus"
      FROM ${schema.books}
      JOIN ${schema.bookMetadata} ON ${schema.bookMetadata.bookId} = ${schema.books.id}
      LEFT JOIN LATERAL (
        SELECT ${schema.authors.name} AS name
        FROM ${schema.bookAuthors}
        JOIN ${schema.authors} ON ${schema.authors.id} = ${schema.bookAuthors.authorId}
        WHERE ${schema.bookAuthors.bookId} = ${schema.books.id}
        ORDER BY ${schema.bookAuthors.displayOrder}, ${schema.authors.id}
        LIMIT 1
      ) primary_author ON true
      LEFT JOIN LATERAL (
        SELECT ARRAY_AGG(DISTINCT lower(${schema.bookFiles.format})) FILTER (WHERE ${schema.bookFiles.format} IS NOT NULL) AS formats
        FROM ${schema.bookFiles}
        WHERE ${schema.bookFiles.bookId} = ${schema.books.id} AND ${schema.bookFiles.role} = 'content'
      ) local_files ON true
      LEFT JOIN LATERAL (
        SELECT max(${schema.readingProgress.percentage}) AS percentage
        FROM ${schema.readingProgress}
        JOIN ${schema.bookFiles} progress_file ON progress_file.id = ${schema.readingProgress.bookFileId}
        WHERE progress_file.book_id = ${schema.books.id} AND ${schema.readingProgress.userId} = ${userId}
      ) local_progress ON true
      LEFT JOIN ${schema.userBookStatus}
        ON ${schema.userBookStatus.bookId} = ${schema.books.id} AND ${schema.userBookStatus.userId} = ${userId}
      LEFT JOIN ${schema.hardcoverBookState}
        ON ${schema.hardcoverBookState.bookId} = ${schema.books.id} AND ${schema.hardcoverBookState.userId} = ${userId}
      LEFT JOIN ${schema.storygraphBookState}
        ON ${schema.storygraphBookState.bookId} = ${schema.books.id} AND ${schema.storygraphBookState.userId} = ${userId}
      WHERE ${schema.books.libraryId} IN (${list(libraryIds)})
        AND ${schema.books.status} = 'present'
        AND (${sql.join(conditions, sql` OR `)})
      ORDER BY ${schema.books.id}
      LIMIT ${MAX_STATE_CANDIDATES}
    `);
    return query.rows;
  }
}
