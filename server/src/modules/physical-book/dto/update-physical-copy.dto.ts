import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import { PHYSICAL_ACQUISITIONS, PHYSICAL_BINDINGS, type PhysicalAcquisition, type PhysicalBinding } from '@bookorbit/types';

import { IsDateKey } from './is-date-key.validator';

export class UpdatePhysicalCopyDto {
  @IsOptional()
  @IsIn(PHYSICAL_ACQUISITIONS)
  acquisition?: PhysicalAcquisition;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  pageCount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  lender?: string;

  @IsOptional()
  @IsDateKey()
  dueOn?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  renewalsUsed?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  renewalLimit?: number;

  @IsOptional()
  @IsIn(PHYSICAL_BINDINGS)
  binding?: PhysicalBinding;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  shelfLocation?: string;

  @IsOptional()
  @IsDateKey()
  acquiredOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}
