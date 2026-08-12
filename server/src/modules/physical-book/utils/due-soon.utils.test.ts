import type { ActiveLoanRow } from '../physical-book.repository';
import { buildDueSoonEntry, isActiveLoan, sortByUrgency, type DueSoonLoan } from './due-soon.utils';

const NOW = new Date('2026-08-12T12:00:00Z');

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
    coverSource: 'google_books',
    ...overrides,
  };
}

describe('isActiveLoan', () => {
  it('accepts a borrowed copy with a due date and no return date', () => {
    expect(isActiveLoan(makeLoan())).toBe(true);
  });

  it('rejects an owned copy even if it somehow carries a due date', () => {
    expect(isActiveLoan(makeLoan({ acquisition: 'owned' }))).toBe(false);
  });

  it('rejects a copy with no due date', () => {
    expect(isActiveLoan(makeLoan({ dueOn: null }))).toBe(false);
  });

  it('rejects a copy that has already been returned', () => {
    expect(isActiveLoan(makeLoan({ returnedOn: '2026-08-10' }))).toBe(false);
  });
});

describe('buildDueSoonEntry', () => {
  function build(overrides?: Partial<ActiveLoanRow>, pace = 10) {
    return buildDueSoonEntry(makeLoan(overrides) as DueSoonLoan, 'Frank Herbert', pace, 'UTC', NOW);
  }

  it('derives urgency and pace fields for the widget row', () => {
    const entry = build();

    expect(entry.daysRemaining).toBe(3);
    expect(entry.pagesRemaining).toBe(300);
    expect(entry.pagesPerDayNeeded).toBe(100);
    expect(entry.paceLast7Days).toBe(10);
    expect(entry.onTrack).toBe(false);
    expect(entry.urgency).toBe('urgent');
  });

  it('points the cover at the thumbnail route only when a cover exists', () => {
    expect(build().coverUrl).toBe('/api/v1/books/55/thumbnail');
    expect(build({ coverSource: null }).coverUrl).toBeNull();
  });

  it('prefers the copy page count over the metadata page count', () => {
    const entry = build({ copyPageCount: 200, metadataPageCount: 400, currentPage: 50 });

    expect(entry.pagesRemaining).toBe(150);
  });

  it('falls back to the metadata page count when the copy has none', () => {
    const entry = build({ copyPageCount: null, metadataPageCount: 300, currentPage: 100 });

    expect(entry.pagesRemaining).toBe(200);
  });

  it('still reports the deadline when no page count is known anywhere', () => {
    const entry = build({ copyPageCount: null, metadataPageCount: null });

    expect(entry.pagesRemaining).toBeNull();
    expect(entry.pagesPerDayNeeded).toBeNull();
    expect(entry.onTrack).toBeNull();
    expect(entry.daysRemaining).toBe(3);
  });

  it('labels an untitled book rather than emitting null into the widget', () => {
    expect(build({ title: null }).title).toBe('Untitled');
  });

  it('reads the day in the reader timezone, not the server clock', () => {
    // 2026-08-21T00:00Z is still 2026-08-20 at 5pm in Los Angeles.
    const entry = buildDueSoonEntry(
      makeLoan({ dueOn: '2026-08-20' }) as DueSoonLoan,
      null,
      0,
      'America/Los_Angeles',
      new Date('2026-08-21T00:00:00Z'),
    );

    expect(entry.daysRemaining).toBe(0);
    expect(entry.urgency).toBe('urgent');
  });
});

describe('sortByUrgency', () => {
  it('puts the most pressing loans first regardless of input order', () => {
    const rows = [
      buildDueSoonEntry(makeLoan({ bookId: 1, dueOn: '2026-09-30' }) as DueSoonLoan, null, 500, 'UTC', NOW),
      buildDueSoonEntry(makeLoan({ bookId: 2, dueOn: '2026-08-01' }) as DueSoonLoan, null, 0, 'UTC', NOW),
      buildDueSoonEntry(makeLoan({ bookId: 3, dueOn: '2026-08-13' }) as DueSoonLoan, null, 0, 'UTC', NOW),
    ];

    expect(sortByUrgency(rows).map((row) => row.urgency)).toEqual(['overdue', 'urgent', 'comfortable']);
  });

  it('breaks urgency ties by the nearest due date', () => {
    const rows = [
      buildDueSoonEntry(makeLoan({ bookId: 1, dueOn: '2026-08-14' }) as DueSoonLoan, null, 0, 'UTC', NOW),
      buildDueSoonEntry(makeLoan({ bookId: 2, dueOn: '2026-08-13' }) as DueSoonLoan, null, 0, 'UTC', NOW),
    ];

    expect(sortByUrgency(rows).map((row) => row.bookId)).toEqual([2, 1]);
  });

  it('does not mutate the input array', () => {
    const rows = [
      buildDueSoonEntry(makeLoan({ bookId: 1, dueOn: '2026-09-30' }) as DueSoonLoan, null, 500, 'UTC', NOW),
      buildDueSoonEntry(makeLoan({ bookId: 2, dueOn: '2026-08-01' }) as DueSoonLoan, null, 0, 'UTC', NOW),
    ];

    sortByUrgency(rows);
    expect(rows.map((row) => row.bookId)).toEqual([1, 2]);
  });
});
