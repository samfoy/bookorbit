import { Logger } from '@nestjs/common';
import { EMPTY_CONTENT_FILTER_RULES } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import type { ActiveLoanRow, ActiveLoanSweepRow } from './physical-book.repository';
import { PhysicalLoanService } from './physical-loan.service';

const NOW = new Date('2026-08-12T12:00:00Z');

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

function makeLoan(overrides?: Partial<ActiveLoanRow>): ActiveLoanRow {
  return {
    bookId: 55,
    acquisition: 'borrowed_library',
    lender: 'City Library',
    dueOn: '2026-08-15',
    returnedOn: null,
    copyPageCount: 400,
    currentPage: 100,
    metadataPageCount: null,
    title: 'Dune',
    coverSource: null,
    ...overrides,
  };
}

function makeSweepLoan(overrides?: Partial<ActiveLoanSweepRow>): ActiveLoanSweepRow {
  return { ...makeLoan(), userId: 7, ...overrides };
}

function makeService() {
  const repo = {
    findActiveLoans: vi.fn<() => Promise<ActiveLoanRow[]>>().mockResolvedValue([]),
    findLoansDueBetween: vi.fn<() => Promise<ActiveLoanSweepRow[]>>().mockResolvedValue([]),
    findUserTimeZones: vi.fn<() => Promise<Map<number, unknown>>>().mockResolvedValue(new Map([[7, 'UTC']])),
    findAuthorNamesByBook: vi.fn<() => Promise<Map<number, string>>>().mockResolvedValue(new Map()),
    sumProgressDeltaByBook: vi.fn<() => Promise<Map<number, number>>>().mockResolvedValue(new Map()),
    findNotifiedMilestones: vi.fn<() => Promise<Set<string>>>().mockResolvedValue(new Set()),
  };
  const libraryService = {
    findAccessibleLibraryIds: vi.fn<() => Promise<number[]>>().mockResolvedValue([2]),
  };
  const notificationService = {
    notify: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  const service = new PhysicalLoanService(repo as never, libraryService as never, notificationService as never);
  return { service, repo, libraryService, notificationService };
}

describe('PhysicalLoanService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  describe('getDueSoon', () => {
    it('caps the query at the shelf-sized widget limit rather than fetching every loan', async () => {
      const { service, repo } = makeService();

      await service.getDueSoon(makeUser(), NOW);

      expect(repo.findActiveLoans).toHaveBeenCalledWith(7, [2], 10);
    });

    it('returns nothing when the reader has no active loans', async () => {
      const { service, repo } = makeService();

      await expect(service.getDueSoon(makeUser(), NOW)).resolves.toEqual({ entries: [] });
      expect(repo.findAuthorNamesByBook).not.toHaveBeenCalled();
    });

    it('drops owned and returned copies the query cannot exclude on its own', async () => {
      const { service, repo } = makeService();
      repo.findActiveLoans.mockResolvedValue([
        makeLoan({ bookId: 1 }),
        makeLoan({ bookId: 2, acquisition: 'owned' }),
        makeLoan({ bookId: 3, returnedOn: '2026-08-01' }),
      ]);

      const result = await service.getDueSoon(makeUser(), NOW);

      expect(result.entries.map((entry) => entry.bookId)).toEqual([1]);
    });

    it('sorts by urgency so the most pressing loan leads the widget', async () => {
      const { service, repo } = makeService();
      repo.findActiveLoans.mockResolvedValue([
        makeLoan({ bookId: 1, dueOn: '2026-09-30', currentPage: 399 }),
        makeLoan({ bookId: 2, dueOn: '2026-08-01' }),
      ]);
      repo.sumProgressDeltaByBook.mockResolvedValue(new Map([[1, 100]]));

      const result = await service.getDueSoon(makeUser(), NOW);

      expect(result.entries.map((entry) => entry.urgency)).toEqual(['overdue', 'comfortable']);
    });

    it('resolves the pace window in the reader timezone', async () => {
      const { service, repo } = makeService();
      repo.findActiveLoans.mockResolvedValue([makeLoan()]);

      await service.getDueSoon(makeUser({ settings: { timezone: 'America/Los_Angeles' } as never }), NOW);

      const [, , start, end] = repo.sumProgressDeltaByBook.mock.calls[0]!;
      // Pacific midnight is 07:00 UTC in August, so a UTC-based window would start at 00:00.
      expect((start as Date).toISOString()).toBe('2026-08-06T07:00:00.000Z');
      expect((end as Date).toISOString()).toBe('2026-08-13T07:00:00.000Z');
    });

    it('converts stored progress deltas into a pages-per-day pace', async () => {
      const { service, repo } = makeService();
      repo.findActiveLoans.mockResolvedValue([makeLoan({ copyPageCount: 400 })]);
      // 35% of a 400 page book over 7 days is 20 pages a day.
      repo.sumProgressDeltaByBook.mockResolvedValue(new Map([[55, 35]]));

      const result = await service.getDueSoon(makeUser(), NOW);

      expect(result.entries[0]!.paceLast7Days).toBe(20);
    });

    it('fetches authors in one batched query rather than per row', async () => {
      const { service, repo } = makeService();
      repo.findActiveLoans.mockResolvedValue([makeLoan({ bookId: 1 }), makeLoan({ bookId: 2 })]);
      repo.findAuthorNamesByBook.mockResolvedValue(new Map([[1, 'Frank Herbert']]));

      const result = await service.getDueSoon(makeUser(), NOW);

      expect(repo.findAuthorNamesByBook).toHaveBeenCalledTimes(1);
      expect(repo.findAuthorNamesByBook).toHaveBeenCalledWith([1, 2]);
      expect(result.entries.map((entry) => entry.authorName)).toEqual(['Frank Herbert', null]);
    });
  });

  describe('runDueSoonSweep', () => {
    it('notifies once at a milestone with a pace-aware message', async () => {
      const { service, repo, notificationService } = makeService();
      repo.findLoansDueBetween.mockResolvedValueOnce([makeSweepLoan({ dueOn: '2026-08-15' })]);
      repo.sumProgressDeltaByBook.mockResolvedValue(new Map([[55, 42]]));

      const result = await service.runDueSoonSweep(NOW);

      expect(result).toEqual({ considered: 1, notified: 1 });
      expect(notificationService.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'physical_due_soon',
          actionUrl: '/book/55',
          scope: { kind: 'user', userId: 7 },
          meta: expect.objectContaining({ bookId: 55, milestone: '3' }),
        }),
      );
      const [{ message }] = notificationService.notify.mock.calls[0] as [{ message: string }];
      expect(message).toContain('pages left');
    });

    it('does not notify a loan that is not at a milestone', async () => {
      const { service, repo, notificationService } = makeService();
      repo.findLoansDueBetween.mockResolvedValueOnce([makeSweepLoan({ dueOn: '2026-08-17' })]);

      const result = await service.runDueSoonSweep(NOW);

      expect(result.notified).toBe(0);
      expect(notificationService.notify).not.toHaveBeenCalled();
    });

    // A second run, or a second server instance, must not nag twice for the same milestone.
    it('skips a milestone that has already been notified', async () => {
      const { service, repo, notificationService } = makeService();
      repo.findLoansDueBetween.mockResolvedValueOnce([makeSweepLoan({ dueOn: '2026-08-15' })]);
      repo.findNotifiedMilestones.mockResolvedValue(new Set(['55:3']));

      const result = await service.runDueSoonSweep(NOW);

      expect(result.notified).toBe(0);
      expect(notificationService.notify).not.toHaveBeenCalled();
    });

    it('still notifies a later milestone for a book already notified at an earlier one', async () => {
      const { service, repo, notificationService } = makeService();
      repo.findLoansDueBetween.mockResolvedValueOnce([makeSweepLoan({ dueOn: '2026-08-13' })]);
      repo.findNotifiedMilestones.mockResolvedValue(new Set(['55:7', '55:3']));

      const result = await service.runDueSoonSweep(NOW);

      expect(result.notified).toBe(1);
      expect(notificationService.notify).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ milestone: '1' }) }));
    });

    it('checks idempotency once per user rather than once per loan', async () => {
      const { service, repo } = makeService();
      repo.findLoansDueBetween.mockResolvedValueOnce([
        makeSweepLoan({ bookId: 1, dueOn: '2026-08-15' }),
        makeSweepLoan({ bookId: 2, dueOn: '2026-08-13' }),
      ]);

      await service.runDueSoonSweep(NOW);

      expect(repo.findNotifiedMilestones).toHaveBeenCalledTimes(1);
      expect(repo.findNotifiedMilestones).toHaveBeenCalledWith(7, [1, 2]);
    });

    // The SQL window is bounded by the server's UTC date; each reader's milestone is decided in
    // their own timezone, which can differ by a day.
    it('decides the milestone in each reader timezone, not the server clock', async () => {
      const { service, repo, notificationService } = makeService();
      repo.findLoansDueBetween.mockResolvedValueOnce([
        makeSweepLoan({ userId: 7, bookId: 1, dueOn: '2026-08-13' }),
        makeSweepLoan({ userId: 8, bookId: 2, dueOn: '2026-08-13' }),
      ]);
      repo.findUserTimeZones.mockResolvedValue(
        new Map<number, unknown>([
          [7, 'UTC'],
          [8, 'Asia/Tokyo'],
        ]),
      );

      // At 2026-08-12T18:00Z it is already 2026-08-13 in Tokyo, so the same due date is "today"
      // there and "tomorrow" in UTC.
      await service.runDueSoonSweep(new Date('2026-08-12T18:00:00Z'));

      const milestones = notificationService.notify.mock.calls.map(([payload]) => (payload as { meta: { milestone: string } }).meta.milestone);
      expect(milestones).toEqual(['1', '0']);
    });

    it('skips loans belonging to users who are inactive or gone', async () => {
      const { service, repo, notificationService } = makeService();
      repo.findLoansDueBetween.mockResolvedValueOnce([makeSweepLoan({ userId: 99, dueOn: '2026-08-15' })]);
      repo.findUserTimeZones.mockResolvedValue(new Map());

      const result = await service.runDueSoonSweep(NOW);

      expect(result.notified).toBe(0);
      expect(notificationService.notify).not.toHaveBeenCalled();
    });

    it('pages through loans by bookId until a short page ends the sweep', async () => {
      const { service, repo } = makeService();
      const fullPage = Array.from({ length: 500 }, (_, index) => makeSweepLoan({ bookId: index + 1, dueOn: '2026-08-17' }));
      repo.findLoansDueBetween.mockResolvedValueOnce(fullPage).mockResolvedValueOnce([makeSweepLoan({ bookId: 501, dueOn: '2026-08-17' })]);

      const result = await service.runDueSoonSweep(NOW);

      expect(result.considered).toBe(501);
      expect(repo.findLoansDueBetween).toHaveBeenCalledTimes(2);
      expect(repo.findLoansDueBetween.mock.calls[1]).toEqual(['2026-08-10', '2026-08-20', 500, 500]);
    });

    it('bounds the SQL window around the milestone range instead of scanning every loan', async () => {
      const { service, repo } = makeService();

      await service.runDueSoonSweep(NOW);

      expect(repo.findLoansDueBetween).toHaveBeenCalledWith('2026-08-10', '2026-08-20', 500, 0);
    });

    it('rethrows after logging so a failed sweep is visible', async () => {
      const { service, repo } = makeService();
      repo.findLoansDueBetween.mockRejectedValue(new Error('connection lost'));

      await expect(service.runDueSoonSweep(NOW)).rejects.toThrow('connection lost');
    });
  });
});
