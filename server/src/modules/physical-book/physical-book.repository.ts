import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { and, eq, gte, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { bookMetadata, bookPhysicalCopies, books, libraryFolders, readingAttempts, readingSessions, userBookStatus } from '../../db/schema';
import type { BookPhysicalCopy } from '../../db/schema';

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

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
