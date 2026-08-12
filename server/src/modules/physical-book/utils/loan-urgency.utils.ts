import type { LoanUrgency, PhysicalAcquisition } from '@bookorbit/types';

import { toDateKeyInTimeZone } from '../../../common/utils/timezone.utils';

export interface LoanUrgencyInput {
  acquisition: PhysicalAcquisition;
  dueOn: string | null;
  returnedOn: string | null;
  pagesRemaining: number | null;
  paceLast7Days: number;
  /** Already resolved via resolveTimeZone by the caller. */
  timeZone: string;
  now?: Date;
}

export interface LoanUrgencyResult {
  daysRemaining: number | null;
  pagesPerDayNeeded: number | null;
  onTrack: boolean | null;
  urgency: LoanUrgency | null;
}

const NOT_A_LOAN: LoanUrgencyResult = { daysRemaining: null, pagesPerDayNeeded: null, onTrack: null, urgency: null };

/**
 * Pure loan pressure math. Only active loans have urgency: an owned copy has no deadline and a
 * returned copy no longer has one.
 *
 * Day math runs entirely on date keys in the READER'S timezone, never on the server clock. The
 * server runs Etc/UTC, so at 5pm Pacific on the due date UTC has already rolled over to the next
 * day; comparing raw instants would report a book due today as overdue.
 */
export function computeLoanUrgency(input: LoanUrgencyInput): LoanUrgencyResult {
  const { acquisition, dueOn, returnedOn, pagesRemaining, paceLast7Days, timeZone, now = new Date() } = input;
  if (acquisition === 'owned' || !dueOn || returnedOn) return NOT_A_LOAN;

  const daysRemaining = diffDateKeysInDays(dueOn, toDateKeyInTimeZone(now, timeZone));

  // Without a page count there is no denominator, so pace cannot be judged. The deadline still
  // can be, so urgency falls back to date pressure alone rather than being suppressed.
  if (pagesRemaining === null) {
    return {
      daysRemaining,
      pagesPerDayNeeded: null,
      onTrack: null,
      urgency: daysRemaining < 0 ? 'overdue' : daysRemaining <= 2 ? 'urgent' : 'comfortable',
    };
  }

  // max(daysRemaining, 1): on the due date and past it, the whole remainder is needed today.
  const pagesPerDayNeeded = Math.ceil(pagesRemaining / Math.max(daysRemaining, 1));
  const onTrack = paceLast7Days >= pagesPerDayNeeded;

  return { daysRemaining, pagesPerDayNeeded, onTrack, urgency: classify(daysRemaining, onTrack) };
}

function classify(daysRemaining: number, onTrack: boolean): LoanUrgency {
  if (daysRemaining < 0) return 'overdue';
  if (daysRemaining <= 2) return 'urgent';
  if (!onTrack && daysRemaining <= 5) return 'urgent';
  if (!onTrack) return 'tight';
  return 'comfortable';
}

/**
 * Whole-day difference between two calendar day keys. Both keys are already timezone-resolved, so
 * this is deliberately plain UTC-midnight arithmetic and is immune to DST: a spring-forward day is
 * still one calendar day.
 */
export function diffDateKeysInDays(target: string, from: string): number {
  const MS_PER_DAY = 86_400_000;
  return Math.round((dateKeyToUtcMillis(target) - dateKeyToUtcMillis(from)) / MS_PER_DAY);
}

function dateKeyToUtcMillis(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  return Date.UTC(year!, month! - 1, day!);
}
