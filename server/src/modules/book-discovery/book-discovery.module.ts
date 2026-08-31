import { Module } from '@nestjs/common';

import { AppSettingsModule } from '../app-settings/app-settings.module';
import { HardcoverModule } from '../hardcover/hardcover.module';
import { LibraryModule } from '../library/library.module';
import { StorygraphModule } from '../storygraph/storygraph.module';
import { UploadModule } from '../upload/upload.module';
import { AnnasArchiveService } from './annas-archive.service';
import { BookAcquisitionService } from './book-acquisition.service';
import { BookDiscoveryController } from './book-discovery.controller';
import { BookDiscoveryService } from './book-discovery.service';
import { EpubAcquisitionDownloaderService } from './epub-acquisition-downloader.service';
import { LibgenService } from './libgen.service';
import { X3EpubOptimizerService } from './x3-epub-optimizer.service';

@Module({
  imports: [AppSettingsModule, HardcoverModule, LibraryModule, StorygraphModule, UploadModule],
  controllers: [BookDiscoveryController],
  providers: [
    BookDiscoveryService,
    LibgenService,
    AnnasArchiveService,
    EpubAcquisitionDownloaderService,
    X3EpubOptimizerService,
    BookAcquisitionService,
  ],
})
export class BookDiscoveryModule {}
