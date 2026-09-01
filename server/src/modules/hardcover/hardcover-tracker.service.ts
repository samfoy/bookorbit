import type { KoreaderStoreShelf } from '@bookorbit/types';
import { Injectable } from '@nestjs/common';

import { HARDCOVER_STATUS } from './hardcover.constants';
import { HardcoverCatalogBrowseService } from './hardcover-catalog-browse.service';
import { HardcoverClientService } from './hardcover-client.service';
import { HardcoverSettingsService } from './hardcover-settings.service';

const TRACKER_LIMIT = 24;
const TRACKER_QUERY = `
query StoreTracker($statusId: Int!, $limit: Int!) {
  me { user_books(where: { status_id: { _eq: $statusId } }, order_by: { updated_at: desc }, limit: $limit) { book_id } }
}`;

interface TrackerResponse {
  me?: Array<{ user_books?: Array<{ book_id?: number | null }> }>;
}

@Injectable()
export class HardcoverTrackerService {
  constructor(
    private readonly client: HardcoverClientService,
    private readonly settings: HardcoverSettingsService,
    private readonly browse: HardcoverCatalogBrowseService,
  ) {}

  async getShelves(userId: number): Promise<KoreaderStoreShelf[]> {
    const token = await this.settings.getTokenForUser(userId);
    if (!token) return [this.unavailable('hardcover-trackers', 'Hardcover trackers', 'Hardcover is not configured')];
    const definitions = [
      ['hardcover-want-to-read', 'Hardcover Want to Read', HARDCOVER_STATUS.WANT_TO_READ],
      ['hardcover-currently-reading', 'Hardcover Currently Reading', HARDCOVER_STATUS.CURRENTLY_READING],
    ] as const;
    const shelves: KoreaderStoreShelf[] = [];
    for (const [id, title, statusId] of definitions) {
      try {
        const response = await this.client.query<TrackerResponse>(userId, token, TRACKER_QUERY, { statusId, limit: TRACKER_LIMIT });
        const ids = (response.me?.[0]?.user_books ?? []).flatMap((row) =>
          Number.isSafeInteger(row.book_id) && (row.book_id ?? 0) > 0 ? [row.book_id!] : [],
        );
        const items = await this.browse.getBooksByIds(userId, ids);
        shelves.push({ id, title, subtitle: 'Synced from your Hardcover tracker', kind: 'tracker', items, available: true, message: null });
      } catch {
        shelves.push(this.unavailable(id, title, 'Hardcover tracker is temporarily unavailable'));
      }
    }
    shelves.push(
      this.unavailable(
        'hardcover-custom-lists',
        'Hardcover custom lists',
        'The current Hardcover API token surface does not expose custom list books',
      ),
    );
    return shelves;
  }

  private unavailable(id: string, title: string, message: string): KoreaderStoreShelf {
    return { id, title, subtitle: null, kind: 'tracker', items: [], available: false, message };
  }
}
