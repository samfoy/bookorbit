import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { catchError, lastValueFrom, of, take, takeUntil, timer, toArray } from 'rxjs';
import type { MetadataCandidate, PhysicalCopySummary } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { mapWithConcurrency } from '../../common/utils/batch.utils';
import { parseIsbn } from '../../common/utils/isbn.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { addDateKeyDays, getDayRangeForDateKeys } from '../../common/utils/reading-daily-stats.utils';
import { resolveTimeZone, toDateKeyInTimeZone } from '../../common/utils/timezone.utils';
import type { BookPhysicalCopy } from '../../db/schema';
import { LibraryService } from '../library/library.service';
import { MetadataFetchService } from '../metadata-fetch/metadata-fetch.service';
import { MetadataService } from '../metadata/metadata.service';
import { ReadingSessionService } from '../reading-session/reading-session.service';
import { BulkImportPhysicalBooksDto, CreatePhysicalBookDto, LogProgressDto, UpdatePhysicalCopyDto } from './dto';
import { PhysicalBookRepository } from './physical-book.repository';
import { buildCopySummary } from './utils/copy-summary.utils';
import { candidateToMetadataFields, pickBestCandidate } from './utils/candidate-merge.utils';
import { PACE_WINDOW_DAYS, paceFromProgressDelta } from './utils/loan-urgency.utils';

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
    private readonly readingSessionService: ReadingSessionService,
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

  async getCopy(bookId: number, user: RequestUser): Promise<PhysicalCopySummary> {
    const context = await this.requireCopyContext(bookId, user);
    const paceLast7Days = await this.computePaceLast7Days(user, bookId, context);
    return buildCopySummary(context.copy, context.metadataPageCount, paceLast7Days, this.resolveUserTimeZone(user));
  }

  /**
   * The primary daily interaction: the reader closes the book and tells us the page they reached.
   */
  async logProgress(bookId: number, dto: LogProgressDto, user: RequestUser): Promise<PhysicalCopySummary> {
    const event = 'physical_book.log_progress';
    const startedAtMs = Date.now();
    this.logger.log(
      `[${event}] [start] bookId=${bookId} userId=${user.id} currentPage=${dto.currentPage} minutes=${dto.minutes ?? 'none'} - log progress started`,
    );

    try {
      const context = await this.requireCopyContext(bookId, user);
      const timeZone = this.resolveUserTimeZone(user);
      const effectivePageCount = context.copy.pageCount ?? context.metadataPageCount ?? null;

      // A page beyond a known page count is a typo, not a reading milestone.
      if (effectivePageCount !== null && dto.currentPage > effectivePageCount) {
        throw new BadRequestException(`currentPage cannot exceed the page count of ${effectivePageCount}`);
      }
      // Correcting a mistyped page is allowed; claiming reading time for going backwards is not.
      if (dto.currentPage < context.copy.currentPage && dto.minutes !== undefined) {
        throw new BadRequestException('currentPage cannot decrease when reading time is reported');
      }

      const { startedAt, endedAt, durationSeconds } = this.resolveSessionWindow(dto);
      // Never invent a denominator: with no page count anywhere, the page is stored but there is
      // no percentage to report, so endProgress stays null.
      const endProgress = effectivePageCount ? Math.round((dto.currentPage / effectivePageCount) * 10000) / 100 : null;

      let sessionId: number | null = null;
      if (durationSeconds > 0 || dto.currentPage !== context.copy.currentPage) {
        const session = await this.readingSessionService.createPhysicalSession({
          userId: user.id,
          bookId,
          libraryId: context.libraryId,
          startedAt,
          endedAt,
          durationSeconds,
          endProgress,
          timeZone,
        });
        sessionId = session.id;
      }

      const updated = await this.repo.updateCopy(user.id, bookId, { currentPage: dto.currentPage });
      if (!updated) throw new NotFoundException('Physical copy not found');

      const finished = effectivePageCount !== null && dto.currentPage >= effectivePageCount;
      if (finished) await this.repo.markRead(user.id, bookId, endedAt, toDateKeyInTimeZone(endedAt, timeZone));
      else if (dto.currentPage > 0) await this.repo.markReading(user.id, bookId, startedAt);

      const paceLast7Days = await this.computePaceLast7Days(user, bookId, { ...context, copy: updated });

      this.logger.log(
        `[${event}] [end] bookId=${bookId} userId=${user.id} durationMs=${Date.now() - startedAtMs} currentPage=${dto.currentPage} effectivePageCount=${effectivePageCount ?? 'unknown'} sessionId=${sessionId ?? 'none'} finished=${finished} - log progress completed`,
      );

      return buildCopySummary(updated, context.metadataPageCount, paceLast7Days, timeZone);
    } catch (error) {
      const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
      this.logger.warn(
        `[${event}] [fail] bookId=${bookId} userId=${user.id} durationMs=${Date.now() - startedAtMs} errorClass=${errorClass} error="${sanitizeLogValue(error instanceof Error ? error.message : 'unknown error')}" - log progress failed`,
      );
      throw error;
    }
  }

  async updateCopy(bookId: number, dto: UpdatePhysicalCopyDto, user: RequestUser): Promise<PhysicalCopySummary> {
    const context = await this.requireCopyContext(bookId, user);

    const acquisition = dto.acquisition ?? context.copy.acquisition;
    const lender = dto.lender ?? context.copy.lender;
    // Re-checked here because a PATCH can flip acquisition without resending lender, which the
    // per-request DTO cannot see.
    if (acquisition !== 'owned' && !lender) {
      throw new BadRequestException('lender is required when acquisition is not owned');
    }

    const updated = await this.repo.updateCopy(user.id, bookId, { ...dto, acquisition, lender });
    if (!updated) throw new NotFoundException('Physical copy not found');

    const paceLast7Days = await this.computePaceLast7Days(user, bookId, { ...context, copy: updated });
    return buildCopySummary(updated, context.metadataPageCount, paceLast7Days, this.resolveUserTimeZone(user));
  }

  /** Closes out a loan. The book and its reading history stay; only the borrowing ends. */
  async returnCopy(bookId: number, user: RequestUser): Promise<PhysicalCopySummary> {
    const event = 'physical_book.return';
    const startedAtMs = Date.now();
    const context = await this.requireCopyContext(bookId, user);
    if (context.copy.acquisition === 'owned') {
      throw new BadRequestException('An owned copy cannot be returned');
    }

    const timeZone = this.resolveUserTimeZone(user);
    const updated = await this.repo.updateCopy(user.id, bookId, { returnedOn: toDateKeyInTimeZone(new Date(), timeZone) });
    if (!updated) throw new NotFoundException('Physical copy not found');

    this.logger.log(
      `[${event}] [end] bookId=${bookId} userId=${user.id} durationMs=${Date.now() - startedAtMs} returnedOn=${updated.returnedOn ?? 'none'} - return physical copy completed`,
    );

    const paceLast7Days = await this.computePaceLast7Days(user, bookId, { ...context, copy: updated });
    return buildCopySummary(updated, context.metadataPageCount, paceLast7Days, timeZone);
  }

  async deleteCopy(bookId: number, user: RequestUser): Promise<void> {
    const event = 'physical_book.delete';
    const startedAtMs = Date.now();
    await this.requireCopyContext(bookId, user);
    const deleted = await this.repo.deleteCopy(user.id, bookId);
    if (!deleted) throw new NotFoundException('Physical copy not found');
    this.logger.log(`[${event}] [end] bookId=${bookId} userId=${user.id} durationMs=${Date.now() - startedAtMs} - delete physical copy completed`);
  }

  private async requireCopyContext(bookId: number, user: RequestUser) {
    const context = await this.repo.findCopyContext(user.id, bookId);
    // The copy row is keyed by (userId, bookId), so a miss means either no such copy or it
    // belongs to somebody else. Both are reported the same way to avoid leaking existence.
    if (!context) throw new NotFoundException('Physical copy not found');
    return context;
  }

  private resolveSessionWindow(dto: LogProgressDto): { startedAt: Date; endedAt: Date; durationSeconds: number } {
    const endedAt = new Date();
    const durationSeconds = (dto.minutes ?? 0) * 60;

    if (dto.startedAt) {
      const startedAt = new Date(dto.startedAt);
      if (Number.isNaN(startedAt.getTime())) throw new BadRequestException('Invalid startedAt timestamp');
      if (startedAt.getTime() > endedAt.getTime()) throw new BadRequestException('startedAt cannot be in the future');
      return dto.minutes !== undefined
        ? { startedAt, endedAt: new Date(startedAt.getTime() + durationSeconds * 1000), durationSeconds }
        : { startedAt, endedAt, durationSeconds: 0 };
    }

    return { startedAt: new Date(endedAt.getTime() - durationSeconds * 1000), endedAt, durationSeconds };
  }

  /**
   * Pages per day over the trailing 7 days in the user's own timezone, so a session logged at
   * 11pm Pacific counts toward that Pacific day rather than the following UTC one.
   */
  private async computePaceLast7Days(
    user: RequestUser,
    bookId: number,
    context: { copy: BookPhysicalCopy; metadataPageCount: number | null },
  ): Promise<number> {
    const effectivePageCount = context.copy.pageCount ?? context.metadataPageCount ?? null;
    if (!effectivePageCount) return 0;

    const timeZone = this.resolveUserTimeZone(user);
    const today = toDateKeyInTimeZone(new Date(), timeZone);
    const days = Array.from({ length: PACE_WINDOW_DAYS }, (_, index) => addDateKeyDays(today, index - (PACE_WINDOW_DAYS - 1)));
    const range = getDayRangeForDateKeys(days, timeZone);
    if (!range) return 0;

    const progressDelta = await this.repo.sumProgressDeltaBetween(user.id, bookId, range.start, range.end);
    return paceFromProgressDelta(progressDelta, effectivePageCount);
  }

  private resolveUserTimeZone(user: RequestUser): string {
    return resolveTimeZone((user.settings as { timezone?: unknown } | undefined)?.timezone, 'UTC');
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
