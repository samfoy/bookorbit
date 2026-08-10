import { Transform, Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, Matches } from 'class-validator';

export class UserDailyReadingDetailQueryDto {
  @IsOptional()
  @Transform(({ value }) => (Array.isArray(value) ? value : value != null ? [value] : []))
  @Type(() => Number)
  @IsArray()
  @IsInt({ each: true })
  libraryIds?: number[];

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  day!: string;
}
