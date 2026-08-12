import type { MetadataCandidate } from '@bookorbit/types';

import { parsePublishedDateKey, parsePublishedYear } from '../../../common/utils/published-date.utils';
import type { PhysicalBookMetadataFields } from '../physical-book.repository';

const EMPTY_FIELDS: PhysicalBookMetadataFields = {
  title: null,
  subtitle: null,
  description: null,
  isbn10: null,
  isbn13: null,
  publisher: null,
  publishedDate: null,
  publishedYear: null,
  language: null,
  pageCount: null,
  seriesName: null,
  seriesIndex: null,
};

/**
 * Ranks candidates so the one that actually matched the scanned barcode wins. An ISBN search
 * fans out across every provider and some return a loose title match with no identifier at all,
 * so an exact isbn13 hit must outrank a merely-populated record.
 */
export function pickBestCandidate(candidates: readonly MetadataCandidate[], isbn13: string | null): MetadataCandidate | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) => (scoreCandidate(candidate, isbn13) > scoreCandidate(best, isbn13) ? candidate : best));
}

function scoreCandidate(candidate: MetadataCandidate, isbn13: string | null): number {
  let score = 0;
  if (isbn13 && candidate.isbn13 === isbn13) score += 100;
  if (candidate.title) score += 10;
  if (candidate.authors?.length) score += 5;
  if (candidate.pageCount) score += 3;
  if (candidate.coverUrl) score += 2;
  if (candidate.description) score += 1;
  return score;
}

/**
 * Projects a candidate onto the book_metadata columns. Falls back to the user-supplied title and
 * the scanned ISBN so a book with no provider hit is still identifiable in the library.
 */
export function candidateToMetadataFields(
  candidate: MetadataCandidate | null,
  fallback: { title?: string; isbn13: string | null; isbn10: string | null; pageCount?: number },
): PhysicalBookMetadataFields {
  // published_date is a date column, so a provider's year-only or partial string must be
  // normalized away rather than handed to the insert.
  const publishedDate = parsePublishedDateKey(candidate?.publishedDate) ?? null;
  const publishedYear =
    parsePublishedYear(candidate?.publishedYear) ?? (publishedDate ? parsePublishedYear(Number(publishedDate.slice(0, 4))) : undefined) ?? null;

  return {
    ...EMPTY_FIELDS,
    title: candidate?.title ?? fallback.title ?? null,
    subtitle: candidate?.subtitle ?? null,
    description: candidate?.description ?? null,
    isbn10: candidate?.isbn10 ?? fallback.isbn10,
    isbn13: candidate?.isbn13 ?? fallback.isbn13,
    publisher: candidate?.publisher ?? null,
    publishedDate,
    publishedYear,
    language: candidate?.language ?? null,
    pageCount: candidate?.pageCount ?? fallback.pageCount ?? null,
    seriesName: candidate?.seriesName ?? null,
    seriesIndex: candidate?.seriesIndex ?? null,
  };
}
