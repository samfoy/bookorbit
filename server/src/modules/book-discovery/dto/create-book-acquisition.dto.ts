import { BOOK_ACQUISITION_SOURCES, type BookAcquisitionSource } from '@bookorbit/types';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn, IsInt, IsOptional, IsPositive, IsString, Length, Matches, MaxLength } from 'class-validator';

export class CreateBookAcquisitionDto {
  @IsInt()
  @IsPositive()
  libraryId!: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  folderId?: number;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 500)
  title!: string;

  @Transform(({ value }) =>
    Array.isArray(value) ? value.map((author) => (typeof author === 'string' ? author.trim() : author)).filter(Boolean) : value,
  )
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  authors!: string[];

  @IsOptional()
  @IsString()
  @Matches(/^\d{9}[\dX]$/i)
  isbn10?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^\d{13}$/)
  isbn13?: string | null;

  @IsIn(BOOK_ACQUISITION_SOURCES)
  source: BookAcquisitionSource = 'auto';
}
