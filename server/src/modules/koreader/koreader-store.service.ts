import type { CreateBookAcquisitionRequest, KoreaderStoreConfigResponse } from '@bookorbit/types';
import { Permission } from '@bookorbit/types';
import { ForbiddenException, Injectable } from '@nestjs/common';

import type { RequestUser } from '../../common/types/request-user';
import { BookAcquisitionService } from '../book-discovery/book-acquisition.service';
import { BookDiscoveryService } from '../book-discovery/book-discovery.service';
import type { BrowseExternalBooksDto } from '../book-discovery/dto/browse-external-books.dto';
import type { BrowseHomeDto } from '../book-discovery/dto/browse-home.dto';
import type { SearchExternalBooksDto } from '../book-discovery/dto/search-external-books.dto';
import { HardcoverCatalogBrowseService } from '../hardcover/hardcover-catalog-browse.service';
import { LibraryService } from '../library/library.service';

@Injectable()
export class KoreaderStoreService {
  constructor(
    private readonly discovery: BookDiscoveryService,
    private readonly catalogBrowse: HardcoverCatalogBrowseService,
    private readonly acquisitions: BookAcquisitionService,
    private readonly libraries: LibraryService,
  ) {}

  getHome(user: RequestUser, query: BrowseHomeDto) {
    return this.catalogBrowse.getBrowseHome(user.id, query.hideRead);
  }

  browse(user: RequestUser, query: BrowseExternalBooksDto) {
    return this.catalogBrowse.browse(user.id, query);
  }

  search(user: RequestUser, query: SearchExternalBooksDto) {
    return this.discovery.search(user.id, query);
  }

  async getConfig(user: RequestUser): Promise<KoreaderStoreConfigResponse> {
    const libraries = await this.libraries.findAll(user);
    const sources = this.acquisitions.getCapabilities().map(({ source, available, label, message }) => ({ source, available, label, message }));
    return {
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

  private assertUploadPermission(user: RequestUser): void {
    if (!user.isSuperuser && !user.permissions.includes(Permission.LibraryUpload)) {
      throw new ForbiddenException('Upload books permission is required');
    }
  }
}
