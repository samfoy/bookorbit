import { computeLoanUrgency, diffDateKeysInDays } from './loan-urgency.utils';

const PACIFIC = 'America/Los_Angeles';

function urgencyFor(overrides?: Partial<Parameters<typeof computeLoanUrgency>[0]>) {
  return computeLoanUrgency({
    acquisition: 'borrowed_library',
    dueOn: '2026-08-20',
    returnedOn: null,
    pagesRemaining: 100,
    paceLast7Days: 0,
    timeZone: 'UTC',
    now: new Date('2026-08-12T12:00:00Z'),
    ...overrides,
  });
}

describe('loan urgency', () => {
  describe('timezone day boundary', () => {
    // The server runs Etc/UTC. At 5pm Pacific on the due date it is already the next day in UTC,
    // so raw-instant math would report a book due today as overdue and nag a day early.
    it('reads a book due today as due today at 5pm Pacific, not overdue', () => {
      const result = urgencyFor({
        dueOn: '2026-08-20',
        timeZone: PACIFIC,
        now: new Date('2026-08-21T00:00:00Z'), // 2026-08-20 17:00 Pacific
      });

      expect(result.daysRemaining).toBe(0);
      expect(result.urgency).toBe('urgent');
    });

    it('reports the same instant as overdue for a reader actually in UTC', () => {
      const result = urgencyFor({
        dueOn: '2026-08-20',
        timeZone: 'UTC',
        now: new Date('2026-08-21T00:00:00Z'),
      });

      expect(result.daysRemaining).toBe(-1);
      expect(result.urgency).toBe('overdue');
    });

    it('does not roll the day forward until Pacific midnight', () => {
      const justBefore = urgencyFor({ dueOn: '2026-08-20', timeZone: PACIFIC, now: new Date('2026-08-21T06:59:00Z') });
      const justAfter = urgencyFor({ dueOn: '2026-08-20', timeZone: PACIFIC, now: new Date('2026-08-21T07:00:00Z') });

      expect(justBefore.daysRemaining).toBe(0);
      expect(justAfter.daysRemaining).toBe(-1);
    });

    it('counts whole calendar days across a spring-forward transition', () => {
      // 2026-03-08 is the US DST spring-forward day; that day is 23 hours long.
      expect(diffDateKeysInDays('2026-03-09', '2026-03-07')).toBe(2);
    });
  });

  describe('pace math', () => {
    it('needs the whole remainder today on the due date', () => {
      const result = urgencyFor({ dueOn: '2026-08-12', pagesRemaining: 80, now: new Date('2026-08-12T12:00:00Z') });

      expect(result.daysRemaining).toBe(0);
      expect(result.pagesPerDayNeeded).toBe(80);
    });

    it('divides the remainder across the days left and rounds up', () => {
      const result = urgencyFor({ dueOn: '2026-08-19', pagesRemaining: 100 });

      expect(result.daysRemaining).toBe(7);
      expect(result.pagesPerDayNeeded).toBe(15);
    });

    it('is on track when the trailing pace meets the required rate', () => {
      const result = urgencyFor({ dueOn: '2026-08-22', pagesRemaining: 100, paceLast7Days: 10 });

      expect(result.pagesPerDayNeeded).toBe(10);
      expect(result.onTrack).toBe(true);
      expect(result.urgency).toBe('comfortable');
    });

    it('is off track when the trailing pace falls short by any margin', () => {
      const result = urgencyFor({ dueOn: '2026-08-22', pagesRemaining: 100, paceLast7Days: 9.99 });

      expect(result.onTrack).toBe(false);
    });
  });

  describe('classification', () => {
    it('is overdue past the due date regardless of pace', () => {
      expect(urgencyFor({ dueOn: '2026-08-11', paceLast7Days: 500 }).urgency).toBe('overdue');
    });

    it('is urgent within two days even when on track', () => {
      expect(urgencyFor({ dueOn: '2026-08-14', pagesRemaining: 10, paceLast7Days: 500 }).urgency).toBe('urgent');
    });

    it('is urgent within five days when off track', () => {
      expect(urgencyFor({ dueOn: '2026-08-17', pagesRemaining: 100, paceLast7Days: 1 }).urgency).toBe('urgent');
    });

    it('is tight when off track but the deadline is further out', () => {
      expect(urgencyFor({ dueOn: '2026-08-30', pagesRemaining: 500, paceLast7Days: 1 }).urgency).toBe('tight');
    });

    it('is comfortable when on track and the deadline is far off', () => {
      expect(urgencyFor({ dueOn: '2026-09-30', pagesRemaining: 100, paceLast7Days: 50 }).urgency).toBe('comfortable');
    });
  });

  describe('non-loans', () => {
    it('has no urgency for an owned copy', () => {
      expect(urgencyFor({ acquisition: 'owned' })).toEqual({
        daysRemaining: null,
        pagesPerDayNeeded: null,
        onTrack: null,
        urgency: null,
      });
    });

    it('has no urgency once the copy is returned', () => {
      expect(urgencyFor({ returnedOn: '2026-08-11' }).urgency).toBeNull();
    });

    it('has no urgency for a borrowed copy with no due date', () => {
      expect(urgencyFor({ dueOn: null }).urgency).toBeNull();
    });
  });

  describe('unknown page count', () => {
    it('judges the deadline but not the pace when there is no denominator', () => {
      const result = urgencyFor({ dueOn: '2026-08-13', pagesRemaining: null });

      expect(result.pagesPerDayNeeded).toBeNull();
      expect(result.onTrack).toBeNull();
      expect(result.urgency).toBe('urgent');
    });

    it('still reports overdue with no page count', () => {
      expect(urgencyFor({ dueOn: '2026-08-01', pagesRemaining: null }).urgency).toBe('overdue');
    });
  });
});
