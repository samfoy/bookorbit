import type { DueSoonEntry, LoanUrgency } from '@bookorbit/types';

import type { ActiveLoanRow } from '../physical-book.repository';
import { computeLoanUrgency } from './loan-urgency.utils';

export interface DueSoonLoan extends ActiveLoanRow {
  dueOn: string;
}

/** Narrows the nullable dueOn the column type carries; the query already filters it out. */
export function isActiveLoan(row: ActiveLoanRow): row is DueSoonLoan {
  return row.dueOn !== null && row.returnedOn === null && row.acquisition !== 'owned';
}

export function buildDueSoonEntry(loan: DueSoonLoan, authorName: string | null, paceLast7Days: number, timeZone: string, now: Date): DueSoonEntry {
  const effectivePageCount = loan.copyPageCount ?? loan.metadataPageCount ?? null;
  const pagesRemaining = effectivePageCount ? Math.max(0, effectivePageCount - loan.currentPage) : null;

  const urgency = computeLoanUrgency({
    acquisition: loan.acquisition,
    dueOn: loan.dueOn,
    returnedOn: null,
    pagesRemaining,
    paceLast7Days,
    timeZone,
    now,
  });

  return {
    bookId: loan.bookId,
    title: loan.title ?? 'Untitled',
    authorName,
    coverUrl: loan.coverSource ? `/api/v1/books/${loan.bookId}/thumbnail` : null,
    acquisition: loan.acquisition,
    lender: loan.lender,
    dueOn: loan.dueOn,
    // isActiveLoan has already ruled out the non-loan cases that make these null.
    daysRemaining: urgency.daysRemaining ?? 0,
    pagesRemaining,
    pagesPerDayNeeded: urgency.pagesPerDayNeeded,
    paceLast7Days,
    onTrack: urgency.onTrack,
    urgency: (urgency.urgency ?? 'comfortable') as LoanUrgency,
  };
}

// Ordered by pressure so the widget can sort without knowing the semantics of each level.
const URGENCY_RANK: Record<LoanUrgency, number> = { overdue: 0, urgent: 1, tight: 2, comfortable: 3 };

export function sortByUrgency(entries: DueSoonEntry[]): DueSoonEntry[] {
  return [...entries].sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || a.dueOn.localeCompare(b.dueOn) || a.bookId - b.bookId);
}
