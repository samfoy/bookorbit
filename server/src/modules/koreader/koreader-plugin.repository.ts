import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash } from 'node:crypto';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { chunk } from '../../common/utils/batch.utils';
import {
  aggregateReadingSessionDailyStats,
  getDayRangeForDateKeys,
  getReadingSessionDayKeys,
  type ReadingDailyStatsSegment,
} from '../../common/utils/reading-daily-stats.utils';
import {
  KOREADER_MAX_EVENT_DURATION_SECONDS,
  KOREADER_SESSION_GAP_SECONDS,
  buildSessionIdPrefix,
  deriveKoreaderSessions,
  resolveDeviceSource,
  type DerivedKoreaderSession,
  type KoreaderPageEvent,
} from './koreader-stats.util';

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const BATCH_QUERY_SIZE = 200;

/** Postgres returns bigint aggregates as strings. */
function toSeconds(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface IngestPageStatsResult {
  accepted: number;
  duplicates: number;
  insertedSessions: DerivedKoreaderSession[];
  updatedSessions: DerivedKoreaderSession[];
  deletedSessions: number;
}

export interface StatisticsMirrorBounds {
  pageMaxId: number;
  sessionMaxId: number;
  generation: string;
}

export interface StatisticsMirrorRow {
  id: number;
  kind: 'page' | 'session';
  bookId: number;
  hash: string;
  title: string;
  authors: string;
  pages: number;
  page: number;
  startTime: number;
  endedAt?: Date;
  durationSeconds: number;
  totalPages: number;
}

const MIRRORED_SESSION_SOURCES = ['koreader', 'crosspoint'] as const;
const SYNTHETIC_TOTAL_PAGES = 10_000;

function numberValue(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

@Injectable()
export class KoreaderPluginRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async ingestAndDeriveForBook(params: {
    userId: number;
    bookFileId: number;
    bookId: number;
    libraryId: number;
    deviceId: string;
    deviceModel?: string | null;
    events: KoreaderPageEvent[];
    timeZone: string;
  }): Promise<IngestPageStatsResult> {
    const { userId, bookFileId, bookId, libraryId, deviceId, deviceModel, events, timeZone } = params;
    // Distinguish Crosspoint/CrossInk devices from generic KOReader by their reported model,
    // so the derived reading sessions carry a 'crosspoint' source badge.
    const source = resolveDeviceSource(deviceModel);

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.koreaderPageStats)
        .values(
          events.map((event) => ({
            userId,
            bookFileId,
            deviceId,
            page: event.page,
            startTime: event.startTime,
            durationSeconds: event.durationSeconds,
            totalPages: event.totalPages,
          })),
        )
        .onConflictDoNothing({
          target: [
            schema.koreaderPageStats.userId,
            schema.koreaderPageStats.bookFileId,
            schema.koreaderPageStats.deviceId,
            schema.koreaderPageStats.page,
            schema.koreaderPageStats.startTime,
          ],
        })
        .returning({ startTime: schema.koreaderPageStats.startTime });

      const accepted = inserted.length;
      const duplicates = events.length - accepted;
      if (accepted === 0) {
        return { accepted, duplicates, insertedSessions: [], updatedSessions: [], deletedSessions: 0 };
      }

      // Only the clusters the new events belong to can change, so derivation reads and
      // rewrites that window instead of the book's whole history on every batch.
      const window = await this.findAffectedWindow(tx, {
        userId,
        bookFileId,
        deviceId,
        firstInsertedStart: Math.min(...inserted.map((row) => row.startTime)),
        lastInsertedStart: Math.max(...inserted.map((row) => row.startTime)),
      });

      const windowEvents = await tx
        .select({
          page: schema.koreaderPageStats.page,
          startTime: schema.koreaderPageStats.startTime,
          durationSeconds: schema.koreaderPageStats.durationSeconds,
          totalPages: schema.koreaderPageStats.totalPages,
        })
        .from(schema.koreaderPageStats)
        .where(
          and(
            eq(schema.koreaderPageStats.userId, userId),
            eq(schema.koreaderPageStats.bookFileId, bookFileId),
            eq(schema.koreaderPageStats.deviceId, deviceId),
            gte(schema.koreaderPageStats.startTime, window.firstStart),
            lte(schema.koreaderPageStats.startTime, window.lastStart),
          ),
        )
        .orderBy(schema.koreaderPageStats.startTime, schema.koreaderPageStats.page);

      const desired = deriveKoreaderSessions(windowEvents, deviceId, bookFileId);
      const prefix = buildSessionIdPrefix(deviceId, bookFileId);

      // Selected by time overlap rather than by recomputed id: a merged cluster changes
      // its session id, and the superseded row is only findable by its time range.
      const existing = await tx
        .select({
          id: schema.readingSessions.id,
          sessionId: schema.readingSessions.sessionId,
          startedAt: schema.readingSessions.startedAt,
          endedAt: schema.readingSessions.endedAt,
          durationSeconds: schema.readingSessions.durationSeconds,
          progressDelta: schema.readingSessions.progressDelta,
          endProgress: schema.readingSessions.endProgress,
        })
        .from(schema.readingSessions)
        .where(
          and(
            eq(schema.readingSessions.userId, userId),
            eq(schema.readingSessions.bookFileId, bookFileId),
            like(schema.readingSessions.sessionId, `${prefix}%`),
            lte(schema.readingSessions.startedAt, new Date(window.endSeconds * 1000)),
            gte(schema.readingSessions.endedAt, new Date(window.firstStart * 1000)),
          ),
        );

      const desiredById = new Map(desired.map((session) => [session.sessionId, session]));
      const existingById = new Map(existing.map((session) => [session.sessionId, session]));

      const toDelete = existing.filter((session) => !desiredById.has(session.sessionId));
      const toInsert = desired.filter((session) => !existingById.has(session.sessionId));
      const toUpdate = desired.filter((session) => {
        const current = existingById.get(session.sessionId);
        if (!current) return false;
        return (
          current.endedAt.getTime() !== session.endedAt.getTime() ||
          current.durationSeconds !== session.durationSeconds ||
          (current.progressDelta ?? null) !== (session.progressDelta ?? null) ||
          (current.endProgress ?? null) !== (session.endProgress ?? null)
        );
      });

      if (toDelete.length > 0) {
        await tx.delete(schema.readingSessions).where(
          inArray(
            schema.readingSessions.id,
            toDelete.map((session) => session.id),
          ),
        );
      }

      const upserts = [...toInsert, ...toUpdate];
      if (upserts.length > 0) {
        await tx
          .insert(schema.readingSessions)
          .values(
            upserts.map((session) => ({
              userId,
              bookFileId,
              bookId,
              attemptId: sql`(select id from reading_attempts where user_id = ${userId} and book_id = ${bookId} and outcome is null and deleted_at is null limit 1)`,
              sessionId: session.sessionId,
              source,
              startedAt: session.startedAt,
              endedAt: session.endedAt,
              durationSeconds: session.durationSeconds,
              progressDelta: session.progressDelta,
              endProgress: session.endProgress,
            })),
          )
          .onConflictDoUpdate({
            target: [schema.readingSessions.userId, schema.readingSessions.sessionId],
            set: {
              endedAt: sql`excluded.ended_at`,
              durationSeconds: sql`excluded.duration_seconds`,
              progressDelta: sql`excluded.progress_delta`,
              endProgress: sql`excluded.end_progress`,
              attemptId: sql`coalesce(excluded.attempt_id, ${schema.readingSessions.attemptId})`,
            },
          });
      }

      const affectedDays = new Set<string>();
      for (const session of toDelete) {
        for (const day of getReadingSessionDayKeys(
          {
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            durationSeconds: session.durationSeconds,
            progressDelta: session.progressDelta ?? null,
          },
          timeZone,
        )) {
          affectedDays.add(day);
        }
      }
      for (const session of upserts) {
        for (const day of getReadingSessionDayKeys(session, timeZone)) {
          affectedDays.add(day);
        }
      }

      if (affectedDays.size > 0) {
        await this.recomputeDailyStats(tx, userId, libraryId, [...affectedDays], timeZone);
      }

      return {
        accepted,
        duplicates,
        insertedSessions: toInsert,
        updatedSessions: toUpdate,
        deletedSessions: toDelete.length,
      };
    });
  }

  /**
   * Freezes the two keyset domains used by a device mirror. Raw
   * KOReader/Crosspoint events are exported losslessly; all other session
   * sources are exported once as deterministic synthetic page rows.
   */
  async getStatisticsMirrorBounds(userId: number, accessibleLibraryIds: number[] | null): Promise<StatisticsMirrorBounds> {
    if (accessibleLibraryIds !== null && accessibleLibraryIds.length === 0) {
      return { pageMaxId: 0, sessionMaxId: 0, generation: 'v2-empty' };
    }
    const libraryFilter = accessibleLibraryIds ? inArray(schema.books.libraryId, accessibleLibraryIds) : undefined;
    const sessionSourceFilter = or(isNull(schema.readingSessions.source), notInArray(schema.readingSessions.source, [...MIRRORED_SESSION_SOURCES]));
    const [[page], [session], [catalog], [authorState]] = await Promise.all([
      this.db
        .select({
          maxId: sql<number>`coalesce(max(${schema.koreaderPageStats.id}), 0)::int`,
          rowCount: sql<string>`count(*)::text`,
        })
        .from(schema.koreaderPageStats)
        .innerJoin(schema.bookFiles, eq(schema.bookFiles.id, schema.koreaderPageStats.bookFileId))
        .innerJoin(schema.books, eq(schema.books.id, schema.bookFiles.bookId))
        .where(and(eq(schema.koreaderPageStats.userId, userId), libraryFilter, isNotNull(schema.bookFiles.fileHash))),
      this.db
        .select({
          maxId: sql<number>`coalesce(max(${schema.readingSessions.id}), 0)::int`,
          rowCount: sql<string>`count(*)::text`,
          durationSum: sql<string>`coalesce(sum(${schema.readingSessions.durationSeconds}), 0)::text`,
          startedChecksum: sql<string>`coalesce(sum(extract(epoch from ${schema.readingSessions.startedAt})::numeric), 0)::text`,
          endedChecksum: sql<string>`coalesce(sum(extract(epoch from ${schema.readingSessions.endedAt})::numeric), 0)::text`,
          progressChecksum: sql<string>`coalesce(sum(coalesce(${schema.readingSessions.endProgress}, 0)::numeric), 0)::text`,
        })
        .from(schema.readingSessions)
        .innerJoin(schema.books, eq(schema.books.id, schema.readingSessions.bookId))
        .where(and(eq(schema.readingSessions.userId, userId), libraryFilter, sessionSourceFilter)),
      this.db
        .select({
          bookCount: sql<string>`count(distinct ${schema.books.id})::text`,
          fileCount: sql<string>`count(distinct ${schema.bookFiles.id})::text`,
          fileChecksum: sql<string>`md5(coalesce(string_agg(${schema.bookFiles.id}::text || ':' || coalesce(${schema.bookFiles.fileHash}, ''), '|' order by ${schema.bookFiles.id}), ''))`,
          booksUpdated: sql<string>`coalesce(max(${schema.books.updatedAt})::text, '')`,
          filesUpdated: sql<string>`coalesce(max(${schema.bookFiles.updatedAt})::text, '')`,
          metadataUpdated: sql<string>`coalesce(max(${schema.bookMetadata.updatedAt})::text, '')`,
          physicalUpdated: sql<string>`coalesce(max(${schema.bookPhysicalCopies.updatedAt})::text, '')`,
        })
        .from(schema.books)
        .leftJoin(schema.bookFiles, eq(schema.bookFiles.bookId, schema.books.id))
        .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
        .leftJoin(schema.bookPhysicalCopies, and(eq(schema.bookPhysicalCopies.bookId, schema.books.id), eq(schema.bookPhysicalCopies.userId, userId)))
        .where(libraryFilter),
      this.db
        .select({
          relationCount: sql<string>`count(*)::text`,
          checksum: sql<string>`md5(coalesce(string_agg(${schema.bookAuthors.bookId}::text || ':' || ${schema.bookAuthors.authorId}::text || ':' || ${schema.bookAuthors.displayOrder}::text || ':' || ${schema.authors.name}, '|' order by ${schema.bookAuthors.bookId}, ${schema.bookAuthors.displayOrder}, ${schema.bookAuthors.authorId}), ''))`,
        })
        .from(schema.bookAuthors)
        .innerJoin(schema.authors, eq(schema.authors.id, schema.bookAuthors.authorId))
        .innerJoin(schema.books, eq(schema.books.id, schema.bookAuthors.bookId))
        .where(libraryFilter),
    ]);
    const pageMaxId = numberValue(page?.maxId);
    const sessionMaxId = numberValue(session?.maxId);
    const fingerprint = [
      page?.rowCount,
      pageMaxId,
      session?.rowCount,
      sessionMaxId,
      session?.durationSum,
      session?.startedChecksum,
      session?.endedChecksum,
      session?.progressChecksum,
      catalog?.bookCount,
      catalog?.fileCount,
      catalog?.fileChecksum,
      catalog?.booksUpdated,
      catalog?.filesUpdated,
      catalog?.metadataUpdated,
      catalog?.physicalUpdated,
      authorState?.relationCount,
      authorState?.checksum,
    ];
    const generation = `v2-${createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex').slice(0, 32)}`;
    return { pageMaxId, sessionMaxId, generation };
  }

  async getStatisticsMirrorPage(params: {
    userId: number;
    accessibleLibraryIds: number[] | null;
    bounds: StatisticsMirrorBounds;
    pageAfterId: number;
    sessionAfterId: number;
    limit: number;
  }): Promise<{ rows: StatisticsMirrorRow[]; pageAfterId: number; sessionAfterId: number }> {
    const { userId, accessibleLibraryIds, bounds, limit } = params;
    if ((accessibleLibraryIds !== null && accessibleLibraryIds.length === 0) || limit <= 0) {
      return { rows: [], pageAfterId: bounds.pageMaxId, sessionAfterId: bounds.sessionMaxId };
    }

    let pageAfterId = params.pageAfterId;
    let sessionAfterId = params.sessionAfterId;
    const rows: StatisticsMirrorRow[] = [];
    const libraryFilter = accessibleLibraryIds ? inArray(schema.books.libraryId, accessibleLibraryIds) : undefined;
    const authorsExpr = sql<string>`coalesce((select string_agg(${schema.authors.name}, ', ' order by ${schema.bookAuthors.displayOrder}, ${schema.bookAuthors.authorId}) from ${schema.bookAuthors} inner join ${schema.authors} on ${schema.authors.id} = ${schema.bookAuthors.authorId} where ${schema.bookAuthors.bookId} = ${schema.books.id}), '')`;
    const titleExpr = sql<string>`coalesce(nullif(${schema.bookMetadata.title}, ''), 'Book ' || ${schema.books.id}::text)`;
    const pagesExpr = sql<number>`greatest(coalesce(${schema.bookPhysicalCopies.pageCount}, ${schema.bookMetadata.pageCount}, 100), 1)::int`;

    if (pageAfterId < bounds.pageMaxId && rows.length < limit) {
      const requested = limit - rows.length;
      const pageRows = await this.db
        .select({
          id: schema.koreaderPageStats.id,
          bookId: schema.books.id,
          hash: schema.bookFiles.fileHash,
          title: titleExpr,
          authors: authorsExpr,
          pages: pagesExpr,
          page: schema.koreaderPageStats.page,
          startTime: schema.koreaderPageStats.startTime,
          durationSeconds: schema.koreaderPageStats.durationSeconds,
          totalPages: schema.koreaderPageStats.totalPages,
        })
        .from(schema.koreaderPageStats)
        .innerJoin(schema.bookFiles, eq(schema.bookFiles.id, schema.koreaderPageStats.bookFileId))
        .innerJoin(schema.books, eq(schema.books.id, schema.bookFiles.bookId))
        .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
        .leftJoin(schema.bookPhysicalCopies, and(eq(schema.bookPhysicalCopies.bookId, schema.books.id), eq(schema.bookPhysicalCopies.userId, userId)))
        .where(
          and(
            eq(schema.koreaderPageStats.userId, userId),
            libraryFilter,
            isNotNull(schema.bookFiles.fileHash),
            gt(schema.koreaderPageStats.id, pageAfterId),
            lte(schema.koreaderPageStats.id, bounds.pageMaxId),
          ),
        )
        .orderBy(schema.koreaderPageStats.id)
        .limit(requested);
      for (const row of pageRows) {
        rows.push({
          id: row.id,
          kind: 'page',
          bookId: row.bookId,
          hash: row.hash!,
          title: row.title,
          authors: row.authors,
          pages: numberValue(row.pages),
          page: row.page,
          startTime: numberValue(row.startTime),
          durationSeconds: row.durationSeconds,
          totalPages: row.totalPages,
        });
      }
      if (pageRows.length > 0) pageAfterId = pageRows.at(-1)!.id;
      if (pageRows.length < requested) pageAfterId = bounds.pageMaxId;
    }

    if (pageAfterId >= bounds.pageMaxId && sessionAfterId < bounds.sessionMaxId && rows.length < limit) {
      const requested = limit - rows.length;
      const sessionSourceFilter = or(isNull(schema.readingSessions.source), notInArray(schema.readingSessions.source, [...MIRRORED_SESSION_SOURCES]));
      const hashExpr = sql<string>`coalesce(
        (select ${schema.bookFiles.fileHash} from ${schema.bookFiles}
          where ${schema.bookFiles.bookId} = ${schema.books.id} and ${schema.bookFiles.fileHash} is not null
          order by case lower(coalesce(${schema.bookFiles.format}, '')) when 'epub' then 0 when 'pdf' then 1 else 2 end,
                   case ${schema.bookFiles.role} when 'content' then 0 else 1 end,
                   ${schema.bookFiles.id}
          limit 1),
        md5('bookorbit-book:' || ${schema.books.id}::text))`;
      const sessionRows = await this.db
        .select({
          id: schema.readingSessions.id,
          bookId: schema.books.id,
          hash: hashExpr,
          title: titleExpr,
          authors: authorsExpr,
          pages: pagesExpr,
          startedAt: schema.readingSessions.startedAt,
          endedAt: schema.readingSessions.endedAt,
          durationSeconds: schema.readingSessions.durationSeconds,
          endProgress: schema.readingSessions.endProgress,
        })
        .from(schema.readingSessions)
        .innerJoin(schema.books, eq(schema.books.id, schema.readingSessions.bookId))
        .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
        .leftJoin(schema.bookPhysicalCopies, and(eq(schema.bookPhysicalCopies.bookId, schema.books.id), eq(schema.bookPhysicalCopies.userId, userId)))
        .where(
          and(
            eq(schema.readingSessions.userId, userId),
            libraryFilter,
            sessionSourceFilter,
            gt(schema.readingSessions.id, sessionAfterId),
            lte(schema.readingSessions.id, bounds.sessionMaxId),
          ),
        )
        .orderBy(schema.readingSessions.id)
        .limit(requested);
      for (const row of sessionRows) {
        const progressPage = Math.round(((row.endProgress ?? 0) / 100) * SYNTHETIC_TOTAL_PAGES);
        const page = Math.max(1, Math.min(SYNTHETIC_TOTAL_PAGES, progressPage + (row.id % 7)));
        rows.push({
          id: row.id,
          kind: 'session',
          bookId: row.bookId,
          hash: row.hash,
          title: row.title,
          authors: row.authors,
          pages: numberValue(row.pages),
          page,
          startTime: Math.floor(row.startedAt.getTime() / 1000),
          endedAt: row.endedAt,
          durationSeconds: Math.min(Math.max(row.durationSeconds, 0), KOREADER_MAX_EVENT_DURATION_SECONDS),
          totalPages: SYNTHETIC_TOTAL_PAGES,
        });
      }
      if (sessionRows.length > 0) sessionAfterId = sessionRows.at(-1)!.id;
      if (sessionRows.length < requested) sessionAfterId = bounds.sessionMaxId;
    }

    return { rows, pageAfterId, sessionAfterId };
  }

  /**
   * Grows the newly inserted events outward over stored events until a gap strictly
   * larger than the session gap terminates each side, so the returned start-time range
   * holds only complete clusters. Sessions outside it cannot change.
   *
   * Batches are not guaranteed to be chronological: retries, plugin state resets, and
   * KOReader's own device-to-device statistics sync can deliver events older than
   * history the server already holds, and such an insert can merge a preceding and a
   * following cluster into one session.
   */
  private async findAffectedWindow(
    tx: Tx,
    params: { userId: number; bookFileId: number; deviceId: string; firstInsertedStart: number; lastInsertedStart: number },
  ): Promise<{ firstStart: number; lastStart: number; endSeconds: number }> {
    const { userId, bookFileId, deviceId } = params;
    const scope = and(
      eq(schema.koreaderPageStats.userId, userId),
      eq(schema.koreaderPageStats.bookFileId, bookFileId),
      eq(schema.koreaderPageStats.deviceId, deviceId),
    );
    const eventEnd = sql<string | number | null>`max(${schema.koreaderPageStats.startTime} + ${schema.koreaderPageStats.durationSeconds})`;

    let firstStart = params.firstInsertedStart;
    for (;;) {
      const [row] = await tx
        .select({ earliest: sql<string | number | null>`min(${schema.koreaderPageStats.startTime})` })
        .from(schema.koreaderPageStats)
        .where(
          and(
            scope,
            lt(schema.koreaderPageStats.startTime, firstStart),
            // The duration cap bounds how far back a chaining event can start, keeping
            // this an index range scan instead of a walk over the book's whole history.
            gte(schema.koreaderPageStats.startTime, firstStart - KOREADER_SESSION_GAP_SECONDS - KOREADER_MAX_EVENT_DURATION_SECONDS),
            gte(sql`${schema.koreaderPageStats.startTime} + ${schema.koreaderPageStats.durationSeconds}`, firstStart - KOREADER_SESSION_GAP_SECONDS),
          ),
        );
      const earliest = toSeconds(row?.earliest);
      if (earliest == null || earliest >= firstStart) break;
      firstStart = earliest;
    }

    let lastStart = params.lastInsertedStart;
    const [seed] = await tx
      .select({ maxEnd: eventEnd })
      .from(schema.koreaderPageStats)
      .where(and(scope, gte(schema.koreaderPageStats.startTime, firstStart), lte(schema.koreaderPageStats.startTime, lastStart)));
    let endSeconds = toSeconds(seed?.maxEnd) ?? lastStart;

    for (;;) {
      const [row] = await tx
        .select({ latest: sql<string | number | null>`max(${schema.koreaderPageStats.startTime})`, maxEnd: eventEnd })
        .from(schema.koreaderPageStats)
        .where(
          and(
            scope,
            gt(schema.koreaderPageStats.startTime, lastStart),
            lte(schema.koreaderPageStats.startTime, endSeconds + KOREADER_SESSION_GAP_SECONDS),
          ),
        );
      const latest = toSeconds(row?.latest);
      if (latest == null || latest <= lastStart) break;
      lastStart = latest;
      endSeconds = Math.max(endSeconds, toSeconds(row?.maxEnd) ?? endSeconds);
    }

    return { firstStart, lastStart, endSeconds };
  }

  private async recomputeDailyStats(tx: Tx, userId: number, libraryId: number, days: string[], timeZone: string) {
    const affectedDays = [...new Set(days)].sort();
    if (affectedDays.length === 0) return;

    await this.lockDailyStats(tx, userId, libraryId);

    await tx
      .delete(schema.userReadingDailyStats)
      .where(
        and(
          eq(schema.userReadingDailyStats.userId, userId),
          eq(schema.userReadingDailyStats.libraryId, libraryId),
          inArray(schema.userReadingDailyStats.day, affectedDays),
        ),
      );

    const range = getDayRangeForDateKeys(affectedDays, timeZone);
    if (!range) return;

    const rows = await tx
      .select({
        startedAt: schema.readingSessions.startedAt,
        endedAt: schema.readingSessions.endedAt,
        durationSeconds: schema.readingSessions.durationSeconds,
        progressDelta: schema.readingSessions.progressDelta,
      })
      .from(schema.readingSessions)
      .innerJoin(schema.books, eq(schema.books.id, schema.readingSessions.bookId))
      .where(
        and(
          eq(schema.readingSessions.userId, userId),
          eq(schema.books.libraryId, libraryId),
          lt(schema.readingSessions.startedAt, range.end),
          gt(schema.readingSessions.endedAt, range.start),
        ),
      );

    const segments = aggregateReadingSessionDailyStats(
      rows.map((row) => ({
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        durationSeconds: row.durationSeconds,
        progressDelta: row.progressDelta ?? null,
      })),
      timeZone,
      new Set(affectedDays),
    );
    await this.insertDailyStatsSegments(tx, userId, libraryId, segments);
  }

  private async lockDailyStats(tx: Tx, userId: number, libraryId: number): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(${userId}::int, ${libraryId}::int)`);
  }

  private async insertDailyStatsSegments(tx: Tx, userId: number, libraryId: number, segments: ReadingDailyStatsSegment[]): Promise<void> {
    if (segments.length === 0) return;

    const now = new Date();
    await tx
      .insert(schema.userReadingDailyStats)
      .values(
        segments.map((segment) => ({
          userId,
          libraryId,
          day: segment.day,
          readingSeconds: segment.readingSeconds,
          progressDelta: segment.progressDelta,
          sessionsCount: segment.sessionsCount,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [schema.userReadingDailyStats.userId, schema.userReadingDailyStats.libraryId, schema.userReadingDailyStats.day],
        set: {
          readingSeconds: sql`excluded.reading_seconds`,
          progressDelta: sql`excluded.progress_delta`,
          sessionsCount: sql`excluded.sessions_count`,
          updatedAt: now,
        },
      });
  }

  async getRatings(userId: number, bookIds: number[]): Promise<Map<number, { rating: number | null; updatedAt: Date }>> {
    const ratings = new Map<number, { rating: number | null; updatedAt: Date }>();
    for (const batch of chunk([...new Set(bookIds)], BATCH_QUERY_SIZE)) {
      const rows = await this.db
        .select({
          bookId: schema.userBookRatings.bookId,
          rating: schema.userBookRatings.rating,
          updatedAt: schema.userBookRatings.updatedAt,
        })
        .from(schema.userBookRatings)
        .where(and(eq(schema.userBookRatings.userId, userId), inArray(schema.userBookRatings.bookId, batch)));
      for (const row of rows) {
        ratings.set(row.bookId, { rating: row.rating, updatedAt: row.updatedAt });
      }
    }
    return ratings;
  }

  /**
   * Entries must already be deduplicated by book: Postgres rejects an ON CONFLICT
   * DO UPDATE that would touch the same row twice in one statement.
   */
  async upsertRatings(userId: number, entries: { bookId: number; rating: number | null }[], updatedAt: Date): Promise<void> {
    for (const batch of chunk(entries, BATCH_QUERY_SIZE)) {
      await this.db
        .insert(schema.userBookRatings)
        .values(batch.map((entry) => ({ userId, bookId: entry.bookId, rating: entry.rating, updatedAt })))
        .onConflictDoUpdate({
          target: [schema.userBookRatings.userId, schema.userBookRatings.bookId],
          set: { rating: sql`excluded.rating`, updatedAt: sql`excluded.updated_at` },
        });
    }
  }

  async upsertSweep(data: {
    userId: number;
    deviceId: string;
    deviceModel: string;
    pluginVersion: string;
    booksMatched: number;
    pageStatsUploaded: number;
    annotationsUpserted: number;
  }): Promise<Date> {
    const lastSweepAt = new Date();
    await this.db
      .insert(schema.koreaderDeviceSweeps)
      .values({
        userId: data.userId,
        deviceId: data.deviceId,
        deviceModel: data.deviceModel,
        pluginVersion: data.pluginVersion,
        lastSweepAt,
        lastSweepBooksMatched: data.booksMatched,
        lastSweepPageStats: data.pageStatsUploaded,
        lastSweepAnnotations: data.annotationsUpserted,
      })
      .onConflictDoUpdate({
        target: [schema.koreaderDeviceSweeps.userId, schema.koreaderDeviceSweeps.deviceId],
        set: {
          deviceModel: data.deviceModel,
          pluginVersion: data.pluginVersion,
          lastSweepAt,
          lastSweepBooksMatched: data.booksMatched,
          lastSweepPageStats: data.pageStatsUploaded,
          lastSweepAnnotations: data.annotationsUpserted,
        },
      });
    return lastSweepAt;
  }

  async listSweeps(userId: number) {
    return this.db
      .select()
      .from(schema.koreaderDeviceSweeps)
      .where(eq(schema.koreaderDeviceSweeps.userId, userId))
      .orderBy(desc(schema.koreaderDeviceSweeps.lastSweepAt));
  }

  async listDevicePluginVersions(userId: number): Promise<(string | null)[]> {
    const rows = await this.db
      .selectDistinct({ pluginVersion: schema.koreaderDeviceSweeps.pluginVersion })
      .from(schema.koreaderDeviceSweeps)
      .where(eq(schema.koreaderDeviceSweeps.userId, userId));
    return rows.map((row) => row.pluginVersion);
  }

  async getPluginTotals(userId: number): Promise<{
    matchedBooks: number;
    pageStatEvents: number;
    annotations: number;
    trashedAnnotations: number;
    pendingDeletes: number;
    failedPositions: number;
    unmatchedBooks: number;
  }> {
    const result = await this.db.execute<{
      matched_books: string | number;
      page_stat_events: string | number;
      annotations: string | number;
      trashed_annotations: string | number;
      pending_deletes: string | number;
      failed_positions: string | number;
      unmatched_books: string | number;
    }>(sql`
      select
        (select count(distinct t.book_file_id) from (
          select book_file_id from koreader_page_stats where user_id = ${userId}
          union
          select ap.book_file_id from annotation_positions ap
            join annotations a on a.id = ap.annotation_id
            where a.user_id = ${userId} and a.origin = 'koreader' and ap.book_file_id is not null and ap.format in ('xpointer', 'pdf')
        ) t) as matched_books,
        (select count(*) from koreader_page_stats where user_id = ${userId}) as page_stat_events,
        (select count(*) from annotations where user_id = ${userId} and origin = 'koreader' and deleted_at is null) as annotations,
        (select count(*) from annotations where user_id = ${userId} and deleted_at is not null) as trashed_annotations,
        (select count(*) from annotation_sync_state s
          join annotations a on a.id = s.annotation_id
          where s.user_id = ${userId} and a.deleted_at is not null and s.delete_acked_at is null) as pending_deletes,
        (select count(*) from annotation_positions ap
          join annotations a on a.id = ap.annotation_id
          where ap.user_id = ${userId} and a.deleted_at is null and ap.status = 'failed') as failed_positions,
        (select count(*) from koreader_unmatched_books
          where user_id = ${userId}
            and source in ('current_file', 'file')
            and metadata_ambiguous = false) as unmatched_books
    `);
    const row = result.rows[0];
    return {
      matchedBooks: Number(row?.matched_books ?? 0),
      pageStatEvents: Number(row?.page_stat_events ?? 0),
      annotations: Number(row?.annotations ?? 0),
      trashedAnnotations: Number(row?.trashed_annotations ?? 0),
      pendingDeletes: Number(row?.pending_deletes ?? 0),
      failedPositions: Number(row?.failed_positions ?? 0),
      unmatchedBooks: Number(row?.unmatched_books ?? 0),
    };
  }

  async getLibraryMaxFileTimestamp(accessibleLibraryIds: number[] | null): Promise<Date | null> {
    if (accessibleLibraryIds !== null && accessibleLibraryIds.length === 0) return null;
    const libraryFilter = accessibleLibraryIds ? inArray(schema.books.libraryId, accessibleLibraryIds) : undefined;

    const [row] = await this.db
      .select({ maxTs: sql<Date | string | null>`max(greatest(${schema.bookFiles.createdAt}, ${schema.bookFiles.updatedAt}))` })
      .from(schema.bookFiles)
      .innerJoin(schema.books, eq(schema.books.id, schema.bookFiles.bookId))
      .where(libraryFilter);

    return row?.maxTs ? new Date(row.maxTs) : null;
  }

  async getHashLinkVersion(userId: number): Promise<{ count: number; maxTs: Date | null }> {
    const [row] = await this.db
      .select({
        count: sql<number | string>`count(*)`,
        maxTs: sql<Date | string | null>`max(${schema.koreaderBookHashLinks.updatedAt})`,
      })
      .from(schema.koreaderBookHashLinks)
      .where(eq(schema.koreaderBookHashLinks.userId, userId));

    return { count: Number(row?.count ?? 0), maxTs: row?.maxTs ? new Date(row.maxTs) : null };
  }
}
