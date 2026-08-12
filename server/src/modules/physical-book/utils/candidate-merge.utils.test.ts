import type { MetadataCandidate } from '@bookorbit/types';

import { candidateToMetadataFields, pickBestCandidate } from './candidate-merge.utils';

function makeCandidate(overrides?: Partial<MetadataCandidate>): MetadataCandidate {
  return {
    provider: 'google_books' as MetadataCandidate['provider'],
    providerId: 'gb-1',
    ...overrides,
  };
}

describe('candidate-merge utils', () => {
  describe('pickBestCandidate', () => {
    it('returns null for an empty provider fan-out', () => {
      expect(pickBestCandidate([], '9780306406157')).toBeNull();
    });

    it('prefers an exact ISBN match over a richer but unmatched record', () => {
      const rich = makeCandidate({ providerId: 'rich', title: 'Dune Encyclopedia', authors: ['A'], pageCount: 900, description: 'x', coverUrl: 'u' });
      const exact = makeCandidate({ providerId: 'exact', title: 'Dune', isbn13: '9780306406157' });

      expect(pickBestCandidate([rich, exact], '9780306406157')?.providerId).toBe('exact');
    });

    it('falls back to completeness when no candidate carries the ISBN', () => {
      const sparse = makeCandidate({ providerId: 'sparse' });
      const complete = makeCandidate({ providerId: 'complete', title: 'Dune', authors: ['Frank Herbert'], pageCount: 412 });

      expect(pickBestCandidate([sparse, complete], '9780306406157')?.providerId).toBe('complete');
    });
  });

  describe('candidateToMetadataFields', () => {
    it('projects a candidate onto the metadata columns', () => {
      const fields = candidateToMetadataFields(
        makeCandidate({
          title: 'Dune',
          subtitle: null as unknown as undefined,
          authors: ['Frank Herbert'],
          publisher: 'Chilton',
          publishedDate: '1965-08-01',
          language: 'en',
          pageCount: 412,
          isbn10: '0306406152',
          isbn13: '9780306406157',
          seriesName: 'Dune',
          seriesIndex: 1,
        }),
        { isbn13: '9780306406157', isbn10: '0306406152' },
      );

      expect(fields).toMatchObject({
        title: 'Dune',
        publisher: 'Chilton',
        publishedDate: '1965-08-01',
        publishedYear: 1965,
        pageCount: 412,
        seriesName: 'Dune',
        seriesIndex: 1,
      });
    });

    it('drops a partial provider date rather than handing it to a date column', () => {
      const fields = candidateToMetadataFields(makeCandidate({ title: 'Dune', publishedDate: '1965' }), { isbn13: null, isbn10: null });

      expect(fields.publishedDate).toBeNull();
    });

    it('uses the user-supplied title and scanned ISBN when there is no candidate', () => {
      const fields = candidateToMetadataFields(null, { title: 'Handmade Zine', isbn13: '9780306406157', isbn10: '0306406152', pageCount: 40 });

      expect(fields).toMatchObject({
        title: 'Handmade Zine',
        isbn13: '9780306406157',
        isbn10: '0306406152',
        pageCount: 40,
        description: null,
        seriesName: null,
      });
    });
  });
});
