import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import { PHYSICAL_ACQUISITIONS, type PhysicalAcquisition } from '@bookorbit/types';

import { BorrowedRequiresLender } from './create-physical-book.dto';

@BorrowedRequiresLender()
export class BulkImportPhysicalBooksDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  libraryId!: number;

  // Bounded so one paste cannot queue an unbounded number of provider lookups.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  isbns!: string[];

  @IsIn(PHYSICAL_ACQUISITIONS)
  acquisition!: PhysicalAcquisition;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  lender?: string;
}
