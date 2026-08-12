import type { PhysicalCopy, PhysicalCopySummary } from '@bookorbit/types';

import type { BookPhysicalCopy } from '../../../db/schema';
import { computeLoanUrgency } from './loan-urgency.utils';

export function toPhysicalCopy(copy: BookPhysicalCopy): PhysicalCopy {
  return {
    bookId: copy.bookId,
    acquisition: copy.acquisition,
    pageCount: copy.pageCount,
    currentPage: copy.currentPage,
    lender: copy.lender,
    dueOn: copy.dueOn,
    renewalsUsed: copy.renewalsUsed,
    renewalLimit: copy.renewalLimit,
    returnedOn: copy.returnedOn,
    binding: copy.binding,
    shelfLocation: copy.shelfLocation,
    acquiredOn: copy.acquiredOn,
    notes: copy.notes,
    createdAt: copy.createdAt.toISOString(),
    updatedAt: copy.updatedAt.toISOString(),
  };
}

/**
 * Derives every read-time field. Nothing here is stored: page counts and due dates change, and a
 * stored percentage would drift out of sync with the copy row.
 */
export function buildCopySummary(
  copy: BookPhysicalCopy,
  metadataPageCount: number | null,
  paceLast7Days: number,
  timeZone: string,
  now: Date = new Date(),
): PhysicalCopySummary {
  const effectivePageCount = copy.pageCount ?? metadataPageCount ?? null;
  const percentage = effectivePageCount ? Math.round((copy.currentPage / effectivePageCount) * 10000) / 100 : null;
  const pagesRemaining = effectivePageCount ? Math.max(0, effectivePageCount - copy.currentPage) : null;

  const urgency = computeLoanUrgency({
    acquisition: copy.acquisition,
    dueOn: copy.dueOn,
    returnedOn: copy.returnedOn,
    pagesRemaining,
    paceLast7Days,
    timeZone,
    now,
  });

  return {
    ...toPhysicalCopy(copy),
    effectivePageCount,
    percentage,
    pagesRemaining,
    daysRemaining: urgency.daysRemaining,
    pagesPerDayNeeded: urgency.pagesPerDayNeeded,
    paceLast7Days,
    onTrack: urgency.onTrack,
    urgency: urgency.urgency,
  };
}
