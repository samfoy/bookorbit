import { DISCOVERY_BROWSE_KINDS, type DiscoveryBrowseKind } from '@bookorbit/types';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

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
}
