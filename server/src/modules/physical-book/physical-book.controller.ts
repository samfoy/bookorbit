import { Body, Controller, Post } from '@nestjs/common';
import type { MetadataCandidate } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { BulkImportPhysicalBooksDto, CreatePhysicalBookDto, LookupIsbnDto } from './dto';
import { BulkImportResult, CreatePhysicalBookResult, PhysicalBookService } from './physical-book.service';

@Controller('physical-books')
export class PhysicalBookController {
  constructor(private readonly physicalBookService: PhysicalBookService) {}

  @Post('lookup')
  lookup(@Body() dto: LookupIsbnDto, @CurrentUser() user: RequestUser): Promise<MetadataCandidate | null> {
    return this.physicalBookService.lookupIsbn(dto.isbn, user);
  }

  @Post()
  create(@Body() dto: CreatePhysicalBookDto, @CurrentUser() user: RequestUser): Promise<CreatePhysicalBookResult> {
    return this.physicalBookService.createPhysicalBook(dto, user);
  }

  @Post('bulk')
  bulkImport(@Body() dto: BulkImportPhysicalBooksDto, @CurrentUser() user: RequestUser): Promise<BulkImportResult> {
    return this.physicalBookService.bulkImport(dto, user);
  }
}
