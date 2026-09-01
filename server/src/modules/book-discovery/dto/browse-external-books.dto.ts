import { DISCOVERY_BROWSE_KINDS, DISCOVERY_BROWSE_SORTS, type DiscoveryBrowseKind, type DiscoveryBrowseSort } from '@bookorbit/types';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { toBoolean } from './browse-home.dto';

export class BrowseExternalBooksDto {
  @IsIn(DISCOVERY_BROWSE_KINDS)
  kind!: DiscoveryBrowseKind;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 255)
  value?: string;

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(1000)
  page = 1;

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(6)
  @Max(40)
  pageSize = 20;

  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  hideRead = true;

  @IsIn(DISCOVERY_BROWSE_SORTS)
  sort: DiscoveryBrowseSort = 'relevance';

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  @Max(3000)
  minYear?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  @Max(3000)
  maxYear?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(10000)
  minPages?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(10000)
  maxPages?: number;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  ebookOnly?: boolean;

  @IsOptional()
  @IsIn(['series', 'standalone'])
  seriesMode?: 'series' | 'standalone';

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @Length(2, 20)
  language?: string;
}
