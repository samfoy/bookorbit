import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { bookMetadata, bookPhysicalCopies, books, libraryFolders, userBookStatus } from '../../db/schema';
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
