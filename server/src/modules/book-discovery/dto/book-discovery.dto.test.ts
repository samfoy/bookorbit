import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { CreateBookAcquisitionDto } from './create-book-acquisition.dto';
import { SearchExternalBooksDto } from './search-external-books.dto';

describe('book discovery DTOs', () => {
  it('trims the query and deduplicates repeated catalog sources', async () => {
    const dto = plainToInstance(SearchExternalBooksDto, {
      query: '  Piranesi  ',
      sources: 'hardcover,hardcover',
    });

    expect(await validate(dto)).toEqual([]);
    expect(dto.query).toBe('Piranesi');
    expect(dto.sources).toEqual(['hardcover']);
  });

  it('rejects ISBN values in the wrong field', async () => {
    const dto = plainToInstance(CreateBookAcquisitionDto, {
      libraryId: 3,
      title: 'Dune',
      authors: ['Frank Herbert'],
      isbn10: '9780441013593',
      isbn13: '0441013597',
      source: 'auto',
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(expect.arrayContaining(['isbn10', 'isbn13']));
  });

  it('trims acquisition title and author values', async () => {
    const dto = plainToInstance(CreateBookAcquisitionDto, {
      libraryId: 3,
      title: '  Piranesi  ',
      authors: ['  Susanna Clarke  '],
      isbn13: '9781635575637',
      source: 'auto',
    });

    expect(await validate(dto)).toEqual([]);
    expect(dto.title).toBe('Piranesi');
    expect(dto.authors).toEqual(['Susanna Clarke']);
  });
});
