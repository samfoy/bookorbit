import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { KoreaderStatisticsMirrorItem, KoreaderStatisticsMirrorPage, UserSettings } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { splitReadingSessionByDay } from '../../common/utils/reading-daily-stats.utils';
import { resolveTimeZone, toTimeZoneStartOfDay } from '../../common/utils/timezone.utils';
import {
  ACHIEVEMENT_EVENT_BACKFILL,
  ACHIEVEMENT_EVENT_READING_SESSION_SAVED,
  AchievementEventsService,
} from '../achievement/achievement-events.service';
import type { PageStatsUploadDto } from './dto';
import { KoreaderPluginRepository, type StatisticsMirrorBounds } from './koreader-plugin.repository';
import { KoreaderRepository } from './koreader.repository';
import { KOREADER_BACKFILL_EVENT_THRESHOLD, type DerivedKoreaderSession } from './koreader-stats.util';

const PAGE_STATS_EVENT = 'koreader.plugin.page_stats';
const MAX_EVENTS_PER_REQUEST = 500;
const DEFAULT_MIRROR_PAGE_SIZE = 100;

interface MirrorCursor {
  version: 1;
  generation: string;
  pageMaxId: number;
  sessionMaxId: number;
  pageAfterId: number;
  sessionAfterId: number;
}

function encodeMirrorCursor(cursor: MirrorCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeMirrorCursor(value: string): MirrorCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<MirrorCursor>;
    const fields = [parsed.pageMaxId, parsed.sessionMaxId, parsed.pageAfterId, parsed.sessionAfterId];
    if (
      parsed.version !== 1 ||
      typeof parsed.generation !== 'string' ||
      !/^v[0-9]+-[A-Za-z0-9_-]+$/.test(parsed.generation) ||
      fields.some((field) => !Number.isSafeInteger(field) || field! < 0)
    )
      throw new Error('invalid fields');
    if (parsed.pageAfterId! > parsed.pageMaxId! || parsed.sessionAfterId! > parsed.sessionMaxId!) throw new Error('invalid bounds');
    return parsed as MirrorCursor;
  } catch {
    throw new BadRequestException('Invalid statistics mirror cursor');
  }
}

export interface PageStatsBookResult {
  hash: string;
  accepted: number;
  duplicates: number;
  watermark: number;
}

export interface PageStatsUploadResult {
  results: PageStatsBookResult[];
  unmatched: string[];
  mirror?: KoreaderStatisticsMirrorPage;
}

@Injectable()
export class KoreaderStatsService {
  private readonly logger = new Logger(KoreaderStatsService.name);

  constructor(
    private readonly koreaderRepo: KoreaderRepository,
    private readonly pluginRepo: KoreaderPluginRepository,
    private readonly achievementEvents: AchievementEventsService,
  ) {}

  async uploadPageStats(user: RequestUser, dto: PageStatsUploadDto): Promise<PageStatsUploadResult> {
    const startedAtMs = Date.now();
    const totalEvents = dto.books.reduce((sum, book) => sum + book.events.length, 0);
    this.logger.log(
      `[${PAGE_STATS_EVENT}] [start] userId=${user.id} deviceId=${dto.deviceId.slice(0, 8)} books=${dto.books.length} events=${totalEvents} - page stats upload started`,
    );

    try {
      if (totalEvents > MAX_EVENTS_PER_REQUEST) {
        throw new BadRequestException(`Too many page stat events in one request (max ${MAX_EVENTS_PER_REQUEST})`);
      }
      if (dto.books.length === 0 && !dto.mirror) {
        throw new BadRequestException('At least one page-stat book or a statistics mirror request is required');
      }

      const accessibleLibraryIds = await this.koreaderRepo.getAccessibleLibraryIds(user.id);
      const timeZone = resolveTimeZone((user.settings as unknown as UserSettings | undefined)?.timezone, 'UTC');
      const hashes = [...new Set(dto.books.map((book) => book.hash.toLowerCase()))];
      const matches = await this.koreaderRepo.resolveBookFilesByHashes(hashes, accessibleLibraryIds, user.id);

      const results: PageStatsBookResult[] = [];
      const unmatched: string[] = [];
      const changedSessions: { session: DerivedKoreaderSession; bookFileId: number }[] = [];
      let acceptedTotal = 0;
      let insertedSessionCount = 0;
      let updatedSessionCount = 0;

      for (const book of dto.books) {
        const hash = book.hash.toLowerCase();
        const match = matches.get(hash);
        if (!match) {
          unmatched.push(hash);
          continue;
        }

        const result = await this.pluginRepo.ingestAndDeriveForBook({
          userId: user.id,
          bookFileId: match.bookFileId,
          bookId: match.bookId,
          libraryId: match.libraryId,
          deviceId: dto.deviceId,
          deviceModel: dto.deviceModel,
          events: book.events,
          timeZone,
        });

        acceptedTotal += result.accepted;
        insertedSessionCount += result.insertedSessions.length;
        updatedSessionCount += result.updatedSessions.length;
        for (const session of result.insertedSessions) {
          changedSessions.push({ session, bookFileId: match.bookFileId });
        }
        for (const session of result.updatedSessions) {
          changedSessions.push({ session, bookFileId: match.bookFileId });
        }

        // Watermark covers every event processed in this batch, duplicates included, so a plugin
        // that lost its local state still advances past history the server already has.
        const watermark = book.events.reduce((max, event) => Math.max(max, event.startTime), 0);
        results.push({ hash, accepted: result.accepted, duplicates: result.duplicates, watermark });
      }

      if (acceptedTotal > 0) await this.koreaderRepo.restoreDevice(user.id, dto.deviceId);

      this.emitSessionAchievements(user, changedSessions);

      const mirror = dto.mirror
        ? await this.buildStatisticsMirrorPage(
            user,
            accessibleLibraryIds,
            dto.mirror.cursor,
            dto.mirror.knownGeneration,
            dto.mirror.limit ?? DEFAULT_MIRROR_PAGE_SIZE,
          )
        : undefined;

      this.logger.log(
        `[${PAGE_STATS_EVENT}] [end] userId=${user.id} deviceId=${dto.deviceId.slice(0, 8)} durationMs=${Date.now() - startedAtMs} accepted=${acceptedTotal} sessionsInserted=${insertedSessionCount} sessionsUpdated=${updatedSessionCount} unmatched=${unmatched.length} mirrorItems=${mirror?.items.length ?? 0} - page stats exchange completed`,
      );

      return { results, unmatched, ...(mirror ? { mirror } : {}) };
    } catch (error) {
      const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
      this.logger.warn(
        `[${PAGE_STATS_EVENT}] [fail] userId=${user.id} deviceId=${dto.deviceId.slice(0, 8)} durationMs=${Date.now() - startedAtMs} errorClass=${errorClass} error="${sanitizeLogValue(error instanceof Error ? error.message : 'unknown error')}" - page stats upload failed`,
      );
      throw error;
    }
  }

  private async buildStatisticsMirrorPage(
    user: RequestUser,
    accessibleLibraryIds: number[] | null,
    encodedCursor: string | undefined,
    knownGeneration: string | undefined,
    limit: number,
  ): Promise<KoreaderStatisticsMirrorPage> {
    const timeZone = resolveTimeZone((user.settings as unknown as UserSettings | undefined)?.timezone, 'UTC');
    let cursor: MirrorCursor;
    if (encodedCursor) {
      cursor = decodeMirrorCursor(encodedCursor);
    } else {
      const bounds: StatisticsMirrorBounds = await this.pluginRepo.getStatisticsMirrorBounds(user.id, accessibleLibraryIds);
      const generation = `${bounds.generation}-${createHash('sha256').update(timeZone).digest('hex').slice(0, 8)}`;
      if (knownGeneration === generation) {
        return { generation, items: [], nextCursor: null, done: true };
      }
      cursor = { version: 1, ...bounds, generation, pageAfterId: 0, sessionAfterId: 0 };
    }

    const page = await this.pluginRepo.getStatisticsMirrorPage({
      userId: user.id,
      accessibleLibraryIds,
      bounds: { pageMaxId: cursor.pageMaxId, sessionMaxId: cursor.sessionMaxId, generation: cursor.generation },
      pageAfterId: cursor.pageAfterId,
      sessionAfterId: cursor.sessionAfterId,
      limit,
    });
    const done = page.pageAfterId >= cursor.pageMaxId && page.sessionAfterId >= cursor.sessionMaxId;
    const nextCursor = done ? null : encodeMirrorCursor({ ...cursor, pageAfterId: page.pageAfterId, sessionAfterId: page.sessionAfterId });

    const items = page.rows.flatMap<KoreaderStatisticsMirrorItem>((row) => {
      const base = {
        kind: row.kind,
        bookId: row.bookId,
        hash: row.hash,
        title: row.title,
        authors: row.authors,
        pages: row.pages,
        page: row.page,
        totalPages: row.totalPages,
      };
      if (row.kind === 'page' || !row.endedAt) {
        return [{ ...base, key: `${row.kind}:${row.id}`, startTime: row.startTime, durationSeconds: row.durationSeconds }];
      }
      const startedAt = new Date(row.startTime * 1000);
      const segments = splitReadingSessionByDay(
        { startedAt, endedAt: row.endedAt, durationSeconds: row.durationSeconds, progressDelta: null },
        timeZone,
      );
      return segments.map((segment, index) => ({
        ...base,
        key: `session:${row.id}:${index}`,
        startTime: Math.floor(Math.max(startedAt.getTime(), toTimeZoneStartOfDay(segment.day, timeZone).getTime()) / 1000),
        durationSeconds: segment.readingSeconds,
      }));
    });

    return {
      generation: cursor.generation,
      items,
      nextCursor,
      done,
    };
  }

  private emitSessionAchievements(user: RequestUser, sessions: { session: DerivedKoreaderSession; bookFileId: number }[]) {
    if (sessions.length === 0) return;

    // An upload this large is a device catching up rather than a live reading session, so it is
    // evaluated as a backfill: one pass over the catalogue instead of one per session, and awards
    // land silently. Notifying per badge here would burst a toast for every historical unlock.
    if (sessions.length > KOREADER_BACKFILL_EVENT_THRESHOLD) {
      this.achievementEvents.emit(ACHIEVEMENT_EVENT_BACKFILL, { userId: user.id });
      return;
    }

    const timezone = resolveTimeZone((user.settings as unknown as UserSettings | undefined)?.timezone, 'UTC');
    for (const { session, bookFileId } of sessions) {
      this.achievementEvents.emit(ACHIEVEMENT_EVENT_READING_SESSION_SAVED, {
        userId: user.id,
        bookFileId,
        durationSeconds: session.durationSeconds,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        progressDelta: session.progressDelta,
        endProgress: session.endProgress,
        timezone,
      });
    }
  }
}
