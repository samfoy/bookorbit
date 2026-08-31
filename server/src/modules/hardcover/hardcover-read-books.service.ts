import { Injectable } from '@nestjs/common';

import { HARDCOVER_STATUS } from './hardcover.constants';
import { HardcoverClientService } from './hardcover-client.service';
import { HardcoverSettingsService } from './hardcover-settings.service';

const READ_BOOK_PAGE_SIZE = 200;
const CACHE_TTL_MS = 5 * 60 * 1000;

const READ_BOOK_IDS_QUERY = `
query ReadBookIds($limit: Int!, $offset: Int!) {
  me {
    user_books(
      where: { status_id: { _eq: ${HARDCOVER_STATUS.READ} } }
      order_by: { book_id: asc }
      limit: $limit
      offset: $offset
    ) { book_id }
  }
}`;

interface ReadBookIdsResponse {
  me?: Array<{ user_books?: Array<{ book_id?: number | null }> }>;
}

interface CachedReadBooks {
  expiresAt: number;
  ids: Set<number>;
}

@Injectable()
export class HardcoverReadBooksService {
  private readonly cache = new Map<number, CachedReadBooks>();
  private readonly pending = new Map<number, Promise<Set<number>>>();

  constructor(
    private readonly client: HardcoverClientService,
    private readonly settings: HardcoverSettingsService,
  ) {}

  async getReadBookIds(userId: number): Promise<Set<number>> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.ids;

    const inFlight = this.pending.get(userId);
    if (inFlight) return inFlight;

    const load = this.loadReadBookIds(userId).finally(() => this.pending.delete(userId));
    this.pending.set(userId, load);
    return load;
  }

  private async loadReadBookIds(userId: number): Promise<Set<number>> {
    const token = await this.settings.getTokenForUser(userId);
    if (!token) return new Set();

    const ids = new Set<number>();
    for (let offset = 0; ; offset += READ_BOOK_PAGE_SIZE) {
      const response = await this.client.query<ReadBookIdsResponse>(userId, token, READ_BOOK_IDS_QUERY, {
        limit: READ_BOOK_PAGE_SIZE,
        offset,
      });
      const rows = response.me?.[0]?.user_books ?? [];
      for (const row of rows) {
        if (Number.isSafeInteger(row.book_id) && (row.book_id ?? 0) > 0) ids.add(row.book_id!);
      }
      if (rows.length < READ_BOOK_PAGE_SIZE) break;
    }

    this.cache.set(userId, { expiresAt: Date.now() + CACHE_TTL_MS, ids });
    return ids;
  }
}
