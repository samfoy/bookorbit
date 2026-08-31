import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { AppSettingsModule } from '../app-settings/app-settings.module';
import { HardcoverModule } from '../hardcover/hardcover.module';
import { LibraryModule } from '../library/library.module';
import { StorygraphModule } from '../storygraph/storygraph.module';
import { UploadModule } from '../upload/upload.module';
import { AnnasArchiveService } from './annas-archive.service';
import { BookAcquisitionService } from './book-acquisition.service';
import { BookDiscoveryController } from './book-discovery.controller';
import { BookDiscoveryModule } from './book-discovery.module';
import { BookDiscoveryService } from './book-discovery.service';
import { EpubAcquisitionDownloaderService } from './epub-acquisition-downloader.service';
import { LibgenService } from './libgen.service';
import { X3EpubOptimizerService } from './x3-epub-optimizer.service';

describe('BookDiscoveryModule', () => {
  it('wires existing credential, library, and upload owners into discovery', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, BookDiscoveryModule)).toEqual([
      AppSettingsModule,
      HardcoverModule,
      LibraryModule,
      StorygraphModule,
      UploadModule,
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, BookDiscoveryModule)).toEqual([BookDiscoveryController]);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, BookDiscoveryModule)).toEqual([
      BookDiscoveryService,
      LibgenService,
      AnnasArchiveService,
      EpubAcquisitionDownloaderService,
      X3EpubOptimizerService,
      BookAcquisitionService,
    ]);
  });
});
