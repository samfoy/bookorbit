import type { DueSoonEntry } from '@bookorbit/types';

import { buildDueMessage, buildDueTitle, milestoneFor } from './due-notification.utils';

function makeEntry(overrides?: Partial<DueSoonEntry>): DueSoonEntry {
  return {
    bookId: 55,
    title: 'Dune',
    authorName: 'Frank Herbert',
    coverUrl: null,
    acquisition: 'borrowed_library',
    lender: 'City Library',
    dueOn: '2026-08-15',
    daysRemaining: 3,
    pagesRemaining: 96,
    pagesPerDayNeeded: 32,
    paceLast7Days: 24,
    onTrack: false,
    urgency: 'urgent',
    ...overrides,
  };
}

describe('milestoneFor', () => {
  it.each([
    [7, '7'],
    [3, '3'],
    [1, '1'],
    [0, '0'],
    [-1, 'overdue'],
  ])('maps %i days remaining to the %s milestone', (daysRemaining, expected) => {
    expect(milestoneFor(daysRemaining)).toBe(expected);
  });

  it.each([10, 8, 6, 5, 4, 2])('has no milestone at %i days out', (daysRemaining) => {
    expect(milestoneFor(daysRemaining)).toBeNull();
  });

  // Otherwise a book left overdue for a month would notify every single day.
  it('fires overdue only on the first day past the due date', () => {
    expect(milestoneFor(-1)).toBe('overdue');
    expect(milestoneFor(-2)).toBeNull();
    expect(milestoneFor(-30)).toBeNull();
  });
});

describe('buildDueTitle', () => {
  it.each([
    [3, 'Dune is due in 3 days'],
    [1, 'Dune is due tomorrow'],
    [0, 'Dune is due today'],
    [-1, 'Dune is overdue'],
  ])('phrases %i days remaining naturally', (daysRemaining, expected) => {
    expect(buildDueTitle(makeEntry({ daysRemaining }))).toBe(expected);
  });
});

describe('buildDueMessage', () => {
  it('carries pace encouragement, not just a deadline', () => {
    const message = buildDueMessage(makeEntry());

    expect(message).toContain('96 pages left');
    expect(message).toContain('about 32/day');
    expect(message).toContain("You've been averaging 24/day");
  });

  it('confirms the reader is on track when their pace is enough', () => {
    expect(buildDueMessage(makeEntry({ paceLast7Days: 40, onTrack: true }))).toContain("You're on track");
  });

  it('nudges rather than scolds when the pace falls short', () => {
    const message = buildDueMessage(makeEntry({ onTrack: false }));

    expect(message).toContain('A little more each day');
    expect(message).not.toContain('behind');
  });

  it('invites a first session when nothing was logged this week', () => {
    expect(buildDueMessage(makeEntry({ paceLast7Days: 0 }))).toContain('a short session today');
  });

  it('formats a fractional pace to one decimal', () => {
    expect(buildDueMessage(makeEntry({ paceLast7Days: 24.55 }))).toContain('24.6/day');
  });

  it('falls back to the lender when there is no page count to pace against', () => {
    const message = buildDueMessage(makeEntry({ pagesRemaining: null, pagesPerDayNeeded: null }));

    expect(message).toContain('City Library');
    expect(message).toContain('Add a page count');
  });

  it('tells an overdue reader with no page count to return or renew', () => {
    const message = buildDueMessage(makeEntry({ pagesRemaining: null, pagesPerDayNeeded: null, daysRemaining: -1 }));

    expect(message).toContain('return it or renew');
  });

  it('congratulates a finished book instead of demanding pages', () => {
    expect(buildDueMessage(makeEntry({ pagesRemaining: 0, pagesPerDayNeeded: 0 }))).toContain('finished it with time to spare');
  });

  it('asks for the return of a finished but overdue book', () => {
    const message = buildDueMessage(makeEntry({ pagesRemaining: 0, pagesPerDayNeeded: 0, daysRemaining: -1 }));

    expect(message).toContain('time to return it');
  });
});
