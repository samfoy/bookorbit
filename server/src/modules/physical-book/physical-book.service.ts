import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { catchError, lastValueFrom, of, take, takeUntil, timer, toArray } from 'rxjs';
import type { MetadataCandidate } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { mapWithConcurrency } from '../../common/utils/batch.utils';
import { parseIsbn } from '../../common/utils/isbn.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { BookPhysicalCopy } from '../../db/schema';
import { LibraryService } from '../library/library.service';
import { MetadataFetchService } from '../metadata-fetch/metadata-fetch.service';
import { MetadataService } from '../metadata/metadata.service';
import { BulkImportPhysicalBooksDto, CreatePhysicalBookDto } from './dto';
import { PhysicalBookRepository } from './physical-book.repository';
import { candidateToMetadataFields, pickBestCandidate } from './utils/candidate-merge.utils';

// An ISBN lookup fans out across every provider; without a ceiling one slow provider would hold
// the request open for as long as its own timeout allows.
const LOOKUP_TIMEOUT_MS = 12_000;
const LOOKUP_MAX_CANDIDATES = 12;
// Bulk imports run provider lookups, so concurrency stays low to avoid tripping provider throttles.
const BULK_CONCURRENCY = 3;

export interface CreatePhysicalBookResult {
  bookId: number;
  copy: BookPhysicalCopy;
}

export interface BulkImportResult {
  created: { isbn: string; bookId: number }[];
  failed: { isbn: string; reason: string }[];
}

@Injectable()
export class PhysicalBookService {
  private readonly logger = new Logger(PhysicalBookService.name);

  constructor(
    private readonly repo: PhysicalBookRepository,
    private readonly metadataFetchService: MetadataFetchService,
    private readonly metadataService: MetadataService,
    private readonly libraryService: LibraryService,
  ) {}

  async lookupIsbn(rawIsbn: string, user: RequestUser): Promise<MetadataCandidate | null> {
    const parsed = parseIsbn(rawIsbn);
    if (!parsed) throw new BadRequestException('Invalid ISBN: checksum does not match');

    const event = 'physical_book.lookup';
    const startedAtMs = Date.now();
    this.logger.log(`[${event}] [start] userId=${user.id} isbn13=${parsed.isbn13} - isbn lookup started`);

    const candidates = await this.searchByIsbn(parsed.isbn13);
    const best = pickBestCandidate(candidates, parsed.isbn13);

    this.logger.log(
      `[${event}] [end] userId=${user.id} isbn13=${parsed.isbn13} durationMs=${Date.now() - startedAtMs} candidates=${candidates.length} matched=${best !== null} - isbn lookup completed`,
    );
    return best;
  }

  async createPhysicalBook(dto: CreatePhysicalBookDto, user: RequestUser): Promise<CreatePhysicalBookResult> {
    const event = 'physical_book.create';
    const startedAtMs = Date.now();
    const parsed = dto.isbn ? parseIsbn(dto.isbn) : null;
    if (dto.isbn && !parsed) throw new BadRequestException('Invalid ISBN: checksum does not match');

    this.logger.log(
      `[${event}] [start] userId=${user.id} libraryId=${dto.libraryId} isbn13=${parsed?.isbn13 ?? 'none'} acquisition=${dto.acquisition} - create physical book started`,
    );

    try {
      const libraryFolderId = await this.resolveLibraryFolder(dto.libraryId, user);

      if (parsed) {
        const existing = await this.repo.findExistingCopyByIsbn13(user.id, dto.libraryId, parsed.isbn13);
        if (existing) {
          throw new ConflictException({
            message: 'You already have a physical copy of this book',
            bookId: existing.bookId,
            isbn13: parsed.isbn13,
          });
        }
      }

      const candidate = parsed ? pickBestCandidate(await this.searchByIsbn(parsed.isbn13), parsed.isbn13) : null;
      const result = await this.persist(dto, user, libraryFolderId, candidate, parsed);

      this.logger.log(
        `[${event}] [end] userId=${user.id} libraryId=${dto.libraryId} bookId=${result.bookId} durationMs=${Date.now() - startedAtMs} metadataMatched=${candidate !== null} - create physical book completed`,
      );
      return result;
    } catch (error) {
      const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
      this.logger.warn(
        `[${event}] [fail] userId=${user.id} libraryId=${dto.libraryId} durationMs=${Date.now() - startedAtMs} errorClass=${errorClass} error="${sanitizeLogValue(error instanceof Error ? error.message : 'unknown error')}" - create physical book failed`,
      );
      throw error;
    }
  }

  async bulkImport(dto: BulkImportPhysicalBooksDto, user: RequestUser): Promise<BulkImportResult> {
    const event = 'physical_book.bulk_import';
    const startedAtMs = Date.now();
    this.logger.log(`[${event}] [start] userId=${user.id} libraryId=${dto.libraryId} total=${dto.isbns.length} - bulk import started`);

    // Checked once up front so a bad libraryId or a missing folder fails the whole request
    // instead of being reported as N identical per-ISBN failures.
    await this.resolveLibraryFolder(dto.libraryId, user);

    const created: BulkImportResult['created'] = [];
    const failed: BulkImportResult['failed'] = [];

    const outcomes = await mapWithConcurrency(dto.isbns, BULK_CONCURRENCY, async (rawIsbn) => {
      try {
        const result = await this.createPhysicalBook(
          { libraryId: dto.libraryId, isbn: rawIsbn, acquisition: dto.acquisition, lender: dto.lender },
          user,
        );
        return { isbn: rawIsbn, bookId: result.bookId, reason: null };
      } catch (error) {
        // One unreadable barcode must never abort the rest of a stack of books.
        return { isbn: rawIsbn, bookId: null, reason: this.describeFailure(error) };
      }
    });

    for (const outcome of outcomes) {
      if (outcome.bookId !== null) created.push({ isbn: outcome.isbn, bookId: outcome.bookId });
      else failed.push({ isbn: outcome.isbn, reason: outcome.reason ?? 'unknown error' });
    }

    this.logger.log(
      `[${event}] [end] userId=${user.id} libraryId=${dto.libraryId} durationMs=${Date.now() - startedAtMs} total=${dto.isbns.length} created=${created.length} failed=${failed.length} - bulk import completed`,
    );
    return { created, failed };
  }

  private async persist(
    dto: CreatePhysicalBookDto,
    user: RequestUser,
    libraryFolderId: number,
    candidate: MetadataCandidate | null,
    parsed: { isbn13: string; isbn10: string | null } | null,
  ): Promise<CreatePhysicalBookResult> {
    const metadata = candidateToMetadataFields(candidate, {
      title: dto.title,
      isbn13: parsed?.isbn13 ?? null,
      isbn10: parsed?.isbn10 ?? null,
      pageCount: dto.pageCount,
    });

    const authorNames = candidate?.authors?.length ? candidate.authors : dto.author ? [dto.author] : [];

    return this.repo.createPhysicalBook(
      {
        userId: user.id,
        libraryId: dto.libraryId,
        libraryFolderId,
        // Sentinel: physical books have no file on disk, but books.folder_path is NOT NULL and
        // unique per library, so each copy gets its own opaque non-filesystem path.
        folderPath: `physical://${randomUUID()}`,
        metadata,
        copy: {
          acquisition: dto.acquisition,
          pageCount: dto.pageCount ?? null,
          currentPage: dto.currentPage ?? 0,
          lender: dto.lender ?? null,
          dueOn: dto.dueOn ?? null,
          renewalLimit: dto.renewalLimit ?? null,
          binding: dto.binding ?? null,
          shelfLocation: dto.shelfLocation ?? null,
          acquiredOn: dto.acquiredOn ?? null,
          notes: dto.notes ?? null,
        },
      },
      authorNames.length > 0
        ? async (tx, bookId) => {
            await this.metadataService.replaceAuthors(
              bookId,
              authorNames.map((name) => ({ name, sortName: null })),
              { executor: tx, emitEvent: false },
            );
          }
        : undefined,
    );
  }

  private async resolveLibraryFolder(libraryId: number, user: RequestUser): Promise<number> {
    await this.libraryService.verifyUserAccess(user.id, libraryId, user.isSuperuser);
    const folderId = await this.repo.findFirstFolderId(libraryId);
    if (folderId === null) throw new BadRequestException('Library has no folders configured');
    return folderId;
  }

  /**
   * search() returns an Observable that merges every provider, so it must be collected as a
   * stream. Awaiting it directly yields the Observable itself and silently produces no metadata.
   */
  private async searchByIsbn(isbn13: string): Promise<MetadataCandidate[]> {
    return lastValueFrom(
      this.metadataFetchService.search({ isbn: isbn13 }).pipe(
        take(LOOKUP_MAX_CANDIDATES),
        // takeUntil rather than timeout: it completes the stream at the deadline so candidates
        // already returned by fast providers survive, where a timeout error would discard them.
        takeUntil(timer(LOOKUP_TIMEOUT_MS)),
        toArray(),
        // A dead or throttled provider must degrade to "no metadata found", not fail the import.
        catchError(() => of([] as MetadataCandidate[])),
      ),
      { defaultValue: [] as MetadataCandidate[] },
    );
  }

  private describeFailure(error: unknown): string {
    if (error instanceof ConflictException) {
      const response = error.getResponse();
      if (typeof response === 'object' && response !== null && 'bookId' in response) {
        return `already imported as book ${String((response as { bookId: number }).bookId)}`;
      }
      return 'already imported';
    }
    return error instanceof Error ? error.message : 'unknown error';
  }
}
