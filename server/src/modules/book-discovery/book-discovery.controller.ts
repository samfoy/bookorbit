import { Permission } from '@bookorbit/types';
import { Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Body } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { BookAcquisitionService } from './book-acquisition.service';
import { BookDiscoveryService } from './book-discovery.service';
import { CreateBookAcquisitionDto } from './dto/create-book-acquisition.dto';
import { SearchExternalBooksDto } from './dto/search-external-books.dto';

@Controller('discovery')
export class BookDiscoveryController {
  constructor(
    private readonly discovery: BookDiscoveryService,
    private readonly acquisitions: BookAcquisitionService,
  ) {}

  @Get('search')
  search(@Query() dto: SearchExternalBooksDto, @CurrentUser() user: RequestUser) {
    return this.discovery.search(user.id, dto);
  }

  @Get('acquisition-sources')
  @RequirePermission(Permission.LibraryUpload)
  getAcquisitionSources() {
    return this.acquisitions.getCapabilities();
  }

  @Post('acquisitions')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission(Permission.LibraryUpload)
  startAcquisition(@Body() dto: CreateBookAcquisitionDto, @CurrentUser() user: RequestUser) {
    return this.acquisitions.start(user, dto);
  }

  @Get('acquisitions')
  @RequirePermission(Permission.LibraryUpload)
  listAcquisitions(@CurrentUser() user: RequestUser) {
    return this.acquisitions.listJobs(user.id);
  }

  @Get('acquisitions/:jobId')
  @RequirePermission(Permission.LibraryUpload)
  getAcquisition(@Param('jobId', ParseUUIDPipe) jobId: string, @CurrentUser() user: RequestUser) {
    return this.acquisitions.getJob(user.id, jobId);
  }

  @Delete('acquisitions/:jobId')
  @RequirePermission(Permission.LibraryUpload)
  cancelAcquisition(@Param('jobId', ParseUUIDPipe) jobId: string, @CurrentUser() user: RequestUser) {
    return this.acquisitions.cancel(user.id, jobId);
  }
}
