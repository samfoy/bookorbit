import { BadRequestException, ConflictException } from '@nestjs/common';
import { EMPTY_CONTENT_FILTER_RULES, type MetadataCandidate } from '@bookorbit/types';
import { of } from 'rxjs';

import type { RequestUser } from '../../common/types/request-user';
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

function makeService(options?: { candidates?: MetadataCandidate[] }) {
  const repo = {
    findFirstFolderId: vi.fn<() => Promise<number | null>>().mockResolvedValue(3),
    findExistingCopyByIsbn13: vi.fn<() => Promise<{ bookId: number } | null>>().mockResolvedValue(null),
    findCopy: vi.fn(),
    createPhysicalBook: vi
      .fn<(params: unknown, applyAuthors?: unknown) => Promise<{ bookId: number; copy: Record<string, unknown> }>>()
      .mockResolvedValue({ bookId: 55, copy: { bookId: 55, currentPage: 0 } }),
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
  const service = new PhysicalBookService(repo as never, metadataFetchService as never, metadataService as never, libraryService as never);
  return { service, repo, metadataFetchService, metadataService, libraryService };
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
});
