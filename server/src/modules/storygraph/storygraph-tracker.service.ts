import type { KoreaderStoreShelf } from '@bookorbit/types';
import { Injectable } from '@nestjs/common';

import { StorygraphCatalogService } from './storygraph-catalog.service';
import { StorygraphClientService } from './storygraph-client.service';
import { StorygraphSettingsService } from './storygraph-settings.service';

@Injectable()
export class StorygraphTrackerService {
  constructor(
    private readonly client: StorygraphClientService,
    private readonly settings: StorygraphSettingsService,
    private readonly catalog: StorygraphCatalogService,
  ) {}

  async getShelves(userId: number): Promise<KoreaderStoreShelf[]> {
    const cookies = await this.settings.getCookiesForUser(userId);
    if (!cookies) return [this.unavailable('storygraph-trackers', 'StoryGraph trackers', 'StoryGraph is not configured')];
    const definitions = [
      ['storygraph-to-read', 'StoryGraph To Read', '/to-read'],
      ['storygraph-currently-reading', 'StoryGraph Currently Reading', '/currently-reading'],
      ['storygraph-recent', 'Recently added on StoryGraph', '/to-read?sort=recently-added'],
    ] as const;
    const shelves: KoreaderStoreShelf[] = [];
    for (const [id, title, path] of definitions) {
      try {
        const response = await this.client.get(userId, cookies, path);
        if (response.status !== 200 || response.redirectedToSignIn) throw new Error('unavailable');
        shelves.push({
          id,
          title,
          subtitle: 'Synced from your StoryGraph tracker',
          kind: 'tracker',
          items: this.catalog.parseBooks(response.html).slice(0, 24),
          available: true,
          message: null,
        });
      } catch {
        shelves.push(this.unavailable(id, title, 'StoryGraph tracker is temporarily unavailable'));
      }
    }
    shelves.push(
      this.unavailable(
        'storygraph-challenges',
        'StoryGraph reading challenges',
        'The authenticated StoryGraph HTML surface does not expose a stable challenge-book feed',
      ),
    );
    return shelves;
  }

  private unavailable(id: string, title: string, message: string): KoreaderStoreShelf {
    return { id, title, subtitle: null, kind: 'tracker', items: [], available: false, message };
  }
}
