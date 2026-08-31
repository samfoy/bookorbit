import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { KOREADER_DASHBOARD_SECTION_TYPE } from '@bookorbit/types';
import type { KoreaderDashboardSectionType } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { KoreaderAuthGuard } from './koreader-auth.guard';
import { KoreaderCatalogService } from './koreader-catalog.service';
import { KoreaderStoreService } from './koreader-store.service';
import {
  KoreaderCatalogBookDetailQueryDto,
  KoreaderCatalogBooksQueryDto,
  KoreaderCatalogDashboardQueryDto,
  KoreaderCatalogDashboardSectionQueryDto,
  KoreaderCatalogManifestQueryDto,
  KoreaderCatalogSectionQueryDto,
  KoreaderCatalogSetRatingDto,
  KoreaderCatalogSetReadStatusDto,
} from './dto/koreader-catalog-query.dto';
import {
  KoreaderStoreBrowseDto,
  KoreaderStoreCoverDto,
  KoreaderStoreCreateAcquisitionDto,
  KoreaderStoreHomeDto,
  KoreaderStoreSearchDto,
} from './dto/koreader-store.dto';

@Public()
@UseGuards(KoreaderAuthGuard)
@Controller('koreader/plugin/catalog')
export class KoreaderCatalogController {
  constructor(
    private readonly catalogService: KoreaderCatalogService,
    private readonly storeService: KoreaderStoreService,
  ) {}

  @Get('root')
  @Header('Cache-Control', 'private, max-age=30')
  root() {
    return this.catalogService.getRoot();
  }

  @Get('dashboard')
  @Header('Cache-Control', 'private, max-age=30')
  dashboard(@CurrentUser() user: RequestUser, @Query() query: KoreaderCatalogDashboardQueryDto) {
    const section = query.section ? { type: query.section, ...(query.smartScopeId ? { smartScopeId: query.smartScopeId } : {}) } : undefined;
    return this.catalogService.getDashboard(user, section);
  }

  @Get('dashboard/discover')
  @Header('Cache-Control', 'no-store')
  discover(@CurrentUser() user: RequestUser) {
    return this.catalogService.getDiscover(user);
  }

  @Get('dashboard/sections/:type')
  @Header('Cache-Control', 'no-store')
  dashboardSection(
    @CurrentUser() user: RequestUser,
    @Param('type', new ParseEnumPipe(KOREADER_DASHBOARD_SECTION_TYPE)) type: KoreaderDashboardSectionType,
    @Query() query: KoreaderCatalogDashboardSectionQueryDto,
  ) {
    return this.catalogService.getDashboardSection(user, { type, ...(query.smartScopeId ? { smartScopeId: query.smartScopeId } : {}) });
  }

  @Get('sections/:section')
  @Header('Cache-Control', 'private, max-age=30')
  sections(@CurrentUser() user: RequestUser, @Param('section') section: string, @Query() query: KoreaderCatalogSectionQueryDto) {
    return this.catalogService.getSectionEntries(user, section, query);
  }

  @Get('books')
  @Header('Cache-Control', 'private, max-age=30')
  books(@CurrentUser() user: RequestUser, @Query() query: KoreaderCatalogBooksQueryDto) {
    return this.catalogService.getBooksPage(user, query);
  }

  @Get('manifest')
  @Header('Cache-Control', 'no-store')
  manifest(@CurrentUser() user: RequestUser, @Query() query: KoreaderCatalogManifestQueryDto) {
    return this.catalogService.getBulkManifest(user, query);
  }

  @Get('books/:bookId')
  @Header('Cache-Control', 'private, max-age=30')
  bookDetail(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number, @Query() query: KoreaderCatalogBookDetailQueryDto) {
    return this.catalogService.getBookDetail(user, bookId, query.deviceId);
  }

  @Put('books/:bookId/read-status')
  setReadStatus(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number, @Body() body: KoreaderCatalogSetReadStatusDto) {
    return this.catalogService.setReadStatus(user, bookId, body.status);
  }

  @Put('books/:bookId/rating')
  setRating(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number, @Body() body: KoreaderCatalogSetRatingDto) {
    return this.catalogService.setRating(user, bookId, body.rating ?? null);
  }

  @Get('books/:bookId/thumbnail')
  thumbnail(
    @CurrentUser() user: RequestUser,
    @Param('bookId', ParseIntPipe) bookId: number,
    @Res() reply: FastifyReply,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    return this.catalogService.streamThumbnail(user, bookId, reply, ifNoneMatch);
  }

  @Get('files/:fileId/download')
  download(@CurrentUser() user: RequestUser, @Param('fileId', ParseIntPipe) fileId: number, @Res() reply: FastifyReply) {
    return this.catalogService.streamFile(user, fileId, reply);
  }

  @Get('store/home')
  @Header('Cache-Control', 'no-store')
  storeHome(@CurrentUser() user: RequestUser, @Query() query: KoreaderStoreHomeDto) {
    return this.storeService.getHome(user, query);
  }

  @Get('store/browse')
  @Header('Cache-Control', 'no-store')
  storeBrowse(@CurrentUser() user: RequestUser, @Query() query: KoreaderStoreBrowseDto) {
    return this.storeService.browse(user, query);
  }

  @Get('store/search')
  @Header('Cache-Control', 'no-store')
  storeSearch(@CurrentUser() user: RequestUser, @Query() query: KoreaderStoreSearchDto) {
    return this.storeService.search(user, query);
  }

  @Get('store/config')
  @Header('Cache-Control', 'no-store')
  storeConfig(@CurrentUser() user: RequestUser) {
    return this.storeService.getConfig(user);
  }

  @Get('store/cover')
  @Header('Cache-Control', 'private, max-age=86400')
  storeCover(@Query() query: KoreaderStoreCoverDto, @Res() reply: FastifyReply) {
    return this.storeService.streamCover(query.url, reply);
  }

  @Get('store/acquisitions')
  @Header('Cache-Control', 'no-store')
  storeAcquisitions(@CurrentUser() user: RequestUser) {
    return this.storeService.listAcquisitions(user);
  }

  @Post('store/acquisitions')
  @HttpCode(HttpStatus.ACCEPTED)
  startStoreAcquisition(@CurrentUser() user: RequestUser, @Body() body: KoreaderStoreCreateAcquisitionDto) {
    return this.storeService.startAcquisition(user, body);
  }

  @Get('store/acquisitions/:jobId')
  @Header('Cache-Control', 'no-store')
  storeAcquisition(@CurrentUser() user: RequestUser, @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string) {
    return this.storeService.getAcquisition(user, jobId);
  }

  @Delete('store/acquisitions/:jobId')
  cancelStoreAcquisition(@CurrentUser() user: RequestUser, @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string) {
    return this.storeService.cancelAcquisition(user, jobId);
  }
}
