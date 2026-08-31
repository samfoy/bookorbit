import { BrowseExternalBooksDto } from '../../book-discovery/dto/browse-external-books.dto';
import { BrowseHomeDto } from '../../book-discovery/dto/browse-home.dto';
import { CreateBookAcquisitionDto } from '../../book-discovery/dto/create-book-acquisition.dto';
import { SearchExternalBooksDto } from '../../book-discovery/dto/search-external-books.dto';
import { IsUrl } from 'class-validator';

export class KoreaderStoreHomeDto extends BrowseHomeDto {}

export class KoreaderStoreBrowseDto extends BrowseExternalBooksDto {}

export class KoreaderStoreSearchDto extends SearchExternalBooksDto {}

export class KoreaderStoreCreateAcquisitionDto extends CreateBookAcquisitionDto {}

export class KoreaderStoreCoverDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  url!: string;
}
