import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

export class LogProgressDto {
  @IsInt()
  @Min(0)
  @Type(() => Number)
  currentPage!: number;

  // Capped at 24h so a stuck client cannot inject an implausible session that skews daily stats.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  @Type(() => Number)
  minutes?: number;

  @IsOptional()
  @IsISO8601({ strict: true })
  startedAt?: string;
}
