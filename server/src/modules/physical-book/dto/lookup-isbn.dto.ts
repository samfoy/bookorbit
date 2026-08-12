import { IsString, MaxLength, MinLength } from 'class-validator';

export class LookupIsbnDto {
  @IsString()
  @MinLength(10)
  @MaxLength(30)
  isbn!: string;
}
