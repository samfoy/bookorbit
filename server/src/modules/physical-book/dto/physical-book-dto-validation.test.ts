import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { BulkImportPhysicalBooksDto, CreatePhysicalBookDto } from './index';

function errorsFor<T extends object>(cls: new () => T, payload: Record<string, unknown>): string[] {
  const instance = plainToInstance(cls, payload);
  return validateSync(instance, { whitelist: true, forbidNonWhitelisted: true }).flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('CreatePhysicalBookDto', () => {
  it('accepts an owned copy identified by ISBN alone', () => {
    expect(errorsFor(CreatePhysicalBookDto, { libraryId: 1, isbn: '9780306406157', acquisition: 'owned' })).toEqual([]);
  });

  it('accepts a title-only copy for a book with no barcode', () => {
    expect(errorsFor(CreatePhysicalBookDto, { libraryId: 1, title: 'Handmade Chapbook', acquisition: 'owned' })).toEqual([]);
  });

  it('requires at least one of isbn or title', () => {
    expect(errorsFor(CreatePhysicalBookDto, { libraryId: 1, acquisition: 'owned' })).toContain('At least one of isbn or title must be provided');
  });

  // Guards bpc_due_requires_lender_chk so the DB check never surfaces as a 500.
  it('requires a lender for a borrowed copy', () => {
    expect(errorsFor(CreatePhysicalBookDto, { libraryId: 1, isbn: '9780306406157', acquisition: 'borrowed_library' })).toContain(
      'lender is required when acquisition is not owned',
    );
  });

  it('accepts a borrowed copy that names its lender', () => {
    expect(
      errorsFor(CreatePhysicalBookDto, {
        libraryId: 1,
        isbn: '9780306406157',
        acquisition: 'borrowed_library',
        lender: 'County Library',
        dueOn: '2026-09-01',
      }),
    ).toEqual([]);
  });

  it('rejects a due date that is not a calendar day key', () => {
    const errors = errorsFor(CreatePhysicalBookDto, {
      libraryId: 1,
      isbn: '9780306406157',
      acquisition: 'borrowed_library',
      lender: 'County Library',
      dueOn: '2026-09-01T17:00:00Z',
    });
    expect(errors).toContain('must be a calendar date in YYYY-MM-DD form');
  });

  it('rejects an impossible calendar day', () => {
    expect(errorsFor(CreatePhysicalBookDto, { libraryId: 1, title: 'X', acquisition: 'owned', acquiredOn: '2026-02-30' })).toContain(
      'must be a calendar date in YYYY-MM-DD form',
    );
  });

  it('rejects an unknown acquisition value', () => {
    expect(errorsFor(CreatePhysicalBookDto, { libraryId: 1, title: 'X', acquisition: 'stolen' }).join(' ')).toContain('acquisition');
  });
});

describe('BulkImportPhysicalBooksDto', () => {
  it('accepts a bounded list of ISBNs', () => {
    expect(errorsFor(BulkImportPhysicalBooksDto, { libraryId: 1, isbns: ['9780306406157'], acquisition: 'owned' })).toEqual([]);
  });

  it('rejects an empty list', () => {
    expect(errorsFor(BulkImportPhysicalBooksDto, { libraryId: 1, isbns: [], acquisition: 'owned' }).join(' ')).toContain('isbns');
  });

  it('rejects a paste larger than the per-request ceiling', () => {
    const isbns = Array.from({ length: 201 }, () => '9780306406157');
    expect(errorsFor(BulkImportPhysicalBooksDto, { libraryId: 1, isbns, acquisition: 'owned' }).join(' ')).toContain('isbns');
  });

  it('requires a lender for a borrowed batch', () => {
    expect(errorsFor(BulkImportPhysicalBooksDto, { libraryId: 1, isbns: ['9780306406157'], acquisition: 'borrowed_personal' })).toContain(
      'lender is required when acquisition is not owned',
    );
  });
});
