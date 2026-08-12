import type { BookPhysicalCopy } from '../../../db/schema';
import { buildCopySummary, toPhysicalCopy } from './copy-summary.utils';

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
    updatedAt: new Date('2026-04-02T00:00:00.000Z'),
    ...overrides,
  } as BookPhysicalCopy;
}

const NOW = new Date('2026-08-12T12:00:00Z');

describe('copy summary', () => {
  it('serializes timestamps as ISO strings for the client', () => {
    const copy = toPhysicalCopy(makeCopy());

    expect(copy.createdAt).toBe('2026-04-01T00:00:00.000Z');
    expect(copy.updatedAt).toBe('2026-04-02T00:00:00.000Z');
  });

  it('derives percentage and remainder from the copy page count', () => {
    const summary = buildCopySummary(makeCopy({ pageCount: 400, currentPage: 100 }), null, 0, 'UTC', NOW);

    expect(summary.effectivePageCount).toBe(400);
    expect(summary.percentage).toBe(25);
    expect(summary.pagesRemaining).toBe(300);
  });

  it('prefers the copy page count over the metadata page count', () => {
    // The physical edition in hand can be a different printing than the metadata record.
    const summary = buildCopySummary(makeCopy({ pageCount: 350, currentPage: 175 }), 400, 0, 'UTC', NOW);

    expect(summary.effectivePageCount).toBe(350);
    expect(summary.percentage).toBe(50);
  });

  it('falls back to the metadata page count when the copy has none', () => {
    const summary = buildCopySummary(makeCopy({ pageCount: null, currentPage: 50 }), 200, 0, 'UTC', NOW);

    expect(summary.effectivePageCount).toBe(200);
    expect(summary.percentage).toBe(25);
  });

  it('leaves every derived number null when no page count is known', () => {
    const summary = buildCopySummary(makeCopy({ pageCount: null, currentPage: 50 }), null, 0, 'UTC', NOW);

    expect(summary.effectivePageCount).toBeNull();
    expect(summary.percentage).toBeNull();
    expect(summary.pagesRemaining).toBeNull();
  });

  it('rounds the percentage to two decimals rather than storing it', () => {
    const summary = buildCopySummary(makeCopy({ pageCount: 333, currentPage: 100 }), null, 0, 'UTC', NOW);

    expect(summary.percentage).toBe(30.03);
  });

  it('never reports a negative remainder when the page count shrinks below current page', () => {
    const summary = buildCopySummary(makeCopy({ pageCount: 100, currentPage: 150 }), null, 0, 'UTC', NOW);

    expect(summary.pagesRemaining).toBe(0);
  });

  it('carries the loan pressure fields for an active loan', () => {
    const summary = buildCopySummary(
      makeCopy({ acquisition: 'borrowed_library', lender: 'City Library', dueOn: '2026-08-15', pageCount: 400, currentPage: 100 }),
      null,
      10,
      'UTC',
      NOW,
    );

    expect(summary.daysRemaining).toBe(3);
    expect(summary.pagesPerDayNeeded).toBe(100);
    expect(summary.paceLast7Days).toBe(10);
    expect(summary.onTrack).toBe(false);
    expect(summary.urgency).toBe('urgent');
  });

  it('reports no loan pressure for an owned copy', () => {
    const summary = buildCopySummary(makeCopy(), null, 5, 'UTC', NOW);

    expect(summary.urgency).toBeNull();
    expect(summary.daysRemaining).toBeNull();
    expect(summary.paceLast7Days).toBe(5);
  });
});
