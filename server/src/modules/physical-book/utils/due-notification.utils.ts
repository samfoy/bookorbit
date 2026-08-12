import type { DueSoonEntry } from '@bookorbit/types';

/**
 * Days-out marks at which a loan earns one notification. `0` is the due date itself and
 * `overdue` fires once on the first day past it, so a forgotten book gets exactly one nudge
 * rather than a daily scolding.
 */
export const DUE_MILESTONES = [7, 3, 1, 0] as const;
export const OVERDUE_MILESTONE = 'overdue';

export type DueMilestone = `${(typeof DUE_MILESTONES)[number]}` | typeof OVERDUE_MILESTONE;

export function milestoneFor(daysRemaining: number): DueMilestone | null {
  if (daysRemaining < 0) return daysRemaining === -1 ? OVERDUE_MILESTONE : null;
  const match = DUE_MILESTONES.find((days) => days === daysRemaining);
  return match === undefined ? null : (String(match) as DueMilestone);
}

export function buildDueTitle(entry: DueSoonEntry): string {
  if (entry.daysRemaining < 0) return `${entry.title} is overdue`;
  if (entry.daysRemaining === 0) return `${entry.title} is due today`;
  if (entry.daysRemaining === 1) return `${entry.title} is due tomorrow`;
  return `${entry.title} is due in ${entry.daysRemaining} days`;
}

/**
 * Pace-aware encouragement rather than a bare deadline. Without a page count there is no pace to
 * speak of, so the message falls back to the deadline and the lender.
 */
export function buildDueMessage(entry: DueSoonEntry): string {
  const parts: string[] = [];

  if (entry.pagesRemaining === null || entry.pagesPerDayNeeded === null) {
    if (entry.lender) parts.push(`Borrowed from ${entry.lender}.`);
    parts.push(entry.daysRemaining < 0 ? 'Time to return it or renew.' : 'Add a page count to track your pace.');
    return parts.join(' ');
  }

  if (entry.pagesRemaining === 0) {
    return entry.daysRemaining < 0 ? 'You finished it - time to return it.' : 'You finished it with time to spare. Nice.';
  }

  parts.push(`${entry.pagesRemaining} pages left, about ${entry.pagesPerDayNeeded}/day.`);

  if (entry.paceLast7Days > 0) {
    parts.push(`You've been averaging ${formatPace(entry.paceLast7Days)}.`);
    parts.push(entry.onTrack ? "You're on track." : 'A little more each day gets you there.');
  } else {
    parts.push('No pages logged this week - a short session today makes it reachable.');
  }

  return parts.join(' ');
}

function formatPace(pace: number): string {
  const rounded = Math.round(pace * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}/day`;
}
