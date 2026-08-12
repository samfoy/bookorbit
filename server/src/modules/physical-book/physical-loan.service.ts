import { Injectable, Logger } from '@nestjs/common';
import { DUE_SOON_LIMIT, NotificationType, type DueSoonEntry, type DueSoonWidgetData } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { addDateKeyDays, getDayRangeForDateKeys } from '../../common/utils/reading-daily-stats.utils';
import { resolveTimeZone, toDateKeyInTimeZone } from '../../common/utils/timezone.utils';
import { LibraryService } from '../library/library.service';
import { NotificationService } from '../notification/notification.service';
import type { ActiveLoanSweepRow } from './physical-book.repository';
import { PhysicalBookRepository } from './physical-book.repository';
import { buildDueMessage, buildDueTitle, milestoneFor, type DueMilestone } from './utils/due-notification.utils';
import { buildDueSoonEntry, isActiveLoan, sortByUrgency, type DueSoonLoan } from './utils/due-soon.utils';
import { PACE_WINDOW_DAYS, paceFromProgressDelta } from './utils/loan-urgency.utils';

// The sweep only cares about loans near a milestone. 7 days is the earliest mark, plus a day of
// slack either side so a reader whose timezone is behind UTC is still caught on the right day.
const SWEEP_LOOKAHEAD_DAYS = 8;
const SWEEP_LOOKBEHIND_DAYS = 2;
const SWEEP_PAGE_SIZE = 500;

@Injectable()
export class PhysicalLoanService {
  private readonly logger = new Logger(PhysicalLoanService.name);

  constructor(
    private readonly repo: PhysicalBookRepository,
    private readonly libraryService: LibraryService,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * Active loans for the dashboard widget, most pressing first and capped at DUE_SOON_LIMIT.
   * Caching is the caller's concern so the widget can reuse the dashboard's per-user cache.
   */
  async getDueSoon(user: RequestUser, now: Date = new Date()): Promise<DueSoonWidgetData> {
    const accessibleLibraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    const rows = await this.repo.findActiveLoans(user.id, accessibleLibraryIds, DUE_SOON_LIMIT);
    const loans = rows.filter(isActiveLoan);
    if (loans.length === 0) return { entries: [] };

    const timeZone = resolveTimeZone((user.settings as { timezone?: unknown } | undefined)?.timezone, 'UTC');
    const entries = await this.buildEntries(user.id, loans, timeZone, now);
    return { entries: sortByUrgency(entries) };
  }

  /**
   * One notification per loan per milestone. Idempotency is enforced by checking the existing
   * notification rows for this user rather than by tracking state on the copy, so a re-run of the
   * sweep - or a second server instance - cannot double-notify.
   */
  async runDueSoonSweep(now: Date = new Date()): Promise<{ considered: number; notified: number }> {
    const event = 'physical_book.due_sweep';
    const startedAtMs = Date.now();
    this.logger.log(`[${event}] [start] - due soon sweep started`);

    try {
      // Server-clock date keys only bound the SQL query; every per-user decision below is made in
      // that user's own timezone.
      const serverToday = toDateKeyInTimeZone(now, 'UTC');
      const windowStart = addDateKeyDays(serverToday, -SWEEP_LOOKBEHIND_DAYS);
      const windowEnd = addDateKeyDays(serverToday, SWEEP_LOOKAHEAD_DAYS);

      let considered = 0;
      let notified = 0;
      let afterBookId = 0;

      for (;;) {
        const page = await this.repo.findLoansDueBetween(windowStart, windowEnd, SWEEP_PAGE_SIZE, afterBookId);
        if (page.length === 0) break;
        afterBookId = page[page.length - 1]!.bookId;
        considered += page.length;
        notified += await this.notifyPage(page, now);
        if (page.length < SWEEP_PAGE_SIZE) break;
      }

      this.logger.log(
        `[${event}] [end] durationMs=${Date.now() - startedAtMs} considered=${considered} notified=${notified} - due soon sweep completed`,
      );
      return { considered, notified };
    } catch (error) {
      const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
      this.logger.error(
        `[${event}] [fail] durationMs=${Date.now() - startedAtMs} errorClass=${errorClass} error="${sanitizeLogValue(error instanceof Error ? error.message : 'unknown error')}" - due soon sweep failed`,
      );
      throw error;
    }
  }

  private async notifyPage(page: ActiveLoanSweepRow[], now: Date): Promise<number> {
    const byUser = new Map<number, DueSoonLoan[]>();
    for (const row of page) {
      if (!isActiveLoan(row)) continue;
      const list = byUser.get(row.userId) ?? [];
      list.push(row);
      byUser.set(row.userId, list);
    }

    const timeZones = await this.repo.findUserTimeZones([...byUser.keys()]);
    let notified = 0;

    for (const [userId, loans] of byUser) {
      // A missing entry means the user is inactive or gone; their loans are skipped entirely.
      if (!timeZones.has(userId)) continue;
      const timeZone = resolveTimeZone(timeZones.get(userId), 'UTC');
      const entries = await this.buildEntries(userId, loans, timeZone, now);

      const due = entries
        .map((entry) => ({ entry, milestone: milestoneFor(entry.daysRemaining) }))
        .filter((candidate): candidate is { entry: DueSoonEntry; milestone: DueMilestone } => candidate.milestone !== null);
      if (due.length === 0) continue;

      const alreadyNotified = await this.repo.findNotifiedMilestones(
        userId,
        due.map(({ entry }) => entry.bookId),
      );

      for (const { entry, milestone } of due) {
        if (alreadyNotified.has(`${entry.bookId}:${milestone}`)) continue;
        await this.notificationService.notify({
          type: NotificationType.PhysicalDueSoon,
          title: buildDueTitle(entry),
          message: buildDueMessage(entry),
          actionUrl: `/book/${entry.bookId}`,
          meta: { bookId: entry.bookId, milestone, dueOn: entry.dueOn, urgency: entry.urgency },
          scope: { kind: 'user', userId },
        });
        notified += 1;
      }
    }

    return notified;
  }

  private async buildEntries(userId: number, loans: DueSoonLoan[], timeZone: string, now: Date): Promise<DueSoonEntry[]> {
    const bookIds = loans.map((loan) => loan.bookId);
    const [authorNames, paceByBook] = await Promise.all([
      this.repo.findAuthorNamesByBook(bookIds),
      this.computePaceByBook(userId, bookIds, timeZone, now),
    ]);

    return loans.map((loan) => {
      const effectivePageCount = loan.copyPageCount ?? loan.metadataPageCount ?? null;
      const paceLast7Days = paceFromProgressDelta(paceByBook.get(loan.bookId) ?? 0, effectivePageCount);
      return buildDueSoonEntry(loan, authorNames.get(loan.bookId) ?? null, paceLast7Days, timeZone, now);
    });
  }

  /**
   * Trailing 7-day progress per book in one grouped query. The window boundaries come from
   * getDayRangeForDateKeys so they land on the reader's midnight, not the server's.
   */
  private async computePaceByBook(userId: number, bookIds: number[], timeZone: string, now: Date): Promise<Map<number, number>> {
    const today = toDateKeyInTimeZone(now, timeZone);
    const days = Array.from({ length: PACE_WINDOW_DAYS }, (_, index) => addDateKeyDays(today, index - (PACE_WINDOW_DAYS - 1)));
    const range = getDayRangeForDateKeys(days, timeZone);
    if (!range) return new Map();
    return this.repo.sumProgressDeltaByBook(userId, bookIds, range.start, range.end);
  }
}
