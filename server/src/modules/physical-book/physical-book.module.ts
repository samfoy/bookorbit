import { Module } from '@nestjs/common';

import { LibraryModule } from '../library/library.module';
import { MetadataFetchModule } from '../metadata-fetch/metadata-fetch.module';
import { MetadataModule } from '../metadata/metadata.module';
import { NotificationModule } from '../notification/notification.module';
import { ReadingSessionModule } from '../reading-session/reading-session.module';
import { PhysicalBookController } from './physical-book.controller';
import { PhysicalBookRepository } from './physical-book.repository';
import { PhysicalBookService } from './physical-book.service';
import { PhysicalDueSoonJob } from './physical-due-soon.job';
import { PhysicalLoanService } from './physical-loan.service';

@Module({
  imports: [LibraryModule, MetadataFetchModule, MetadataModule, NotificationModule, ReadingSessionModule],
  controllers: [PhysicalBookController],
  providers: [PhysicalBookService, PhysicalLoanService, PhysicalBookRepository, PhysicalDueSoonJob],
  exports: [PhysicalBookService, PhysicalLoanService],
})
export class PhysicalBookModule {}
