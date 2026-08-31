import { BrowseExternalBooksDto } from '../../book-discovery/dto/browse-external-books.dto';
import { BrowseHomeDto } from '../../book-discovery/dto/browse-home.dto';
import { toBoolean } from '../../book-discovery/dto/browse-home.dto';
import { CreateBookAcquisitionDto } from '../../book-discovery/dto/create-book-acquisition.dto';
import { SearchExternalBooksDto } from '../../book-discovery/dto/search-external-books.dto';
import { Transform } from 'class-transformer';
import { IsBoolean, IsUrl } from 'class-validator';

export class KoreaderStoreHomeDto extends BrowseHomeDto {}

export class KoreaderStoreBrowseDto extends BrowseExternalBooksDto {}

export class KoreaderStoreSearchDto extends SearchExternalBooksDto {
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  hideRead = true;
}

export class KoreaderStoreCreateAcquisitionDto extends CreateBookAcquisitionDto {}

export class KoreaderStoreCoverDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  url!: string;
}
