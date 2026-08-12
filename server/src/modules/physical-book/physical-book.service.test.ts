import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EMPTY_CONTENT_FILTER_RULES, type MetadataCandidate } from '@bookorbit/types';
import { of } from 'rxjs';

import type { RequestUser } from '../../common/types/request-user';
import type { BookPhysicalCopy } from '../../db/schema';
import type { CreatePhysicalBookDto } from './dto';
import { PhysicalBookService } from './physical-book.service';

function makeUser(overrides?: Partial<RequestUser>): RequestUser {
  return {
    id: 7,
    username: 'shelfkeeper',
    name: 'Shelf Keeper',
    email: null,
    active: true,
    isSuperuser: false,
    isDefaultPassword: false,
    tokenVersion: 1,
    settings: {},
    avatarUrl: null,
    provisioningMethod: 'local',
    permissions: [],
    contentFilters: EMPTY_CONTENT_FILTER_RULES,
    ...overrides,
  };
}

function makeCandidate(overrides?: Partial<MetadataCandidate>): MetadataCandidate {
  return {
    provider: 'google_books' as MetadataCandidate['provider'],
    providerId: 'gb-1',
    title: 'Dune',
    authors: ['Frank Herbert'],
    isbn13: '9780306406157',
    pageCount: 412,
    ...overrides,
  };
}

function makeCopy(overrides?: Partial<BookPhysicalCopy>): BookPhysicalCopy {
  return {
    userId: 7,
    bookId: 55,
    acquisition: 'owned',
    pageCount: 400,
    currentPage: 100,
    lender: null,
    dueOn: null,
    renewalsUsed: 0,
    renewalLimit: null,
    returnedOn: null,
    binding: null,
    shelfLocation: null,
    acquiredOn: null,
    notes: null,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    ...overrides,
  } as BookPhysicalCopy;
}

function makeService(options?: { candidates?: MetadataCandidate[]; copy?: BookPhysicalCopy; metadataPageCount?: number | null }) {
  const copy = options?.copy ?? makeCopy();
  const repo = {
    findFirstFolderId: vi.fn<() => Promise<number | null>>().mockResolvedValue(3),
    findExistingCopyByIsbn13: vi.fn<() => Promise<{ bookId: number } | null>>().mockResolvedValue(null),
    findCopy: vi.fn(),
    createPhysicalBook: vi
      .fn<(params: unknown, applyAuthors?: unknown) => Promise<{ bookId: number; copy: Record<string, unknown> }>>()
      .mockResolvedValue({ bookId: 55, copy: { bookId: 55, currentPage: 0 } }),
    findCopyContext: vi.fn<() => Promise<unknown>>().mockResolvedValue({
      copy,
      libraryId: 2,
      metadataPageCount: options?.metadataPageCount ?? null,
      title: 'Dune',
    }),
    updateCopy: vi
      .fn<(userId: number, bookId: number, values: Partial<BookPhysicalCopy>) => Promise<BookPhysicalCopy | null>>()
      .mockImplementation((_userId, _bookId, values) => Promise.resolve(makeCopy({ ...copy, ...values }))),
    deleteCopy: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    sumProgressDeltaBetween: vi.fn<() => Promise<number>>().mockResolvedValue(0),
    markRead: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    markReading: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  const metadataFetchService = {
    search: vi.fn(() => of(...(options?.candidates ?? []))),
  };
  const metadataService = {
    replaceAuthors: vi.fn<() => Promise<number[]>>().mockResolvedValue([1]),
  };
  const libraryService = {
    verifyUserAccess: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  const readingSessionService = {
    createPhysicalSession: vi.fn<() => Promise<{ id: number }>>().mockResolvedValue({ id: 900 }),
  };
  const service = new PhysicalBookService(
    repo as never,
    metadataFetchService as never,
    metadataService as never,
    libraryService as never,
    readingSessionService as never,
  );
  return { service, repo, metadataFetchService, metadataService, libraryService, readingSessionService };
}

function makeDto(overrides?: Partial<CreatePhysicalBookDto>): CreatePhysicalBookDto {
  return { libraryId: 2, isbn: '9780306406157', acquisition: 'owned', ...overrides } as CreatePhysicalBookDto;
}

describe('PhysicalBookService', () => {
  describe('lookupIsbn', () => {
    it('collects the provider Observable and returns the candidate matching the scanned ISBN', async () => {
      const exact = makeCandidate({ providerId: 'exact', isbn13: '9780306406157' });
      const loose = makeCandidate({ providerId: 'loose', isbn13: undefined, title: 'Dune Messiah' });
      const { service } = makeService({ candidates: [loose, exact] });

      const result = await service.lookupIsbn('978-0-306-40615-7', makeUser());

      expect(result?.providerId).toBe('exact');
    });

    it('normalizes an ISBN-10 to 13 before searching providers', async () => {
      const { service, metadataFetchService } = makeService({ candidates: [makeCandidate()] });

      await service.lookupIsbn('0-306-40615-2', makeUser());

      expect(metadataFetchService.search).toHaveBeenCalledWith({ isbn: '9780306406157' });
    });

    it('rejects a checksum failure before any provider call', async () => {
      const { service, metadataFetchService } = makeService();

      await expect(service.lookupIsbn('9780306406158', makeUser())).rejects.toThrow(BadRequestException);
      expect(metadataFetchService.search).not.toHaveBeenCalled();
    });

    it('returns null when no provider has the book', async () => {
      const { service } = makeService({ candidates: [] });

      await expect(service.lookupIsbn('9780306406157', makeUser())).resolves.toBeNull();
    });
  });

  describe('createPhysicalBook', () => {
    it('creates the book with medium physical and a non-filesystem sentinel folder path', async () => {
      const { service, repo } = makeService({ candidates: [makeCandidate()] });

      const result = await service.createPhysicalBook(makeDto(), makeUser());

      expect(result.bookId).toBe(55);
      const params = repo.createPhysicalBook.mock.calls[0]![0] as {
        userId: number;
        libraryId: number;
        libraryFolderId: number;
        folderPath: string;
        metadata: Record<string, unknown>;
      };
      expect(params.userId).toBe(7);
      expect(params.libraryFolderId).toBe(3);
      expect(params.folderPath).toMatch(/^physical:\/\/[0-9a-f-]{36}$/);
      expect(params.metadata.title).toBe('Dune');
      expect(params.metadata.isbn13).toBe('9780306406157');
      expect(params.metadata.pageCount).toBe(412);
    });

    it('falls back to the supplied title and scanned ISBN when no provider matches', async () => {
      const { service, repo } = makeService({ candidates: [] });

      await service.createPhysicalBook(makeDto({ title: 'An Obscure Zine', pageCount: 40 }), makeUser());

      const params = repo.createPhysicalBook.mock.calls[0]![0] as { metadata: Record<string, unknown> };
      expect(params.metadata.title).toBe('An Obscure Zine');
      expect(params.metadata.isbn13).toBe('9780306406157');
      expect(params.metadata.isbn10).toBe('0306406152');
      expect(params.metadata.pageCount).toBe(40);
    });

    it('throws 409 carrying the existing bookId when the ISBN is already on the shelf', async () => {
      const { service, repo } = makeService({ candidates: [makeCandidate()] });
      repo.findExistingCopyByIsbn13.mockResolvedValue({ bookId: 91 });

      const error = await service.createPhysicalBook(makeDto(), makeUser()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ bookId: 91, isbn13: '9780306406157' });
      expect(repo.createPhysicalBook).not.toHaveBeenCalled();
    });

    it('rejects a borrowed copy pointed at a library the user cannot access', async () => {
      const { service, repo, libraryService } = makeService();
      libraryService.verifyUserAccess.mockRejectedValue(new BadRequestException('No access to this library'));

      await expect(service.createPhysicalBook(makeDto(), makeUser())).rejects.toThrow(BadRequestException);
      expect(repo.createPhysicalBook).not.toHaveBeenCalled();
    });

    it('rejects a library with no folders instead of inventing one', async () => {
      const { service, repo } = makeService();
      repo.findFirstFolderId.mockResolvedValue(null);

      await expect(service.createPhysicalBook(makeDto(), makeUser())).rejects.toThrow(BadRequestException);
      expect(repo.createPhysicalBook).not.toHaveBeenCalled();
    });

    it('links provider authors inside the create transaction', async () => {
      const { service, repo, metadataService } = makeService({ candidates: [makeCandidate()] });

      await service.createPhysicalBook(makeDto(), makeUser());

      const applyAuthors = repo.createPhysicalBook.mock.calls[0]![1] as (tx: unknown, bookId: number) => Promise<void>;
      expect(applyAuthors).toBeTypeOf('function');
      const tx = { marker: 'tx' };
      await applyAuthors(tx, 55);
      expect(metadataService.replaceAuthors).toHaveBeenCalledWith(55, [{ name: 'Frank Herbert', sortName: null }], {
        executor: tx,
        emitEvent: false,
      });
    });

    it('creates a titled book with no author linking when nothing supplies an author', async () => {
      const { service, repo } = makeService({ candidates: [] });

      await service.createPhysicalBook(makeDto({ isbn: undefined, title: 'Handmade Chapbook' }), makeUser());

      expect(repo.createPhysicalBook.mock.calls[0]![1]).toBeUndefined();
    });
  });

  describe('bulkImport', () => {
    it('imports the good scans and reports each bad one without aborting the batch', async () => {
      const { service, repo } = makeService({ candidates: [makeCandidate()] });
      let nextId = 100;
      repo.createPhysicalBook.mockImplementation(() => Promise.resolve({ bookId: nextId++, copy: { bookId: nextId } }));

      const result = await service.bulkImport(
        { libraryId: 2, isbns: ['9780306406157', '9780306406158', '0306406152'], acquisition: 'owned' },
        makeUser(),
      );

      expect(result.created).toHaveLength(2);
      expect(result.created.map((c) => c.isbn)).toEqual(['9780306406157', '0306406152']);
      expect(result.failed).toEqual([{ isbn: '9780306406158', reason: 'Invalid ISBN: checksum does not match' }]);
    });

    it('reports an already-imported ISBN as a failure pointing at the existing book', async () => {
      const { service, repo } = makeService({ candidates: [makeCandidate()] });
      repo.findExistingCopyByIsbn13.mockResolvedValue({ bookId: 42 });

      const result = await service.bulkImport({ libraryId: 2, isbns: ['9780306406157'], acquisition: 'owned' }, makeUser());

      expect(result.created).toEqual([]);
      expect(result.failed[0]!.reason).toContain('42');
    });

    it('fails the whole request when the library itself is unusable', async () => {
      const { service, repo } = makeService();
      repo.findFirstFolderId.mockResolvedValue(null);

      await expect(service.bulkImport({ libraryId: 2, isbns: ['9780306406157'], acquisition: 'owned' }, makeUser())).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('logProgress', () => {
    it('records the session through the shared reading-session path so daily stats stay in sync', async () => {
      const { service, readingSessionService } = makeService({ copy: makeCopy({ currentPage: 100, pageCount: 400 }) });

      await service.logProgress(55, { currentPage: 200, minutes: 30 }, makeUser());

      expect(readingSessionService.createPhysicalSession).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 7, bookId: 55, libraryId: 2, durationSeconds: 1800, endProgress: 50 }),
      );
    });

    it('stores the page without a percentage when no page count exists anywhere', async () => {
      const { service, readingSessionService, repo } = makeService({
        copy: makeCopy({ pageCount: null, currentPage: 0 }),
        metadataPageCount: null,
      });

      const result = await service.logProgress(55, { currentPage: 120 }, makeUser());

      expect(readingSessionService.createPhysicalSession).toHaveBeenCalledWith(expect.objectContaining({ endProgress: null }));
      expect(repo.updateCopy).toHaveBeenCalledWith(7, 55, { currentPage: 120 });
      expect(result.percentage).toBeNull();
      expect(result.effectivePageCount).toBeNull();
    });

    it('falls back to the metadata page count when the copy has none of its own', async () => {
      const { service, readingSessionService } = makeService({ copy: makeCopy({ pageCount: null, currentPage: 0 }), metadataPageCount: 200 });

      const result = await service.logProgress(55, { currentPage: 50 }, makeUser());

      expect(readingSessionService.createPhysicalSession).toHaveBeenCalledWith(expect.objectContaining({ endProgress: 25 }));
      expect(result.effectivePageCount).toBe(200);
    });

    it('marks the book read and closes the attempt on reaching the last page', async () => {
      const { service, repo } = makeService({ copy: makeCopy({ pageCount: 400, currentPage: 390 }) });

      const result = await service.logProgress(55, { currentPage: 400, minutes: 20 }, makeUser());

      expect(repo.markRead).toHaveBeenCalled();
      expect(repo.markReading).not.toHaveBeenCalled();
      expect(result.percentage).toBe(100);
    });

    it('marks the book as reading on partial progress without downgrading anything', async () => {
      const { service, repo } = makeService({ copy: makeCopy({ pageCount: 400, currentPage: 0 }) });

      await service.logProgress(55, { currentPage: 10 }, makeUser());

      expect(repo.markReading).toHaveBeenCalledWith(7, 55, expect.any(Date));
      expect(repo.markRead).not.toHaveBeenCalled();
    });

    it('rejects a page beyond the known page count as a typo', async () => {
      const { service, repo } = makeService({ copy: makeCopy({ pageCount: 400 }) });

      await expect(service.logProgress(55, { currentPage: 4000 }, makeUser())).rejects.toThrow(BadRequestException);
      expect(repo.updateCopy).not.toHaveBeenCalled();
    });

    it('rejects a page decrease that claims reading time', async () => {
      const { service, readingSessionService } = makeService({ copy: makeCopy({ currentPage: 300 }) });

      await expect(service.logProgress(55, { currentPage: 200, minutes: 30 }, makeUser())).rejects.toThrow(BadRequestException);
      expect(readingSessionService.createPhysicalSession).not.toHaveBeenCalled();
    });

    it('allows correcting a mistyped page downwards when no reading time is claimed', async () => {
      const { service, repo } = makeService({ copy: makeCopy({ currentPage: 300 }) });

      const result = await service.logProgress(55, { currentPage: 200 }, makeUser());

      expect(repo.updateCopy).toHaveBeenCalledWith(7, 55, { currentPage: 200 });
      expect(result.currentPage).toBe(200);
    });

    it('records no session when neither the page nor any reading time changed', async () => {
      const { service, readingSessionService, repo } = makeService({ copy: makeCopy({ currentPage: 100 }) });

      await service.logProgress(55, { currentPage: 100 }, makeUser());

      expect(readingSessionService.createPhysicalSession).not.toHaveBeenCalled();
      expect(repo.updateCopy).toHaveBeenCalled();
    });

    it('reports 404 for a copy owned by somebody else rather than leaking its existence', async () => {
      const { service, repo } = makeService();
      repo.findCopyContext.mockResolvedValue(null);

      await expect(service.logProgress(55, { currentPage: 10 }, makeUser())).rejects.toThrow(NotFoundException);
    });

    it('averages the trailing pace over the whole seven day window, not just active days', async () => {
      const { service, repo } = makeService({ copy: makeCopy({ pageCount: 400, currentPage: 0 }) });
      // 25% of a 400 page book is 100 pages read across the window.
      repo.sumProgressDeltaBetween.mockResolvedValue(25);

      const result = await service.logProgress(55, { currentPage: 100 }, makeUser());

      expect(result.paceLast7Days).toBeCloseTo(14.29, 2);
    });
  });

  describe('updateCopy', () => {
    it('rejects flipping to borrowed without a lender, matching the DB constraint', async () => {
      const { service, repo } = makeService({ copy: makeCopy({ acquisition: 'owned', lender: null }) });

      await expect(service.updateCopy(55, { acquisition: 'borrowed_library' }, makeUser())).rejects.toThrow(BadRequestException);
      expect(repo.updateCopy).not.toHaveBeenCalled();
    });

    it('keeps the stored lender when only the acquisition changes', async () => {
      const { service, repo } = makeService({ copy: makeCopy({ acquisition: 'borrowed_library', lender: 'City Library' }) });

      await service.updateCopy(55, { dueOn: '2026-09-01' }, makeUser());

      expect(repo.updateCopy).toHaveBeenCalledWith(7, 55, expect.objectContaining({ acquisition: 'borrowed_library', lender: 'City Library' }));
    });
  });

  describe('returnCopy', () => {
    it('refuses to return a copy the reader owns', async () => {
      const { service, repo } = makeService({ copy: makeCopy({ acquisition: 'owned' }) });

      await expect(service.returnCopy(55, makeUser())).rejects.toThrow(BadRequestException);
      expect(repo.updateCopy).not.toHaveBeenCalled();
    });

    it('stamps the return date in the reader timezone and clears the loan urgency', async () => {
      const { service, repo } = makeService({
        copy: makeCopy({ acquisition: 'borrowed_library', lender: 'City Library', dueOn: '2026-04-20' }),
      });

      const result = await service.returnCopy(55, makeUser({ settings: { timezone: 'America/Los_Angeles' } as never }));

      const values = repo.updateCopy.mock.calls[0]![2];
      expect(values.returnedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result.urgency).toBeNull();
    });
  });

  describe('deleteCopy', () => {
    it('reports 404 when there is nothing to delete', async () => {
      const { service, repo } = makeService();
      repo.findCopyContext.mockResolvedValue(null);

      await expect(service.deleteCopy(55, makeUser())).rejects.toThrow(NotFoundException);
      expect(repo.deleteCopy).not.toHaveBeenCalled();
    });

    it('deletes a copy the reader owns', async () => {
      const { service, repo } = makeService();

      await expect(service.deleteCopy(55, makeUser())).resolves.toBeUndefined();
      expect(repo.deleteCopy).toHaveBeenCalledWith(7, 55);
    });
  });
});
