import { describe, expect, it } from 'vitest';

import {
  buildSessionId,
  buildSessionIdPrefix,
  clusterPageStats,
  computeClusterMetrics,
  deriveKoreaderSessions,
  resolveDeviceSource,
  type KoreaderPageEvent,
} from './koreader-stats.util';

const DEVICE_ID = 'abcdef12-3456-7890-abcd-ef1234567890';
const FILE_ID = 42;

function event(startTime: number, durationSeconds = 60, page = 1, totalPages = 100): KoreaderPageEvent {
  return { page, startTime, durationSeconds, totalPages };
}

describe('clusterPageStats', () => {
  it('returns a single cluster for one event', () => {
    expect(clusterPageStats([event(1000)])).toHaveLength(1);
  });

  it('returns no clusters for no events', () => {
    expect(clusterPageStats([])).toHaveLength(0);
  });

  it('keeps a gap of exactly the threshold in the same cluster', () => {
    const clusters = clusterPageStats([event(1000, 60), event(1000 + 60 + 1800, 60)]);
    expect(clusters).toHaveLength(1);
  });

  it('splits when the gap exceeds the threshold by one second', () => {
    const clusters = clusterPageStats([event(1000, 60), event(1000 + 60 + 1801, 60)]);
    expect(clusters).toHaveLength(2);
  });

  it('sorts unordered input before clustering', () => {
    const clusters = clusterPageStats([event(5000), event(1000), event(5100)]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]![0]!.startTime).toBe(1000);
  });

  it('measures gaps from the furthest cluster end with overlapping events', () => {
    // First event spans 1000-2000; the short second event does not shrink the cluster end,
    // so an event at 3700 (gap 1700 from 2000) still joins the cluster.
    const clusters = clusterPageStats([event(1000, 1000), event(1500, 100), event(3700, 60)]);
    expect(clusters).toHaveLength(1);
  });
});

describe('computeClusterMetrics', () => {
  it('uses the event duration for a single-event cluster', () => {
    const session = computeClusterMetrics([event(1000, 45, 10, 200)], DEVICE_ID, FILE_ID);
    expect(session.durationSeconds).toBe(45);
    expect(session.startedAt).toEqual(new Date(1000 * 1000));
    expect(session.endedAt).toEqual(new Date(1045 * 1000));
  });

  it('caps duration at the wall clock span for overlapping events', () => {
    const session = computeClusterMetrics([event(1000, 600), event(1000, 600)], DEVICE_ID, FILE_ID);
    expect(session.durationSeconds).toBe(600);
  });

  it('sums durations and excludes idle time inside the cluster', () => {
    const session = computeClusterMetrics([event(1000, 60), event(2000, 60)], DEVICE_ID, FILE_ID);
    expect(session.durationSeconds).toBe(120);
    expect(session.endedAt).toEqual(new Date(2060 * 1000));
  });

  it('computes endProgress from the last event and progressDelta from first to last', () => {
    const session = computeClusterMetrics([event(1000, 60, 10, 200), event(1100, 60, 30, 200)], DEVICE_ID, FILE_ID);
    expect(session.endProgress).toBe(15);
    expect(session.progressDelta).toBe(10);
  });

  it('allows negative progressDelta when reading backwards', () => {
    const session = computeClusterMetrics([event(1000, 60, 50, 100), event(1100, 60, 20, 100)], DEVICE_ID, FILE_ID);
    expect(session.progressDelta).toBe(-30);
    expect(session.endProgress).toBe(20);
  });

  it('builds deterministic session ids that fit varchar(64)', () => {
    const session = computeClusterMetrics([event(1000)], DEVICE_ID, FILE_ID);
    expect(session.sessionId).toBe('kor:abcdef12:42:1000');

    const longest = buildSessionId(DEVICE_ID, 2147483647, 2147483647);
    expect(longest).toBe('kor:abcdef12:2147483647:2147483647');
    expect(longest.length).toBeLessThanOrEqual(64);
  });
});

describe('computeClusterMetrics navigation (scrub) handling', () => {
  // A page turn on a 10000-unit book is ~9 units; a seek moves ~80+ per event.
  function reading(startTime: number, page: number, durationSeconds = 25): KoreaderPageEvent {
    return { page, startTime, durationSeconds, totalPages: 10000 };
  }

  it('ignores a trailing seek when reporting endProgress', () => {
    // Reads 3236 -> 3300, then scrubs forward to 3736 and stops.
    const cluster = [
      reading(1000, 3236),
      reading(1030, 3245),
      reading(1060, 3254),
      reading(1090, 3263),
      reading(1120, 3272),
      reading(1150, 3281),
      reading(1180, 3290),
      reading(1210, 3300),
      reading(1240, 3480, 8),
      reading(1250, 3563, 15),
      reading(1270, 3645, 12),
      reading(1290, 3736, 10),
    ];
    const session = computeClusterMetrics(cluster, DEVICE_ID, FILE_ID);
    expect(session.endProgress).toBe(33);
    expect(session.progressDelta).toBe(0.64);
  });

  it('keeps a mid-session relocation that is followed by sustained reading', () => {
    // Jumps 2771 -> 3040 then reads for well over the settle window: the reader is really there.
    const cluster = [
      reading(1000, 2678),
      reading(1030, 2687),
      reading(1060, 2696),
      reading(1090, 2706),
      reading(1120, 2715),
      reading(1150, 3040, 4),
      reading(1160, 3049, 30),
      reading(1200, 3058, 30),
      reading(1240, 3067, 30),
    ];
    const session = computeClusterMetrics(cluster, DEVICE_ID, FILE_ID);
    expect(session.endProgress).toBe(30.67);
    // The 325-unit jump is excluded from delta, so pace reflects reading, not the seek.
    expect(session.progressDelta).toBe(0.64);
  });

  it('leaves ordinary reading sessions untouched', () => {
    const cluster = [reading(1000, 3447), reading(1030, 3455), reading(1060, 3463), reading(1090, 3472), reading(1120, 3480)];
    const session = computeClusterMetrics(cluster, DEVICE_ID, FILE_ID);
    expect(session.endProgress).toBe(34.8);
    expect(session.progressDelta).toBe(0.33);
  });

  it('preserves genuine backward re-reading', () => {
    // Paging back to re-read is real movement, not a seek artifact.
    const cluster = [reading(1000, 3000), reading(1030, 3009), reading(1060, 3000), reading(1090, 2991), reading(1120, 2982)];
    const session = computeClusterMetrics(cluster, DEVICE_ID, FILE_ID);
    expect(session.endProgress).toBe(29.82);
    expect(session.progressDelta).toBe(-0.18);
  });

  it('does not classify strides in a cluster too small to calibrate', () => {
    // Under the minimum event count the old first/last behaviour is retained.
    const cluster = [reading(1000, 1000), reading(1030, 5000)];
    const session = computeClusterMetrics(cluster, DEVICE_ID, FILE_ID);
    expect(session.endProgress).toBe(50);
    expect(session.progressDelta).toBe(40);
  });

  it('still reports a position when trimming would discard the whole cluster', () => {
    // Jump on the very first stride, with too little reading after it to settle: trimming
    // walks back to the first event rather than leaving the session with no position.
    const cluster = [reading(1000, 100, 5), reading(1010, 900, 5), reading(1020, 910, 5), reading(1030, 920, 5)];
    const session = computeClusterMetrics(cluster, DEVICE_ID, FILE_ID);
    expect(session.endProgress).toBe(1);
    expect(session.progressDelta).toBe(0);
  });

  it('does not classify strides when every stride is equally large', () => {
    // Documented limitation: detection is relative to the session's own median stride, so a
    // cluster that is uniformly large-stride has no outlier to find. This is deliberate - an
    // absolute page threshold would misfire across books, fonts and devices, and kosync
    // progress remains the authoritative position regardless.
    const cluster = [reading(1000, 100, 5), reading(1010, 900, 5), reading(1020, 1700, 5), reading(1030, 2500, 5)];
    const session = computeClusterMetrics(cluster, DEVICE_ID, FILE_ID);
    expect(session.endProgress).toBe(25);
    expect(session.progressDelta).toBe(24);
  });

  it('reproduces the real X4 Pro regression from recorded page-stats', () => {
    // Verbatim page/dwell pairs from device crossink-x4pro, book file 41, 2026-08-10.
    // Session A ended on a scrub to 3736 (37.36%); session B then read to 3645 (36.45%),
    // which is what made a later session appear to lose progress.
    const sessionA: KoreaderPageEvent[] = [
      [3236, 26],
      [3245, 27],
      [3255, 49],
      [3264, 26],
      [3274, 25],
      [3283, 31],
      [3293, 13],
      [3302, 20],
      [3312, 28],
      [3321, 33],
      [3331, 31],
      [3340, 29],
      [3350, 20],
      [3359, 21],
      [3369, 36],
      [3378, 19],
      [3480, 8],
      [3563, 15],
      [3645, 23],
      [3728, 27],
      [3736, 23],
    ].map(([page, durationSeconds], i) => ({ page: page!, startTime: 1000 + i * 40, durationSeconds: durationSeconds!, totalPages: 10000 }));

    const a = computeClusterMetrics(sessionA, DEVICE_ID, FILE_ID);
    const b = computeClusterMetrics([reading(90_000, 3447), reading(90_030, 3538), reading(90_060, 3596), reading(90_090, 3645)], DEVICE_ID, FILE_ID);

    // The scrub no longer defines session A, so the later session is no longer "behind".
    expect(a.endProgress).toBe(33.78);
    expect(b.endProgress).toBe(36.45);
    expect(b.endProgress!).toBeGreaterThan(a.endProgress!);

    // Pace was 34%/hr from seek speed; reading-only movement is 3236 -> 3378 = 142 units,
    // i.e. 1.42% over the same span, roughly 9.6%/hr.
    expect(a.progressDelta).toBe(1.42);
  });
});

describe('deriveKoreaderSessions', () => {
  it('drops sessions shorter than the minimum duration', () => {
    const sessions = deriveKoreaderSessions([event(1000, 5)], DEVICE_ID, FILE_ID);
    expect(sessions).toHaveLength(0);
  });

  it('merges two sessions when a late gap-filling event arrives, keeping the earlier session id', () => {
    const early = [event(1000, 60, 10), event(2000, 60, 12)];
    const late = [event(5000, 60, 20)];

    const before = deriveKoreaderSessions([...early, ...late], DEVICE_ID, FILE_ID);
    expect(before).toHaveLength(2);
    expect(before.map((s) => s.sessionId)).toEqual([buildSessionId(DEVICE_ID, FILE_ID, 1000), buildSessionId(DEVICE_ID, FILE_ID, 5000)]);

    const filler = event(3500, 60, 15);
    const after = deriveKoreaderSessions([...early, ...late, filler], DEVICE_ID, FILE_ID);
    expect(after).toHaveLength(1);
    expect(after[0]!.sessionId).toBe(buildSessionId(DEVICE_ID, FILE_ID, 1000));
    expect(after[0]!.durationSeconds).toBe(240);
  });

  it('builds a prefix that scopes ids per device and file', () => {
    expect(buildSessionIdPrefix(DEVICE_ID, FILE_ID)).toBe('kor:abcdef12:42:');
  });
});

describe('resolveDeviceSource', () => {
  it('maps Crosspoint/CrossInk device models to the crosspoint source', () => {
    expect(resolveDeviceSource('Crosspoint X3')).toBe('crosspoint');
    expect(resolveDeviceSource('CrossInk X4')).toBe('crosspoint');
    expect(resolveDeviceSource('xteink crosspoint')).toBe('crosspoint');
  });

  it('falls back to koreader for other device models', () => {
    expect(resolveDeviceSource('Kobo Libra 2')).toBe('koreader');
    expect(resolveDeviceSource('KOReader')).toBe('koreader');
    expect(resolveDeviceSource('')).toBe('koreader');
    expect(resolveDeviceSource(null)).toBe('koreader');
    expect(resolveDeviceSource(undefined)).toBe('koreader');
  });
});
