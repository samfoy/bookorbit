import type { ExternalBookSearchResult, KoreaderStoreShelf } from '@bookorbit/types';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HardcoverTrackerService } from '../hardcover/hardcover-tracker.service';
import { StorygraphTrackerService } from '../storygraph/storygraph-tracker.service';
import { makeRequestUser } from '../upload/test-helpers';
import { KoreaderStoreService } from './koreader-store.service';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const user = makeRequestUser({ id: 17 });

afterEach(() => {
  vi.restoreAllMocks();
});

function book(id: string): ExternalBookSearchResult {
  return {
    id,
    title: id,
    authors: [],
    coverUrl: null,
    description: null,
    publishedYear: null,
    rating: null,
    ratingsCount: null,
    isbn10: null,
    isbn13: null,
    pageCount: null,
    seriesName: null,
    seriesPosition: null,
    hasEbook: true,
    genres: [],
    sources: [],
  };
}

function shelf(id: string, items: ExternalBookSearchResult[]): KoreaderStoreShelf {
  return { id, title: id, subtitle: null, kind: 'tracker', items, available: true, message: null };
}

function makeStoreService() {
  const discovery = { search: vi.fn() };
  const browse = { getBrowseHome: vi.fn(), browse: vi.fn() };
  const acquisitions = {
    start: vi.fn(),
    listJobs: vi.fn(),
    getJob: vi.fn(),
    cancel: vi.fn(),
    getCapabilities: vi.fn(),
  };
  const libraries = { findAll: vi.fn() };
  const phase2 = {
    enrichResults: vi.fn((_requestUser, items: ExternalBookSearchResult[]) =>
      Promise.resolve(
        items.map((item) => ({
          ...item,
          state: {
            inBookOrbit: false,
            bookId: null,
            localFormats: [],
            bookOrbitStatus: null,
            progressPercentage: null,
            hardcoverStatus: null,
            storygraphStatus: null,
            alreadyRead: false,
            alreadyOwned: false,
          },
        })),
      ),
    ),
  };
  const personalization = { getShelves: vi.fn().mockResolvedValue([]) };
  const hardcoverTrackers = { getShelves: vi.fn().mockResolvedValue([]) };
  const storygraphTrackers = { getShelves: vi.fn().mockResolvedValue([]) };
  const service = new KoreaderStoreService(
    discovery as never,
    browse as never,
    acquisitions as never,
    libraries as never,
    phase2 as never,
    personalization as never,
    hardcoverTrackers as never,
    storygraphTrackers as never,
  );
  return { service, browse, phase2, personalization, hardcoverTrackers, storygraphTrackers };
}

describe('KOReader Store home performance', () => {
  it('starts independent tracker requests before the base browse resolves', async () => {
    const { service, browse, hardcoverTrackers, storygraphTrackers } = makeStoreService();
    const base = deferred<{
      generatedAt: string;
      trending: { id: string; title: string; subtitle: null; kind: 'trending'; value: null; items: ExternalBookSearchResult[] };
      genreShelves: [];
    }>();
    browse.getBrowseHome.mockReturnValue(base.promise);

    const result = service.getHome(user, { hideRead: true });
    await Promise.resolve();

    expect(hardcoverTrackers.getShelves).toHaveBeenCalledWith(17);
    expect(storygraphTrackers.getShelves).toHaveBeenCalledWith(17);

    base.resolve({
      generatedAt: 'now',
      trending: { id: 'trending', title: 'Trending', subtitle: null, kind: 'trending', value: null, items: [] },
      genreShelves: [],
    });
    await result;
  });

  it('attaches tracker rejection handling before awaiting the base browse', async () => {
    const { service, browse, hardcoverTrackers } = makeStoreService();
    const base = deferred<{
      generatedAt: string;
      trending: { id: string; title: string; subtitle: null; kind: 'trending'; value: null; items: ExternalBookSearchResult[] };
      genreShelves: [];
    }>();
    const trackerThen = vi.fn((resolve: (shelves: KoreaderStoreShelf[]) => void) => resolve([]));
    browse.getBrowseHome.mockReturnValue(base.promise);
    hardcoverTrackers.getShelves.mockReturnValue({ then: trackerThen } as never);

    const result = service.getHome(user, { hideRead: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(trackerThen).toHaveBeenCalled();

    base.resolve({
      generatedAt: 'now',
      trending: { id: 'trending', title: 'Trending', subtitle: null, kind: 'trending', value: null, items: [] },
      genreShelves: [],
    });
    await result;
  });

  it('enriches all tracker shelf items in one combined bounded call', async () => {
    const { service, browse, phase2, hardcoverTrackers, storygraphTrackers } = makeStoreService();
    const one = book('hardcover:1');
    const two = book('storygraph:2');
    browse.getBrowseHome.mockResolvedValue({
      generatedAt: 'now',
      trending: { id: 'trending', title: 'Trending', subtitle: null, kind: 'trending', value: null, items: [] },
      genreShelves: [],
    });
    hardcoverTrackers.getShelves.mockResolvedValue([shelf('hardcover', [one])]);
    storygraphTrackers.getShelves.mockResolvedValue([shelf('storygraph', [two])]);

    const result = await service.getHome(user, { hideRead: true });

    expect(phase2.enrichResults).toHaveBeenCalledTimes(2);
    expect(phase2.enrichResults).toHaveBeenLastCalledWith(user, [one, two]);
    expect(result.personalizedShelves.map((item) => item.items[0]?.id)).toEqual(['hardcover:1', 'storygraph:2']);
  });
});

describe('KOReader Store tracker concurrency', () => {
  it('starts both Hardcover tracker definitions together and preserves ordered partial shelves', async () => {
    const requests = [
      deferred<{ me: Array<{ user_books: Array<{ book_id: number }> }> }>(),
      deferred<{ me: Array<{ user_books: Array<{ book_id: number }> }> }>(),
    ];
    const client = { query: vi.fn().mockImplementation(() => requests[client.query.mock.calls.length - 1]!.promise) };
    const settings = { getTokenForUser: vi.fn().mockResolvedValue('token') };
    const browse = { getBooksByIds: vi.fn().mockResolvedValue([]) };
    const service = new HardcoverTrackerService(client as never, settings as never, browse as never);

    const result = service.getShelves(17);
    await Promise.resolve();
    await Promise.resolve();

    expect(client.query).toHaveBeenCalledTimes(2);

    requests[1]!.resolve({ me: [{ user_books: [] }] });
    requests[0]!.reject(new Error('temporary'));
    const shelves = await result;

    expect(shelves.slice(0, 2).map((item) => item.id)).toEqual(['hardcover-want-to-read', 'hardcover-currently-reading']);
    expect(shelves[0]?.available).toBe(false);
    expect(shelves[1]?.available).toBe(true);
  });

  it('starts all StoryGraph tracker definitions together and preserves ordered partial shelves', async () => {
    const requests = [
      deferred<{ status: number; redirectedToSignIn: boolean; html: string }>(),
      deferred<{ status: number; redirectedToSignIn: boolean; html: string }>(),
      deferred<{ status: number; redirectedToSignIn: boolean; html: string }>(),
    ];
    const client = { get: vi.fn().mockImplementation(() => requests[client.get.mock.calls.length - 1]!.promise) };
    const settings = { getCookiesForUser: vi.fn().mockResolvedValue({ sessionCookie: 'session', rememberToken: 'remember' }) };
    const catalog = { parseBooks: vi.fn().mockReturnValue([]) };
    const service = new StorygraphTrackerService(client as never, settings as never, catalog as never);

    const result = service.getShelves(17);
    await Promise.resolve();
    await Promise.resolve();

    expect(client.get).toHaveBeenCalledTimes(3);

    requests[2]!.resolve({ status: 200, redirectedToSignIn: false, html: '' });
    requests[1]!.reject(new Error('temporary'));
    requests[0]!.resolve({ status: 200, redirectedToSignIn: false, html: '' });
    const shelves = await result;

    expect(shelves.slice(0, 3).map((item) => item.id)).toEqual(['storygraph-to-read', 'storygraph-currently-reading', 'storygraph-recent']);
    expect(shelves.slice(0, 3).map((item) => item.available)).toEqual([true, false, true]);
  });
});

function reply() {
  return { type: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis(), send: vi.fn() };
}

async function generatedPng(width = 800, height = 1200): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 120, g: 80, b: 40 } } })
    .png()
    .toBuffer();
}

describe('KOReader Store cover performance', () => {
  it('deduplicates concurrent loads, caches later calls, and returns a bounded JPEG thumbnail', async () => {
    const { service } = makeStoreService();
    const png = await generatedPng();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } }));
    const firstReply = reply();
    const secondReply = reply();

    await Promise.all([
      service.streamCover('https://example.com/shared.png', firstReply as never),
      service.streamCover('https://example.com/shared.png', secondReply as never),
    ]);
    const thirdReply = reply();
    await service.streamCover('https://example.com/shared.png', thirdReply as never);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const output = firstReply.send.mock.calls[0]?.[0] as Buffer;
    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBeLessThanOrEqual(360);
    expect(firstReply.type).toHaveBeenCalledWith('image/jpeg');
    expect(secondReply.send).toHaveBeenCalledWith(output);
    expect(thirdReply.send).toHaveBeenCalledWith(output);
    fetchSpy.mockRestore();
  });

  it('does not cache failures and retries the next request', async () => {
    const { service } = makeStoreService();
    const png = await generatedPng(20, 30);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(new Uint8Array(Buffer.from('<html>bad</html>')), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } }));

    await expect(service.streamCover('https://example.com/retry.jpg', reply() as never)).rejects.toThrow('bytes did not match');
    await expect(service.streamCover('https://example.com/retry.jpg', reply() as never)).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  it('evicts the oldest cover after the bounded entry limit', async () => {
    const { service } = makeStoreService();
    const jpeg = await sharp({ create: { width: 2, height: 3, channels: 3, background: 'white' } })
      .jpeg()
      .toBuffer();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response(new Uint8Array(jpeg), { status: 200, headers: { 'content-type': 'image/jpeg' } })));

    for (let index = 0; index < 129; index += 1) {
      await service.streamCover(`https://example.com/${index}.jpg`, reply() as never);
    }
    const cacheState = service as unknown as { coverCache: Map<string, unknown>; coverCacheBytes: number };
    expect(cacheState.coverCache.size).toBeLessThanOrEqual(128);
    expect(cacheState.coverCacheBytes).toBeLessThanOrEqual(48 * 1024 * 1024);

    await service.streamCover('https://example.com/0.jpg', reply() as never);
    expect(fetchSpy).toHaveBeenCalledTimes(130);
    fetchSpy.mockRestore();
  });

  it('bounds unique in-flight cover loads across concurrent requests', async () => {
    const { service } = makeStoreService();
    const pending = deferred<Buffer>();
    const fetchAndResize = vi.fn().mockReturnValue(pending.promise);
    const cacheOwner = service as unknown as {
      fetchAndResizeStoreCover: typeof fetchAndResize;
      loadStoreCover: (url: string) => Promise<Buffer>;
      coverInflight: Map<string, Promise<Buffer>>;
    };
    cacheOwner.fetchAndResizeStoreCover = fetchAndResize;
    const accepted = Array.from({ length: 12 }, (_, index) => cacheOwner.loadStoreCover(`https://example.com/pending-${index}.jpg`));
    const overflow = cacheOwner.loadStoreCover('https://example.com/pending-overflow.jpg').then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.resolve();

    expect(cacheOwner.coverInflight.size).toBeLessThanOrEqual(12);
    await expect(overflow).resolves.toMatchObject({ message: 'Too many cover fetches are already in progress' });

    pending.resolve(Buffer.from('jpeg'));
    await Promise.all(accepted);
  });

  it('starts at most six unique valid covers from the first visible shelf without awaiting them', async () => {
    const { service, browse } = makeStoreService();
    const pending = deferred<Buffer>();
    const loadCover = vi.fn().mockReturnValue(pending.promise);
    (service as unknown as { loadStoreCover: typeof loadCover }).loadStoreCover = loadCover;
    const urls = [
      'https://example.com/0.jpg',
      'https://example.com/1.jpg',
      'https://example.com/1.jpg',
      'http://example.com/insecure.jpg',
      'not-a-url',
      'https://example.com/2.jpg',
      'https://example.com/3.jpg',
      'https://example.com/4.jpg',
      'https://example.com/5.jpg',
      'https://example.com/6.jpg',
    ];
    const items = urls.map((coverUrl, index) => ({ ...book(`hardcover:${index}`), coverUrl }));
    browse.getBrowseHome.mockResolvedValue({
      generatedAt: 'now',
      trending: { id: 'trending', title: 'Trending', subtitle: null, kind: 'trending', value: null, items },
      genreShelves: [],
    });

    const home = await service.getHome(user, { hideRead: true });

    expect(home.trending.items).toHaveLength(items.length);
    expect(loadCover).toHaveBeenCalledTimes(6);
    expect(loadCover.mock.calls.map((call) => call[0])).toEqual([
      'https://example.com/0.jpg',
      'https://example.com/1.jpg',
      'https://example.com/2.jpg',
      'https://example.com/3.jpg',
      'https://example.com/4.jpg',
      'https://example.com/5.jpg',
    ]);
  });
});
