import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import type { MetadataCandidate, PhysicalCopySummary } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { BulkImportPhysicalBooksDto, CreatePhysicalBookDto, LogProgressDto, LookupIsbnDto, UpdatePhysicalCopyDto } from './dto';
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

  @Get(':bookId')
  getCopy(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser): Promise<PhysicalCopySummary> {
    return this.physicalBookService.getCopy(bookId, user);
  }

  @Patch(':bookId/progress')
  logProgress(
    @Param('bookId', ParseIntPipe) bookId: number,
    @Body() dto: LogProgressDto,
    @CurrentUser() user: RequestUser,
  ): Promise<PhysicalCopySummary> {
    return this.physicalBookService.logProgress(bookId, dto, user);
  }

  @Patch(':bookId')
  updateCopy(
    @Param('bookId', ParseIntPipe) bookId: number,
    @Body() dto: UpdatePhysicalCopyDto,
    @CurrentUser() user: RequestUser,
  ): Promise<PhysicalCopySummary> {
    return this.physicalBookService.updateCopy(bookId, dto, user);
  }

  @Post(':bookId/return')
  returnCopy(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser): Promise<PhysicalCopySummary> {
    return this.physicalBookService.returnCopy(bookId, user);
  }

  @Delete(':bookId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCopy(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser): Promise<void> {
    await this.physicalBookService.deleteCopy(bookId, user);
  }
}
