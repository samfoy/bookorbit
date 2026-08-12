import { Module } from '@nestjs/common';

import { LibraryModule } from '../library/library.module';
import { MetadataFetchModule } from '../metadata-fetch/metadata-fetch.module';
import { MetadataModule } from '../metadata/metadata.module';
import { ReadingSessionModule } from '../reading-session/reading-session.module';
import { PhysicalBookController } from './physical-book.controller';
import { PhysicalBookRepository } from './physical-book.repository';
import { PhysicalBookService } from './physical-book.service';

@Module({
  imports: [LibraryModule, MetadataFetchModule, MetadataModule, ReadingSessionModule],
  controllers: [PhysicalBookController],
  providers: [PhysicalBookService, PhysicalBookRepository],
  exports: [PhysicalBookService],
})
export class PhysicalBookModule {}
