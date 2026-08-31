import { EXTERNAL_CATALOG_SOURCES, type ExternalCatalogSource } from '@bookorbit/types';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn, IsString, Length } from 'class-validator';

export class SearchExternalBooksDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(2, 200)
  query!: string;

  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return [...EXTERNAL_CATALOG_SOURCES];
    const values = Array.isArray(value) ? value : String(value).split(',');
    return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(EXTERNAL_CATALOG_SOURCES.length)
  @IsIn(EXTERNAL_CATALOG_SOURCES, { each: true })
  sources: ExternalCatalogSource[] = [...EXTERNAL_CATALOG_SOURCES];
}
