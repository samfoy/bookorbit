import type { ReadingSessionSource } from '@bookorbit/types';

export const KOREADER_SESSION_GAP_SECONDS = 1800;
/** Upper bound accepted for a single page event, used to bound backward window scans. */
export const KOREADER_MAX_EVENT_DURATION_SECONDS = 86400;
export const KOREADER_MIN_SESSION_SECONDS = 10;
export const KOREADER_BACKFILL_EVENT_THRESHOLD = 20;

// --- Navigation (scrub) detection -------------------------------------------------
// Page-stats uploaders report one event per rendered page, and cannot distinguish a
// page turn from a seek: dragging a progress slider or holding page-forward emits the
// same event shape as reading, just with a much larger page stride. Treating those as
// reading produced two visible defects on Crosspoint/CrossInk devices:
//   * a session that ended mid-seek reported the seek's landing page as its
//     endProgress, so a LATER session could show LOWER progress than an earlier one;
//   * pace (progressDelta / duration) reported seek speed, e.g. 34%/hr.
// A stride is treated as navigation when it exceeds both a multiple of the session's
// own median stride (self-calibrating: font size, device and book all change the
// natural stride) and a floor fraction of the book (guards tiny-median sessions).
export const KOREADER_NAVIGATION_STRIDE_MULTIPLIER = 5;
export const KOREADER_NAVIGATION_MIN_FRACTION = 0.005;
/** Below this many events a median stride is not meaningful, so nothing is classified. */
export const KOREADER_NAVIGATION_MIN_EVENTS = 4;
/** Reading time after a jump that proves it was a real relocation, not a scrub. */
export const KOREADER_NAVIGATION_SETTLE_SECONDS = 60;

// Map a page-stats uploader's self-reported deviceModel to a reading-session source.
// Crosspoint/CrossInk firmware (Xteink X3/X4) speaks the same KOReader page-stats
// protocol as the official plugin, so it arrives on the /koreader/plugin/page-stats
// endpoint; we distinguish it by deviceModel so the Reading Log can badge it as its
// own source rather than a generic "KOReader". Anything else stays 'koreader'.
export function resolveDeviceSource(deviceModel: string | null | undefined): ReadingSessionSource {
  const model = (deviceModel ?? '').toLowerCase();
  if (model.includes('crosspoint') || model.includes('crossink')) return 'crosspoint';
  return 'koreader';
}

export interface KoreaderPageEvent {
  page: number;
  startTime: number;
  durationSeconds: number;
  totalPages: number;
}

export interface DerivedKoreaderSession {
  sessionId: string;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  progressDelta: number | null;
  endProgress: number | null;
}

export function buildSessionIdPrefix(deviceId: string, bookFileId: number): string {
  return `kor:${deviceId.slice(0, 8)}:${bookFileId}:`;
}

export function buildSessionId(deviceId: string, bookFileId: number, clusterStartEpoch: number): string {
  return `${buildSessionIdPrefix(deviceId, bookFileId)}${clusterStartEpoch}`;
}

export function clusterPageStats(events: KoreaderPageEvent[], gapSeconds: number = KOREADER_SESSION_GAP_SECONDS): KoreaderPageEvent[][] {
  const sorted = [...events].sort((a, b) => a.startTime - b.startTime || a.page - b.page);
  const clusters: KoreaderPageEvent[][] = [];
  let current: KoreaderPageEvent[] = [];
  let clusterEnd = 0;

  for (const event of sorted) {
    // A gap of exactly gapSeconds stays in the same cluster; only a strictly larger gap splits.
    if (current.length > 0 && event.startTime - clusterEnd > gapSeconds) {
      clusters.push(current);
      current = [];
    }
    current.push(event);
    clusterEnd = Math.max(clusterEnd, event.startTime + event.durationSeconds);
  }
  if (current.length > 0) clusters.push(current);

  return clusters;
}

export function computeClusterMetrics(cluster: KoreaderPageEvent[], deviceId: string, bookFileId: number): DerivedKoreaderSession {
  const first = cluster[0]!;
  let endEpoch = first.startTime;
  let durationSum = 0;

  for (const event of cluster) {
    durationSum += event.durationSeconds;
    endEpoch = Math.max(endEpoch, event.startTime + event.durationSeconds);
  }

  // Sum of page durations excludes idle gaps inside the cluster; the wall-clock cap keeps the
  // existing reading_sessions invariant that duration never exceeds endedAt - startedAt.
  const wallClockSeconds = endEpoch - first.startTime;
  const durationSeconds = Math.min(durationSum, wallClockSeconds);

  // Position is taken from the last event that represents READING, so a session that ended
  // while the reader was seeking does not report the seek's landing page as its progress.
  const ordered = orderEvents(cluster);
  const settled = trimTrailingNavigation(ordered);
  const last = settled[settled.length - 1]!;
  const totalPages = last.totalPages;

  const endProgress = totalPages > 0 ? clamp(round2((last.page / totalPages) * 100), 0, 100) : null;
  // Delta counts only reading strides: navigation is movement through the book, not progress
  // earned by reading, and including it makes pace report seek speed.
  const progressDelta = totalPages > 0 ? clamp(round2((sumReadingStrides(settled) / totalPages) * 100), -100, 100) : null;

  return {
    sessionId: buildSessionId(deviceId, bookFileId, first.startTime),
    startedAt: new Date(first.startTime * 1000),
    endedAt: new Date(endEpoch * 1000),
    durationSeconds,
    progressDelta,
    endProgress,
  };
}

export function deriveKoreaderSessions(
  events: KoreaderPageEvent[],
  deviceId: string,
  bookFileId: number,
  gapSeconds: number = KOREADER_SESSION_GAP_SECONDS,
): DerivedKoreaderSession[] {
  return clusterPageStats(events, gapSeconds)
    .map((cluster) => computeClusterMetrics(cluster, deviceId, bookFileId))
    .filter((session) => session.durationSeconds >= KOREADER_MIN_SESSION_SECONDS);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function orderEvents(cluster: KoreaderPageEvent[]): KoreaderPageEvent[] {
  return [...cluster].sort((a, b) => a.startTime - b.startTime || a.page - b.page);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Page-stride size above which a step is navigation (a seek) rather than a page turn.
 * Calibrated from the session's own median stride so it adapts to font size, device and
 * book, with a floor fraction of the book so a session of tiny strides cannot make the
 * threshold collapse toward zero. Returns Infinity when the sample is too small to judge,
 * which disables classification rather than guessing.
 */
function navigationStrideThreshold(events: KoreaderPageEvent[]): number {
  if (events.length < KOREADER_NAVIGATION_MIN_EVENTS) return Number.POSITIVE_INFINITY;
  const strides = pageStrides(events)
    .map(Math.abs)
    .filter((stride) => stride > 0);
  if (strides.length === 0) return Number.POSITIVE_INFINITY;
  const totalPages = events[events.length - 1]!.totalPages;
  return Math.max(KOREADER_NAVIGATION_STRIDE_MULTIPLIER * median(strides), KOREADER_NAVIGATION_MIN_FRACTION * totalPages);
}

function pageStrides(events: KoreaderPageEvent[]): number[] {
  const strides: number[] = [];
  for (let i = 1; i < events.length; i += 1) {
    strides.push(events[i]!.page - events[i - 1]!.page);
  }
  return strides;
}

/**
 * Drop a trailing run of navigation events that never settled back into reading.
 *
 * A large jump FOLLOWED BY sustained reading is a genuine relocation - the reader really
 * is at the new position - so it is kept. A jump at the tail of a session with no reading
 * after it is an unfinished seek, and letting it define endProgress is what allowed a later
 * session to report lower progress than an earlier one. Loops because a scrub usually emits
 * several consecutive jumps.
 */
function trimTrailingNavigation(ordered: KoreaderPageEvent[]): KoreaderPageEvent[] {
  const threshold = navigationStrideThreshold(ordered);
  if (!Number.isFinite(threshold)) return ordered;

  let events = ordered;
  while (events.length >= 2) {
    let lastJump = -1;
    for (let i = events.length - 1; i >= 1; i -= 1) {
      if (Math.abs(events[i]!.page - events[i - 1]!.page) > threshold) {
        lastJump = i;
        break;
      }
    }
    if (lastJump === -1) break;

    const settleSeconds = events.slice(lastJump + 1).reduce((sum, event) => sum + event.durationSeconds, 0);
    if (settleSeconds >= KOREADER_NAVIGATION_SETTLE_SECONDS) break;

    events = events.slice(0, lastJump);
  }

  // Never discard the whole cluster: a session must still report a position.
  return events.length > 0 ? events : ordered.slice(0, 1);
}

/** Net page movement from reading only, excluding navigation jumps. */
function sumReadingStrides(events: KoreaderPageEvent[]): number {
  const threshold = navigationStrideThreshold(events);
  if (!Number.isFinite(threshold)) {
    return events.length > 0 ? events[events.length - 1]!.page - events[0]!.page : 0;
  }
  return pageStrides(events).reduce((sum, stride) => (Math.abs(stride) <= threshold ? sum + stride : sum), 0);
}
