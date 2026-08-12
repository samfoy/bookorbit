import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, notInArray, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { NotificationType, type PhysicalAcquisition } from '@bookorbit/types';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import {
  authors,
  bookAuthors,
  bookMetadata,
  bookPhysicalCopies,
  books,
  libraryFolders,
  notifications,
  readingAttempts,
  readingSessions,
  userBookStatus,
  users,
} from '../../db/schema';
import type { BookPhysicalCopy } from '../../db/schema';

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const ACTIVE_LOAN_COLUMNS = {
  bookId: bookPhysicalCopies.bookId,
  acquisition: bookPhysicalCopies.acquisition,
  lender: bookPhysicalCopies.lender,
  dueOn: bookPhysicalCopies.dueOn,
  returnedOn: bookPhysicalCopies.returnedOn,
  copyPageCount: bookPhysicalCopies.pageCount,
  currentPage: bookPhysicalCopies.currentPage,
  metadataPageCount: bookMetadata.pageCount,
  title: bookMetadata.title,
  coverSource: bookMetadata.coverSource,
} as const;

export interface ActiveLoanRow {
  bookId: number;
  acquisition: PhysicalAcquisition;
  lender: string | null;
  dueOn: string | null;
  returnedOn: string | null;
  copyPageCount: number | null;
  currentPage: number;
  metadataPageCount: number | null;
  title: string | null;
  coverSource: string | null;
}

export interface ActiveLoanSweepRow extends ActiveLoanRow {
  userId: number;
}

export interface PhysicalBookMetadataFields {
  title: string | null;
  subtitle: string | null;
  description: string | null;
  isbn10: string | null;
  isbn13: string | null;
  publisher: string | null;
  publishedDate: string | null;
  publishedYear: number | null;
  language: string | null;
  pageCount: number | null;
  seriesName: string | null;
  seriesIndex: number | null;
}

export interface CreatePhysicalBookParams {
  userId: number;
  libraryId: number;
  libraryFolderId: number;
  folderPath: string;
  metadata: PhysicalBookMetadataFields;
  copy: Omit<schema.NewBookPhysicalCopy, 'userId' | 'bookId'>;
}

@Injectable()
export class PhysicalBookRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findFirstFolderId(libraryId: number): Promise<number | null> {
    const [folder] = await this.db
      .select({ id: libraryFolders.id })
      .from(libraryFolders)
      .where(eq(libraryFolders.libraryId, libraryId))
      .orderBy(libraryFolders.id)
      .limit(1);
    return folder?.id ?? null;
  }

  /**
   * Finds an existing physical copy this user already owns for the given ISBN, so a rescan of
   * the same barcode returns a 409 pointing at the existing book instead of creating a twin.
   */
  async findExistingCopyByIsbn13(userId: number, libraryId: number, isbn13: string): Promise<{ bookId: number } | null> {
    const [row] = await this.db
      .select({ bookId: bookPhysicalCopies.bookId })
      .from(bookPhysicalCopies)
      .innerJoin(books, eq(books.id, bookPhysicalCopies.bookId))
      .innerJoin(bookMetadata, eq(bookMetadata.bookId, bookPhysicalCopies.bookId))
      .where(and(eq(bookPhysicalCopies.userId, userId), eq(books.libraryId, libraryId), eq(bookMetadata.isbn13, isbn13)))
      .limit(1);
    return row ?? null;
  }

  async findCopy(userId: number, bookId: number): Promise<BookPhysicalCopy | null> {
    const [row] = await this.db
      .select()
      .from(bookPhysicalCopies)
      .where(and(eq(bookPhysicalCopies.userId, userId), eq(bookPhysicalCopies.bookId, bookId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Returns the copy plus the context a page log needs: the library for the session row, the
   * metadata page count that backs effectivePageCount, and the book title.
   */
  async findCopyContext(
    userId: number,
    bookId: number,
  ): Promise<{ copy: BookPhysicalCopy; libraryId: number; metadataPageCount: number | null; title: string | null } | null> {
    const [row] = await this.db
      .select({
        copy: bookPhysicalCopies,
        libraryId: books.libraryId,
        metadataPageCount: bookMetadata.pageCount,
        title: bookMetadata.title,
      })
      .from(bookPhysicalCopies)
      .innerJoin(books, eq(books.id, bookPhysicalCopies.bookId))
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, bookPhysicalCopies.bookId))
      .where(and(eq(bookPhysicalCopies.userId, userId), eq(bookPhysicalCopies.bookId, bookId)))
      .limit(1);
    return row ?? null;
  }

  async updateCopy(userId: number, bookId: number, values: Partial<schema.NewBookPhysicalCopy>): Promise<BookPhysicalCopy | null> {
    const [row] = await this.db
      .update(bookPhysicalCopies)
      .set(values)
      .where(and(eq(bookPhysicalCopies.userId, userId), eq(bookPhysicalCopies.bookId, bookId)))
      .returning();
    return row ?? null;
  }

  async deleteCopy(userId: number, bookId: number): Promise<boolean> {
    const deleted = await this.db
      .delete(bookPhysicalCopies)
      .where(and(eq(bookPhysicalCopies.userId, userId), eq(bookPhysicalCopies.bookId, bookId)))
      .returning({ bookId: bookPhysicalCopies.bookId });
    return deleted.length > 0;
  }

  /**
   * Pages read per day over a window, derived from physical sessions' progressDelta against the
   * effective page count. Bounds come from getDayRangeForDateKeys so the window follows the
   * user's timezone rather than the server's UTC clock.
   */
  async sumProgressDeltaBetween(userId: number, bookId: number, start: Date, end: Date): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string | null>`coalesce(sum(${readingSessions.progressDelta}), 0)` })
      .from(readingSessions)
      .where(
        and(
          eq(readingSessions.userId, userId),
          eq(readingSessions.bookId, bookId),
          gte(readingSessions.startedAt, start),
          lt(readingSessions.startedAt, end),
        ),
      );
    return Number(row?.total ?? 0);
  }

  /**
   * Same window as sumProgressDeltaBetween but for several books at once, grouped in the database.
   * The due-soon widget needs a pace per loan; one query per book would be an N+1.
   */
  async sumProgressDeltaByBook(userId: number, bookIds: number[], start: Date, end: Date): Promise<Map<number, number>> {
    if (bookIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        bookId: readingSessions.bookId,
        total: sql<string | null>`coalesce(sum(${readingSessions.progressDelta}), 0)`,
      })
      .from(readingSessions)
      .where(
        and(
          eq(readingSessions.userId, userId),
          inArray(readingSessions.bookId, bookIds),
          gte(readingSessions.startedAt, start),
          lt(readingSessions.startedAt, end),
        ),
      )
      .groupBy(readingSessions.bookId);

    return new Map(rows.map((row) => [row.bookId, Number(row.total ?? 0)]));
  }

  /**
   * Active loans for one user, nearest deadline first. `limit` is always applied: the widget shows
   * a shelf-sized list, never the whole loan history.
   */
  async findActiveLoans(userId: number, accessibleLibraryIds: number[], limit: number): Promise<ActiveLoanRow[]> {
    if (accessibleLibraryIds.length === 0) return [];

    return this.db
      .select(ACTIVE_LOAN_COLUMNS)
      .from(bookPhysicalCopies)
      .innerJoin(books, eq(books.id, bookPhysicalCopies.bookId))
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, bookPhysicalCopies.bookId))
      .where(
        and(
          eq(bookPhysicalCopies.userId, userId),
          inArray(books.libraryId, accessibleLibraryIds),
          isNotNull(bookPhysicalCopies.dueOn),
          isNull(bookPhysicalCopies.returnedOn),
        ),
      )
      .orderBy(bookPhysicalCopies.dueOn, bookPhysicalCopies.bookId)
      .limit(limit);
  }

  /**
   * Loans due inside a UTC date-key window, across all users, for the notification sweep.
   *
   * The window is deliberately a superset: each user's "days remaining" is computed in their own
   * timezone, which can sit up to a day either side of the server's UTC date, so the caller filters
   * precisely in JS. Bounding on due_on keeps this proportional to loans coming due rather than to
   * the whole library.
   */
  async findLoansDueBetween(startDateKey: string, endDateKey: string, limit: number, afterBookId = 0): Promise<ActiveLoanSweepRow[]> {
    return this.db
      .select({ ...ACTIVE_LOAN_COLUMNS, userId: bookPhysicalCopies.userId })
      .from(bookPhysicalCopies)
      .innerJoin(books, eq(books.id, bookPhysicalCopies.bookId))
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, bookPhysicalCopies.bookId))
      .where(
        and(
          isNull(bookPhysicalCopies.returnedOn),
          gte(bookPhysicalCopies.dueOn, startDateKey),
          lte(bookPhysicalCopies.dueOn, endDateKey),
          gt(bookPhysicalCopies.bookId, afterBookId),
        ),
      )
      .orderBy(bookPhysicalCopies.bookId)
      .limit(limit);
  }

  /** Timezone settings for the users the sweep is about to consider, so day math is per reader. */
  async findUserTimeZones(userIds: number[]): Promise<Map<number, unknown>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.db
      .select({ id: users.id, settings: users.settings })
      .from(users)
      .where(and(inArray(users.id, userIds), eq(users.active, true)));
    return new Map(rows.map((row) => [row.id, (row.settings as { timezone?: unknown } | null)?.timezone]));
  }

  /** Authors for a batch of books, so the widget avoids one query per row. */
  async findAuthorNamesByBook(bookIds: number[]): Promise<Map<number, string>> {
    if (bookIds.length === 0) return new Map();
    const rows = await this.db
      .select({ bookId: bookAuthors.bookId, name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(inArray(bookAuthors.bookId, bookIds))
      .orderBy(bookAuthors.bookId, bookAuthors.authorId);

    const byBook = new Map<number, string>();
    for (const row of rows) {
      if (!byBook.has(row.bookId)) byBook.set(row.bookId, row.name);
    }
    return byBook;
  }

  /**
   * The already-notified `bookId:milestone` pairs for one user, so a re-run of the sweep never
   * double-notifies. Compared as strings because notification meta is jsonb.
   */
  async findNotifiedMilestones(userId: number, bookIds: number[]): Promise<Set<string>> {
    if (bookIds.length === 0) return new Set();

    const rows = await this.db
      .select({
        bookId: sql<string>`${notifications.meta}->>'bookId'`,
        milestone: sql<string>`${notifications.meta}->>'milestone'`,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.type, NotificationType.PhysicalDueSoon),
          inArray(sql`(${notifications.meta}->>'bookId')::int`, bookIds),
        ),
      );

    return new Set(rows.filter((row) => row.bookId && row.milestone).map((row) => `${row.bookId}:${row.milestone}`));
  }

  async markRead(userId: number, bookId: number, finishedAt: Date, endedOn: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(userBookStatus)
        .values({ userId, bookId, status: 'read', source: 'auto', finishedAt })
        .onConflictDoUpdate({
          target: [userBookStatus.userId, userBookStatus.bookId],
          set: { status: 'read', finishedAt },
        });

      // Closes the open attempt so the next reread starts a fresh one. The partial unique index
      // reading_attempts_one_active_uidx guarantees there is at most one to close.
      await tx
        .update(readingAttempts)
        .set({ outcome: 'completed', endedOn })
        .where(
          and(
            eq(readingAttempts.userId, userId),
            eq(readingAttempts.bookId, bookId),
            isNull(readingAttempts.outcome),
            isNull(readingAttempts.deletedAt),
          ),
        );
    });
  }

  async markReading(userId: number, bookId: number, startedAt: Date): Promise<void> {
    await this.db
      .insert(userBookStatus)
      .values({ userId, bookId, status: 'reading', source: 'auto', startedAt })
      .onConflictDoUpdate({
        target: [userBookStatus.userId, userBookStatus.bookId],
        // Never downgrade a manually-set status, and never pull a finished book back to reading.
        set: { status: 'reading' },
        setWhere: and(eq(userBookStatus.source, 'auto'), notInArray(userBookStatus.status, ['read', 'reading'])),
      });
  }

  /**
   * Creates the book, its metadata row, the physical copy, and the reading status in ONE
   * transaction. `applyAuthors` runs inside that transaction so a provider author list cannot
   * land against a half-created book.
   */
  async createPhysicalBook(
    params: CreatePhysicalBookParams,
    applyAuthors?: (tx: Tx, bookId: number) => Promise<void>,
  ): Promise<{ bookId: number; copy: BookPhysicalCopy }> {
    const { userId, libraryId, libraryFolderId, folderPath, metadata, copy } = params;

    return this.db.transaction(async (tx) => {
      const [book] = await tx
        .insert(books)
        .values({ libraryId, libraryFolderId, folderPath, status: 'present', medium: 'physical' })
        .returning({ id: books.id });
      if (!book) throw new InternalServerErrorException('Failed to create book record');

      // Always create an empty metadata row first so joins never return null, then apply the
      // resolved fields. Mirrors the upload and scanner paths.
      await tx.insert(bookMetadata).values({ bookId: book.id });
      await tx.update(bookMetadata).set(metadata).where(eq(bookMetadata.bookId, book.id));

      if (applyAuthors) await applyAuthors(tx, book.id);

      const [insertedCopy] = await tx
        .insert(bookPhysicalCopies)
        .values({ ...copy, userId, bookId: book.id })
        .returning();
      if (!insertedCopy) throw new InternalServerErrorException('Failed to create physical copy record');

      await tx
        .insert(userBookStatus)
        .values({ userId, bookId: book.id, status: (copy.currentPage ?? 0) > 0 ? 'reading' : 'want_to_read', source: 'auto' })
        .onConflictDoNothing();

      return { bookId: book.id, copy: insertedCopy };
    });
  }
}
