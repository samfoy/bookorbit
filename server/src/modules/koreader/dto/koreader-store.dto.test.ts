import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { KoreaderStoreBrowseDto, KoreaderStoreCreateAcquisitionDto, KoreaderStoreHomeDto, KoreaderStoreSearchDto } from './koreader-store.dto';

describe('KOReader store DTOs', () => {
  it('defaults hideRead and transforms bounded browse pagination', async () => {
    const home = plainToInstance(KoreaderStoreHomeDto, {});
    const browse = plainToInstance(KoreaderStoreBrowseDto, {
      kind: 'genre',
      value: ' fantasy ',
      page: '2',
      pageSize: '24',
      hideRead: 'false',
    });

    expect(await validate(home)).toEqual([]);
    expect(await validate(browse)).toEqual([]);
    expect(home.hideRead).toBe(true);
    expect(browse).toMatchObject({ kind: 'genre', value: 'fantasy', page: 2, pageSize: 24, hideRead: false });
  });

  it('normalizes source lists and rejects unsupported sources', async () => {
    const valid = plainToInstance(KoreaderStoreSearchDto, {
      query: '  Piranesi  ',
      sources: 'hardcover,hardcover,storygraph',
    });
    const invalid = plainToInstance(KoreaderStoreSearchDto, { query: 'Piranesi', sources: 'hardcover,other' });

    expect(await validate(valid)).toEqual([]);
    expect(valid).toMatchObject({ query: 'Piranesi', sources: ['hardcover', 'storygraph'] });
    expect((await validate(invalid)).map((error) => error.property)).toContain('sources');
  });

  it('rejects invalid browse values and acquisition identifiers', async () => {
    const browse = plainToInstance(KoreaderStoreBrowseDto, { kind: 'unknown', page: '0', pageSize: '100' });
    const acquisition = plainToInstance(KoreaderStoreCreateAcquisitionDto, {
      libraryId: 0,
      folderId: -1,
      title: 'Dune',
      authors: ['Frank Herbert'],
      isbn10: '9780441013593',
      isbn13: '0441013597',
      source: 'other',
    });

    expect((await validate(browse)).map((error) => error.property)).toEqual(expect.arrayContaining(['kind', 'page', 'pageSize']));
    expect((await validate(acquisition)).map((error) => error.property)).toEqual(
      expect.arrayContaining(['libraryId', 'folderId', 'isbn10', 'isbn13', 'source']),
    );
  });
});
