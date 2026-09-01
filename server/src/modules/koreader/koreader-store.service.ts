import type { CreateBookAcquisitionRequest, ExternalBookSearchResult, KoreaderStoreConfigResponse, KoreaderStoreShelf } from '@bookorbit/types';
import { Permission } from '@bookorbit/types';
import { BadGatewayException, ForbiddenException, Injectable, Logger, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import sharp from 'sharp';

import type { RequestUser } from '../../common/types/request-user';
import { BookAcquisitionService } from '../book-discovery/book-acquisition.service';
import { BookDiscoveryService } from '../book-discovery/book-discovery.service';
import { fetchWithSafeRedirects } from '../book-discovery/safe-remote-fetch.util';
import type { BrowseExternalBooksDto } from '../book-discovery/dto/browse-external-books.dto';
import type { BrowseHomeDto } from '../book-discovery/dto/browse-home.dto';
import type { SearchExternalBooksDto } from '../book-discovery/dto/search-external-books.dto';
import { HardcoverCatalogBrowseService } from '../hardcover/hardcover-catalog-browse.service';
import { HardcoverTrackerService } from '../hardcover/hardcover-tracker.service';
import { LibraryService } from '../library/library.service';
import { StorygraphTrackerService } from '../storygraph/storygraph-tracker.service';
import { KoreaderStorePhase2Service } from './koreader-store-phase2.service';
import { KoreaderStorePersonalizationService } from './koreader-store-personalization.service';

const MAX_STORE_COVER_BYTES = 4 * 1024 * 1024;
const STORE_COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const STORE_COVER_CACHE_MAX_ENTRIES = 128;
const STORE_COVER_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const STORE_COVER_MAX_INFLIGHT = 12;
const STORE_COVER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_COVER_PREWARM_LIMIT = 6;
const STORE_COVER_WIDTH = 360;

interface StoreCoverCacheEntry {
  body: Buffer;
  expiresAt: number;
}

export function applyStoreBrowseFilters(books: ExternalBookSearchResult[], query: BrowseExternalBooksDto): ExternalBookSearchResult[] {
  const filtered = books.filter((book) => {
    if (query.minYear !== undefined && (book.publishedYear === null || book.publishedYear < query.minYear)) return false;
    if (query.maxYear !== undefined && (book.publishedYear === null || book.publishedYear > query.maxYear)) return false;
    if (query.minPages !== undefined && (book.pageCount === null || book.pageCount < query.minPages)) return false;
    if (query.maxPages !== undefined && (book.pageCount === null || book.pageCount > query.maxPages)) return false;
    if (query.ebookOnly && book.hasEbook !== true) return false;
    if (query.seriesMode === 'series' && !book.seriesName) return false;
    if (query.seriesMode === 'standalone' && book.seriesName) return false;
    if (query.language && book.language?.toLowerCase() !== query.language) return false;
    return true;
  });
  const value = (book: ExternalBookSearchResult) => {
    if (query.sort === 'rating') return book.rating ?? -1;
    if (query.sort === 'popularity') return book.ratingsCount ?? -1;
    if (query.sort === 'newest') return book.publishedYear ?? -1;
    if (query.sort === 'shortest' || query.sort === 'longest') return book.pageCount ?? Number.MAX_SAFE_INTEGER;
    return 0;
  };
  if (query.sort !== 'relevance') filtered.sort((a, b) => (query.sort === 'shortest' ? value(a) - value(b) : value(b) - value(a)));
  return filtered;
}

@Injectable()
export class KoreaderStoreService {
  private readonly logger = new Logger(KoreaderStoreService.name);
  private readonly coverCache = new Map<string, StoreCoverCacheEntry>();
  private readonly coverInflight = new Map<string, Promise<Buffer>>();
  private coverCacheBytes = 0;

  constructor(
    private readonly discovery: BookDiscoveryService,
    private readonly catalogBrowse: HardcoverCatalogBrowseService,
    private readonly acquisitions: BookAcquisitionService,
    private readonly libraries: LibraryService,
    private readonly phase2: KoreaderStorePhase2Service,
    private readonly personalization: KoreaderStorePersonalizationService,
    private readonly hardcoverTrackers: HardcoverTrackerService,
    private readonly storygraphTrackers: StorygraphTrackerService,
  ) {}

  async getHome(user: RequestUser, query: BrowseHomeDto) {
    const trackerShelvesPromise = Promise.allSettled([this.hardcoverTrackers.getShelves(user.id), this.storygraphTrackers.getShelves(user.id)]);
    const home = await this.catalogBrowse.getBrowseHome(user.id, query.hideRead);
    const allItems = [home.trending, ...home.genreShelves].flatMap((section) => section.items);
    const enriched = await this.phase2.enrichResults(user, allItems);
    let offset = 0;
    const enrichSection = (section: (typeof home)['trending']) => {
      const items = enriched.slice(offset, offset + section.items.length).filter((book) => !query.hideRead || !book.state.alreadyRead);
      offset += section.items.length;
      return { ...section, items };
    };
    const trending = enrichSection(home.trending);
    const genreShelves = home.genreShelves.map(enrichSection);
    const candidates = [trending, ...genreShelves].flatMap((section) => section.items);
    const [personalizedResult] = await Promise.allSettled([this.personalization.getShelves(user, candidates)]);
    const [hardcoverResult, storygraphResult] = await trackerShelvesPromise;
    const personalizedShelves = personalizedResult.status === 'fulfilled' ? personalizedResult.value : [];
    const hardcoverShelves = hardcoverResult.status === 'fulfilled' ? hardcoverResult.value : [];
    const storygraphShelves = storygraphResult.status === 'fulfilled' ? storygraphResult.value : [];
    const rawTrackerShelves = [...hardcoverShelves, ...storygraphShelves];
    const rawTrackerItems = rawTrackerShelves.flatMap((shelf) => shelf.items);
    const enrichedTrackerItems = rawTrackerItems.length > 0 ? await this.phase2.enrichResults(user, rawTrackerItems) : [];
    let trackerOffset = 0;
    const trackerShelves: KoreaderStoreShelf[] = rawTrackerShelves.map((shelf) => {
      const items = enrichedTrackerItems.slice(trackerOffset, trackerOffset + shelf.items.length);
      trackerOffset += shelf.items.length;
      return { ...shelf, items };
    });
    const response = { ...home, trending, genreShelves, personalizedShelves: [...personalizedShelves, ...trackerShelves] };
    this.prewarmStoreCovers(response);
    return response;
  }

  async browse(user: RequestUser, query: BrowseExternalBooksDto) {
    const response = await this.catalogBrowse.browse(user.id, query);
    const items = await this.phase2.enrichResults(user, response.items);
    return {
      ...response,
      items: applyStoreBrowseFilters(
        items.filter((book) => !query.hideRead || !book.state.alreadyRead),
        query,
      ),
    };
  }

  async search(user: RequestUser, query: SearchExternalBooksDto & { hideRead?: boolean }) {
    const response = await this.discovery.search(user.id, query);
    const results = await this.phase2.enrichResults(user, response.results);
    return { ...response, results: results.filter((book) => query.hideRead === false || !book.state.alreadyRead) };
  }

  async getConfig(user: RequestUser): Promise<KoreaderStoreConfigResponse> {
    const libraries = await this.libraries.findAll(user);
    const sources = this.acquisitions.getCapabilities().map(({ source, available, label, message }) => ({ source, available, label, message }));
    return {
      canAcquire: this.hasUploadPermission(user),
      sources,
      libraries: libraries.map(({ id, name, folders }) => ({
        id,
        name,
        folders: folders.map(({ id: folderId, path }) => ({ id: folderId, path })),
      })),
    };
  }

  startAcquisition(user: RequestUser, request: CreateBookAcquisitionRequest) {
    this.assertUploadPermission(user);
    return this.acquisitions.start(user, request);
  }

  listAcquisitions(user: RequestUser) {
    this.assertUploadPermission(user);
    return this.acquisitions.listJobs(user.id);
  }

  getAcquisition(user: RequestUser, jobId: string) {
    this.assertUploadPermission(user);
    return this.acquisitions.getJob(user.id, jobId);
  }

  cancelAcquisition(user: RequestUser, jobId: string) {
    this.assertUploadPermission(user);
    return this.acquisitions.cancel(user.id, jobId);
  }

  async streamCover(url: string, reply: FastifyReply): Promise<void> {
    const body = await this.loadStoreCover(url);
    reply.type('image/jpeg').header('Cache-Control', 'private, max-age=86400').send(body);
  }

  private async loadStoreCover(url: string): Promise<Buffer> {
    const cached = this.coverCache.get(url);
    if (cached && cached.expiresAt > Date.now()) {
      this.coverCache.delete(url);
      this.coverCache.set(url, cached);
      return cached.body;
    }
    if (cached) this.deleteCoverCacheEntry(url, cached);

    const inflight = this.coverInflight.get(url);
    if (inflight) return inflight;
    if (this.coverInflight.size >= STORE_COVER_MAX_INFLIGHT) {
      throw new ServiceUnavailableException('Too many cover fetches are already in progress');
    }

    const pending = this.fetchAndResizeStoreCover(url)
      .then((body) => {
        this.cacheStoreCover(url, body);
        return body;
      })
      .finally(() => {
        this.coverInflight.delete(url);
      });
    this.coverInflight.set(url, pending);
    return pending;
  }

  private async fetchAndResizeStoreCover(url: string): Promise<Buffer> {
    const response = await fetchWithSafeRedirects(url, { headers: { accept: 'image/jpeg,image/png,image/webp' } });
    if (!response.ok) throw new BadGatewayException(`Remote cover returned HTTP ${response.status}`);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (!contentType || !STORE_COVER_TYPES.has(contentType)) {
      await response.body?.cancel();
      throw new BadGatewayException('Remote cover did not return a supported image');
    }

    const reader = response.body?.getReader();
    if (!reader) throw new BadGatewayException('Remote cover response was empty');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_STORE_COVER_BYTES) {
        await reader.cancel();
        throw new PayloadTooLargeException('Remote cover exceeds the size limit');
      }
      chunks.push(value);
    }
    if (size === 0) throw new BadGatewayException('Remote cover response was empty');
    const source = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      size,
    );
    if (!this.coverBytesMatchType(source, contentType)) {
      throw new BadGatewayException('Remote cover bytes did not match its image type');
    }
    try {
      return await sharp(source).resize({ width: STORE_COVER_WIDTH, withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
    } catch {
      throw new BadGatewayException('Remote cover could not be decoded');
    }
  }

  private cacheStoreCover(url: string, body: Buffer): void {
    if (body.byteLength > STORE_COVER_CACHE_MAX_BYTES) return;
    const existing = this.coverCache.get(url);
    if (existing) this.deleteCoverCacheEntry(url, existing);
    while (this.coverCache.size >= STORE_COVER_CACHE_MAX_ENTRIES || this.coverCacheBytes + body.byteLength > STORE_COVER_CACHE_MAX_BYTES) {
      const oldestUrl = this.coverCache.keys().next().value as string | undefined;
      if (!oldestUrl) break;
      const oldest = this.coverCache.get(oldestUrl);
      if (!oldest) break;
      this.deleteCoverCacheEntry(oldestUrl, oldest);
    }
    this.coverCache.set(url, { body, expiresAt: Date.now() + STORE_COVER_CACHE_TTL_MS });
    this.coverCacheBytes += body.byteLength;
  }

  private deleteCoverCacheEntry(url: string, entry: StoreCoverCacheEntry): void {
    if (!this.coverCache.delete(url)) return;
    this.coverCacheBytes = Math.max(0, this.coverCacheBytes - entry.body.byteLength);
  }

  private prewarmStoreCovers(home: {
    personalizedShelves: Array<{ items: ExternalBookSearchResult[]; available?: boolean }>;
    trending: { items: ExternalBookSearchResult[]; available?: boolean };
    genreShelves: Array<{ items: ExternalBookSearchResult[]; available?: boolean }>;
  }): void {
    const firstShelf = [...home.personalizedShelves, home.trending, ...home.genreShelves].find(
      (shelf) => shelf.available !== false && shelf.items.length > 0,
    );
    if (!firstShelf) return;

    const urls: string[] = [];
    const seen = new Set<string>();
    for (const item of firstShelf.items) {
      const url = item.coverUrl;
      if (typeof url !== 'string' || seen.has(url)) continue;
      try {
        if (new URL(url).protocol !== 'https:') continue;
      } catch {
        continue;
      }
      seen.add(url);
      urls.push(url);
      if (urls.length === STORE_COVER_PREWARM_LIMIT) break;
    }
    for (const url of urls) {
      void this.loadStoreCover(url).catch(() => {
        this.logger.warn('[koreader.store_cover_prewarm] [fail] - cover prewarm failed');
      });
    }
  }

  private assertUploadPermission(user: RequestUser): void {
    if (!this.hasUploadPermission(user)) {
      throw new ForbiddenException('Upload books permission is required');
    }
  }

  private hasUploadPermission(user: RequestUser): boolean {
    return user.isSuperuser || user.permissions.includes(Permission.LibraryUpload);
  }

  private coverBytesMatchType(body: Buffer, contentType: string): boolean {
    if (contentType === 'image/jpeg') return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
    if (contentType === 'image/png')
      return body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (contentType === 'image/webp')
      return body.length >= 12 && body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP';
    return false;
  }
}
