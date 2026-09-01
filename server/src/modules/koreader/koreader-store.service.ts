import type { CreateBookAcquisitionRequest, KoreaderStoreConfigResponse } from '@bookorbit/types';
import { Permission } from '@bookorbit/types';
import { BadGatewayException, ForbiddenException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { RequestUser } from '../../common/types/request-user';
import { BookAcquisitionService } from '../book-discovery/book-acquisition.service';
import { BookDiscoveryService } from '../book-discovery/book-discovery.service';
import { fetchWithSafeRedirects } from '../book-discovery/safe-remote-fetch.util';
import type { BrowseExternalBooksDto } from '../book-discovery/dto/browse-external-books.dto';
import type { BrowseHomeDto } from '../book-discovery/dto/browse-home.dto';
import type { SearchExternalBooksDto } from '../book-discovery/dto/search-external-books.dto';
import { HardcoverCatalogBrowseService } from '../hardcover/hardcover-catalog-browse.service';
import { LibraryService } from '../library/library.service';
import { KoreaderStorePhase2Service } from './koreader-store-phase2.service';
import { KoreaderStorePersonalizationService } from './koreader-store-personalization.service';

const MAX_STORE_COVER_BYTES = 4 * 1024 * 1024;
const STORE_COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

@Injectable()
export class KoreaderStoreService {
  constructor(
    private readonly discovery: BookDiscoveryService,
    private readonly catalogBrowse: HardcoverCatalogBrowseService,
    private readonly acquisitions: BookAcquisitionService,
    private readonly libraries: LibraryService,
    private readonly phase2: KoreaderStorePhase2Service,
    private readonly personalization: KoreaderStorePersonalizationService,
  ) {}

  async getHome(user: RequestUser, query: BrowseHomeDto) {
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
    const personalizedShelves = await this.personalization.getShelves(
      user,
      [trending, ...genreShelves].flatMap((section) => section.items),
    );
    return { ...home, trending, genreShelves, personalizedShelves };
  }

  async browse(user: RequestUser, query: BrowseExternalBooksDto) {
    const response = await this.catalogBrowse.browse(user.id, query);
    const items = await this.phase2.enrichResults(user, response.items);
    return { ...response, items: items.filter((book) => !query.hideRead || !book.state.alreadyRead) };
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
    const body = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      size,
    );
    if (!this.coverBytesMatchType(body, contentType)) {
      throw new BadGatewayException('Remote cover bytes did not match its image type');
    }
    reply.type(contentType).header('Cache-Control', 'private, max-age=86400').send(body);
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
