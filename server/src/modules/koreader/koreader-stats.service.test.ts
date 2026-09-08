import { BadRequestException, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import {
  ACHIEVEMENT_EVENT_BACKFILL,
  ACHIEVEMENT_EVENT_READING_SESSION_SAVED,
  type AchievementEventsService,
} from '../achievement/achievement-events.service';
import type { PageStatsUploadDto } from './dto';
import type { KoreaderPluginRepository } from './koreader-plugin.repository';
import type { KoreaderRepository } from './koreader.repository';
import { KoreaderStatsService } from './koreader-stats.service';
import type { DerivedKoreaderSession } from './koreader-stats.util';

const DEVICE_ID = 'abcdef12-3456-7890-abcd-ef1234567890';
const HASH_A = 'a'.repeat(32);
const HASH_B = 'b'.repeat(32);

function mirrorGeneration(base = 'v2-test', timeZone = 'Asia/Kolkata'): string {
  return `${base}-${createHash('sha256').update(timeZone).digest('hex').slice(0, 8)}`;
}

function makeUser(): RequestUser {
  return { id: 7, settings: { timezone: 'Asia/Kolkata' } } as unknown as RequestUser;
}

function makeDto(books: PageStatsUploadDto['books'], mirror?: PageStatsUploadDto['mirror']): PageStatsUploadDto {
  return { deviceId: DEVICE_ID, deviceModel: 'Kobo Libra 2', pluginVersion: '0.1.0', books, mirror } as PageStatsUploadDto;
}

function makeSession(startEpoch: number): DerivedKoreaderSession {
  return {
    sessionId: `kor:abcdef12:10:${startEpoch}`,
    startedAt: new Date(startEpoch * 1000),
    endedAt: new Date((startEpoch + 60) * 1000),
    durationSeconds: 60,
    progressDelta: 1,
    endProgress: 10,
  };
}

describe('KoreaderStatsService', () => {
  let koreaderRepo: {
    getAccessibleLibraryIds: ReturnType<typeof vi.fn>;
    resolveBookFilesByHashes: ReturnType<typeof vi.fn>;
    restoreDevice: ReturnType<typeof vi.fn>;
  };
  let pluginRepo: {
    ingestAndDeriveForBook: ReturnType<typeof vi.fn>;
    getStatisticsMirrorBounds: ReturnType<typeof vi.fn>;
    getStatisticsMirrorPage: ReturnType<typeof vi.fn>;
  };
  let achievementEvents: { emit: ReturnType<typeof vi.fn> };
  let service: KoreaderStatsService;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    koreaderRepo = {
      getAccessibleLibraryIds: vi.fn().mockResolvedValue([1]),
      resolveBookFilesByHashes: vi.fn().mockResolvedValue(new Map([[HASH_A, { bookFileId: 10, bookId: 20, libraryId: 1 }]])),
      restoreDevice: vi.fn().mockResolvedValue(undefined),
    };
    pluginRepo = {
      ingestAndDeriveForBook: vi
        .fn()
        .mockResolvedValue({ accepted: 2, duplicates: 0, insertedSessions: [], updatedSessions: [], deletedSessions: 0 }),
      getStatisticsMirrorBounds: vi.fn().mockResolvedValue({ pageMaxId: 12, sessionMaxId: 34, generation: 'v2-test' }),
      getStatisticsMirrorPage: vi.fn().mockResolvedValue({
        rows: [
          {
            id: 34,
            kind: 'session',
            bookId: 20,
            hash: HASH_A,
            title: 'Dune',
            authors: 'Frank Herbert',
            pages: 412,
            page: 9_903,
            startTime: 1_700_000_000,
            durationSeconds: 900,
            totalPages: 10_000,
          },
        ],
        pageAfterId: 12,
        sessionAfterId: 34,
      }),
    };
    achievementEvents = { emit: vi.fn() };

    service = new KoreaderStatsService(
      koreaderRepo as unknown as KoreaderRepository,
      pluginRepo as unknown as KoreaderPluginRepository,
      achievementEvents as unknown as AchievementEventsService,
    );
  });

  it('rejects requests with more than 500 events in total', async () => {
    const events = Array.from({ length: 501 }, (_, i) => ({ page: 1, startTime: 1000 + i, durationSeconds: 10, totalPages: 100 }));
    await expect(service.uploadPageStats(makeUser(), makeDto([{ hash: HASH_A, events }]))).rejects.toBeInstanceOf(BadRequestException);
    expect(pluginRepo.ingestAndDeriveForBook).not.toHaveBeenCalled();
  });

  it('reports unmatched hashes without ingesting them', async () => {
    const dto = makeDto([
      { hash: HASH_A, events: [{ page: 1, startTime: 1000, durationSeconds: 30, totalPages: 100 }] },
      { hash: HASH_B, events: [{ page: 2, startTime: 2000, durationSeconds: 30, totalPages: 100 }] },
    ]);

    const result = await service.uploadPageStats(makeUser(), dto);

    expect(result.unmatched).toEqual([HASH_B]);
    expect(result.results).toHaveLength(1);
    expect(pluginRepo.ingestAndDeriveForBook).toHaveBeenCalledTimes(1);
    expect(pluginRepo.ingestAndDeriveForBook).toHaveBeenCalledWith({
      userId: 7,
      bookFileId: 10,
      bookId: 20,
      libraryId: 1,
      deviceId: DEVICE_ID,
      deviceModel: 'Kobo Libra 2',
      events: dto.books[0]!.events,
      timeZone: 'Asia/Kolkata',
    });
  });

  it('returns the max submitted startTime as watermark even when everything is a duplicate', async () => {
    pluginRepo.ingestAndDeriveForBook.mockResolvedValue({
      accepted: 0,
      duplicates: 2,
      insertedSessions: [],
      updatedSessions: [],
      deletedSessions: 0,
    });
    const dto = makeDto([
      {
        hash: HASH_A,
        events: [
          { page: 1, startTime: 5000, durationSeconds: 30, totalPages: 100 },
          { page: 2, startTime: 9000, durationSeconds: 30, totalPages: 100 },
        ],
      },
    ]);

    const result = await service.uploadPageStats(makeUser(), dto);

    expect(result.results[0]).toEqual({ hash: HASH_A, accepted: 0, duplicates: 2, watermark: 9000 });
  });

  it('emits one reading-session event per inserted session below the backfill threshold', async () => {
    pluginRepo.ingestAndDeriveForBook.mockResolvedValue({
      accepted: 2,
      duplicates: 0,
      insertedSessions: [makeSession(1000), makeSession(5000)],
      updatedSessions: [],
      deletedSessions: 0,
    });
    const dto = makeDto([{ hash: HASH_A, events: [{ page: 1, startTime: 1000, durationSeconds: 30, totalPages: 100 }] }]);

    await service.uploadPageStats(makeUser(), dto);

    expect(achievementEvents.emit).toHaveBeenCalledTimes(2);
    expect(achievementEvents.emit).toHaveBeenCalledWith(
      ACHIEVEMENT_EVENT_READING_SESSION_SAVED,
      expect.objectContaining({ userId: 7, bookFileId: 10, durationSeconds: 60, timezone: 'Asia/Kolkata' }),
    );
  });

  it('emits a reading-session event with the latest values for an updated session', async () => {
    const updatedSession = {
      ...makeSession(1000),
      durationSeconds: 180,
      progressDelta: 56,
      endProgress: 56.5,
    };
    pluginRepo.ingestAndDeriveForBook.mockResolvedValue({
      accepted: 1,
      duplicates: 0,
      insertedSessions: [],
      updatedSessions: [updatedSession],
      deletedSessions: 0,
    });
    const dto = makeDto([{ hash: HASH_A, events: [{ page: 113, startTime: 1200, durationSeconds: 60, totalPages: 200 }] }]);

    await service.uploadPageStats(makeUser(), dto);

    expect(achievementEvents.emit).toHaveBeenCalledOnce();
    expect(achievementEvents.emit).toHaveBeenCalledWith(ACHIEVEMENT_EVENT_READING_SESSION_SAVED, {
      userId: 7,
      bookFileId: 10,
      durationSeconds: 180,
      startedAt: updatedSession.startedAt,
      endedAt: updatedSession.endedAt,
      progressDelta: 56,
      endProgress: 56.5,
      timezone: 'Asia/Kolkata',
    });
  });

  it('emits a single backfill event when inserted and updated sessions together exceed the threshold', async () => {
    pluginRepo.ingestAndDeriveForBook.mockResolvedValue({
      accepted: 30,
      duplicates: 0,
      insertedSessions: Array.from({ length: 11 }, (_, i) => makeSession(1000 + i * 4000)),
      updatedSessions: Array.from({ length: 10 }, (_, i) => makeSession(50_000 + i * 4000)),
      deletedSessions: 0,
    });
    const dto = makeDto([{ hash: HASH_A, events: [{ page: 1, startTime: 1000, durationSeconds: 30, totalPages: 100 }] }]);

    await service.uploadPageStats(makeUser(), dto);

    expect(achievementEvents.emit).toHaveBeenCalledTimes(1);
    expect(achievementEvents.emit).toHaveBeenCalledWith(ACHIEVEMENT_EVENT_BACKFILL, { userId: 7 });
  });

  it('normalizes hashes to lowercase before resolution', async () => {
    const dto = makeDto([{ hash: HASH_A.toUpperCase(), events: [{ page: 1, startTime: 1000, durationSeconds: 30, totalPages: 100 }] }]);

    const result = await service.uploadPageStats(makeUser(), dto);

    expect(koreaderRepo.resolveBookFilesByHashes).toHaveBeenCalledWith([HASH_A], [1], 7);
    expect(result.results[0]!.hash).toBe(HASH_A);
  });

  it('returns a frozen account-wide mirror page without requiring an upload', async () => {
    const result = await service.uploadPageStats(makeUser(), makeDto([], { limit: 50 }));

    expect(pluginRepo.getStatisticsMirrorBounds).toHaveBeenCalledWith(7, [1]);
    expect(pluginRepo.getStatisticsMirrorPage).toHaveBeenCalledWith({
      userId: 7,
      accessibleLibraryIds: [1],
      bounds: { pageMaxId: 12, sessionMaxId: 34, generation: mirrorGeneration() },
      pageAfterId: 0,
      sessionAfterId: 0,
      limit: 50,
    });
    expect(result.mirror).toEqual({
      generation: mirrorGeneration(),
      items: [expect.objectContaining({ key: 'session:34', kind: 'session', title: 'Dune', durationSeconds: 900 })],
      nextCursor: null,
      done: true,
    });
    expect(pluginRepo.ingestAndDeriveForBook).not.toHaveBeenCalled();
    expect(koreaderRepo.restoreDevice).not.toHaveBeenCalled();
  });

  it('short-circuits an unchanged completed mirror generation', async () => {
    const generation = mirrorGeneration();
    const result = await service.uploadPageStats(makeUser(), makeDto([], { knownGeneration: generation }));

    expect(result.mirror).toEqual({ generation, items: [], nextCursor: null, done: true });
    expect(pluginRepo.getStatisticsMirrorBounds).toHaveBeenCalledOnce();
    expect(pluginRepo.getStatisticsMirrorPage).not.toHaveBeenCalled();
  });

  it('splits mirrored sessions at profile-timezone midnight without changing total duration', async () => {
    const startedAt = new Date('2026-09-07T06:50:00.000Z');
    const endedAt = new Date('2026-09-07T07:10:00.000Z');
    pluginRepo.getStatisticsMirrorBounds.mockResolvedValueOnce({ pageMaxId: 12, sessionMaxId: 35, generation: 'v2-midnight' });
    pluginRepo.getStatisticsMirrorPage.mockResolvedValueOnce({
      rows: [
        {
          id: 35,
          kind: 'session',
          bookId: 20,
          hash: HASH_A,
          title: 'Dune',
          authors: 'Frank Herbert',
          pages: 412,
          page: 5_000,
          startTime: Math.floor(startedAt.getTime() / 1000),
          endedAt,
          durationSeconds: 1_200,
          totalPages: 10_000,
        },
      ],
      pageAfterId: 12,
      sessionAfterId: 35,
    });

    const user = { ...makeUser(), settings: { timezone: 'America/Los_Angeles' } } as RequestUser;
    const result = await service.uploadPageStats(user, makeDto([], { limit: 50 }));

    expect(result.mirror?.items).toEqual([
      expect.objectContaining({ key: 'session:35:0', startTime: Math.floor(startedAt.getTime() / 1000), durationSeconds: 600 }),
      expect.objectContaining({
        key: 'session:35:1',
        startTime: Math.floor(new Date('2026-09-07T07:00:00.000Z').getTime() / 1000),
        durationSeconds: 600,
      }),
    ]);
    expect(result.mirror?.items.reduce((sum, item) => sum + item.durationSeconds, 0)).toBe(1_200);
  });

  it('rejects an empty upload that does not request a mirror page', async () => {
    await expect(service.uploadPageStats(makeUser(), makeDto([]))).rejects.toThrow(
      'At least one page-stat book or a statistics mirror request is required',
    );
  });

  it('rejects a malformed mirror cursor before querying a page', async () => {
    await expect(service.uploadPageStats(makeUser(), makeDto([], { cursor: 'bm90LWpzb24' }))).rejects.toThrow('Invalid statistics mirror cursor');
    expect(pluginRepo.getStatisticsMirrorPage).not.toHaveBeenCalled();
  });
});
