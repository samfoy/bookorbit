import { Transform } from 'class-transformer';
import { IsBoolean } from 'class-validator';

export function toBoolean(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export class BrowseHomeDto {
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  hideRead = true;
}
