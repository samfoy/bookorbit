import { Injectable, Logger } from '@nestjs/common';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { BookSyncData } from './hardcover.repository';
import { HardcoverClientService } from './hardcover-client.service';
import { HardcoverRepository } from './hardcover.repository';

export interface HardcoverBookMatch {
  hardcoverBookId: number;
  hardcoverEditionId: number | null;
  editionPages: number | null;
  matchMethod: 'isbn' | 'title' | 'cached' | 'metadata_id';
}

const FIND_BOOK_BY_ISBN13_QUERY = `
query FindBookByISBN13($isbn: String!) {
  books(where: { editions: { isbn_13: { _eq: $isbn } } }, limit: 1) {
    id
    editions(where: { isbn_13: { _eq: $isbn } }, limit: 1) {
      id
      pages
    }
  }
}`;

const FIND_BOOK_BY_ISBN10_QUERY = `
query FindBookByISBN10($isbn: String!) {
  books(where: { editions: { isbn_10: { _eq: $isbn } } }, limit: 1) {
    id
    editions(where: { isbn_10: { _eq: $isbn } }, limit: 1) {
      id
      pages
    }
  }
}`;

const SEARCH_BOOKS_QUERY = `
query SearchBooks($query: String!) {
  search(
    query: $query
    query_type: "Book"
    per_page: 5
    page: 1
    fields: "title,author_names,alternative_titles"
    weights: "5,2,1"
  ) {
    ids
  }
}`;

const EDITION_SELECTION_LIMIT = 50;
const EDITION_FIELDS = `
      id
      pages
      isbn_10
      isbn_13
      audio_seconds
      language_id`;

/**
 * Popular books can have far more editions than EDITION_SELECTION_LIMIT (Guards! Guards! has 77).
 * Without an explicit order the truncated slice is arbitrary, so the widely-read English edition
 * can be missing from the candidate set entirely. Order by reader count so the editions most
 * likely to be the one on the shelf survive truncation.
 */
const EDITION_ORDER_BY = `order_by: { users_count: desc }`;
const EDITION_SELECTION = `editions(limit: ${EDITION_SELECTION_LIMIT}, ${EDITION_ORDER_BY})`;

/** Hardcover's languages.id for English. */
const HARDCOVER_ENGLISH_LANGUAGE_ID = 1;

const FIND_BOOKS_BY_IDS_QUERY = `
query FindBooksByIds($ids: [Int!]!) {
  books(where: { id: { _in: $ids } }, limit: 5) {
    id
    ${EDITION_SELECTION} {${EDITION_FIELDS}
    }
  }
}`;

const FIND_BOOK_BY_HARDCOVER_ID_QUERY = `
query FindBookById($id: Int!) {
  books(where: { id: { _eq: $id } }, limit: 1) {
    id
    ${EDITION_SELECTION} {${EDITION_FIELDS}
    }
  }
}`;

const FIND_BOOK_BY_HARDCOVER_SLUG_QUERY = `
query FindBookBySlug($slug: String!) {
  books(where: { slug: { _eq: $slug } }, limit: 1) {
    id
    ${EDITION_SELECTION} {${EDITION_FIELDS}
    }
  }
}`;

const FIND_BOOK_EDITIONS_BY_HARDCOVER_ID_QUERY = `
query FindBookEditionsById($id: Int!) {
  books(where: { id: { _eq: $id } }, limit: 1) {
    id
    ${EDITION_SELECTION} {${EDITION_FIELDS}
    }
  }
}`;

const AUDIO_FORMATS = new Set(['m4b', 'm4a', 'mp3', 'aax', 'aacx', 'aac', 'flac', 'ogg', 'opus', 'wma', 'mka']);

interface HardcoverEdition {
  id: number;
  pages?: number | null;
  isbn_10?: string | null;
  isbn_13?: string | null;
  audio_seconds?: number | null;
  language_id?: number | null;
}

interface BooksQueryResult {
  books: Array<{
    id: number;
    editions?: HardcoverEdition[];
  }>;
}

interface SearchBooksResult {
  search?: {
    ids?: number[];
  } | null;
}

@Injectable()
export class HardcoverBookMatchService {
  private readonly logger = new Logger(HardcoverBookMatchService.name);

  constructor(
    private readonly repo: HardcoverRepository,
    private readonly client: HardcoverClientService,
  ) {}

  async matchBook(userId: number, token: string, book: BookSyncData): Promise<HardcoverBookMatch | null> {
    const cached = await this.repo.findBookState(userId, book.bookId);
    if (cached?.hardcoverBookId && !cached.matchError) {
      const cachedMatch = await this.resolveCachedMatch(userId, token, book, cached.hardcoverBookId, cached.hardcoverEditionId ?? null);

      if ((cached.hardcoverEditionId ?? null) !== cachedMatch.hardcoverEditionId) {
        await this.repo.upsertBookState({
          userId,
          bookId: book.bookId,
          hardcoverBookId: cached.hardcoverBookId,
          hardcoverEditionId: cachedMatch.hardcoverEditionId,
          matchMethod: 'cached',
          matchError: null,
        });
      }

      return {
        hardcoverBookId: cached.hardcoverBookId,
        hardcoverEditionId: cachedMatch.hardcoverEditionId,
        editionPages: cachedMatch.editionPages,
        matchMethod: 'cached',
      };
    }

    let match: HardcoverBookMatch | null = null;

    if (book.hardcoverMetadataId) {
      const id = parseInt(book.hardcoverMetadataId, 10);
      if (!isNaN(id)) {
        match = await this.matchByHardcoverId(userId, token, id, book);
      } else {
        match = await this.matchByHardcoverSlug(userId, token, book.hardcoverMetadataId, book);
      }
    }

    if (!match && book.isbn13) {
      match = await this.matchByIsbn(userId, token, book.isbn13, book.bookId, 13);
    }

    if (!match && book.isbn10) {
      match = await this.matchByIsbn(userId, token, book.isbn10, book.bookId, 10);
    }

    if (!match && book.title && book.authorName) {
      match = await this.matchByTitleAuthor(userId, token, book.title, book.authorName, book);
    }

    if (match) {
      await this.repo.upsertBookState({
        userId,
        bookId: book.bookId,
        hardcoverBookId: match.hardcoverBookId,
        hardcoverEditionId: match.hardcoverEditionId ?? null,
        matchMethod: match.matchMethod,
        matchError: null,
      });
    } else {
      await this.repo.upsertBookState({
        userId,
        bookId: book.bookId,
        hardcoverBookId: null,
        matchError: 'no_match',
      });
    }

    return match;
  }

  private async matchByHardcoverId(userId: number, token: string, id: number, book: BookSyncData): Promise<HardcoverBookMatch | null> {
    try {
      const data = await this.client.query<BooksQueryResult>(userId, token, FIND_BOOK_BY_HARDCOVER_ID_QUERY, { id });
      const hardcoverBook = data.books?.[0];
      if (!hardcoverBook) return null;
      const edition = this.pickBestEdition(hardcoverBook.editions ?? [], book);
      return {
        hardcoverBookId: hardcoverBook.id,
        hardcoverEditionId: edition?.id ?? null,
        editionPages: this.normalizeEditionPages(edition?.pages),
        matchMethod: 'metadata_id',
      };
    } catch (err) {
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(
        `[hardcover.book_match] [fail] userId=${userId} bookId=${book.bookId} method=metadata_id error="${error}" - metadata_id lookup failed`,
      );
      return null;
    }
  }

  private async matchByHardcoverSlug(userId: number, token: string, slug: string, book: BookSyncData): Promise<HardcoverBookMatch | null> {
    try {
      const data = await this.client.query<BooksQueryResult>(userId, token, FIND_BOOK_BY_HARDCOVER_SLUG_QUERY, { slug });
      const hardcoverBook = data.books?.[0];
      if (!hardcoverBook) return null;
      const edition = this.pickBestEdition(hardcoverBook.editions ?? [], book);
      return {
        hardcoverBookId: hardcoverBook.id,
        hardcoverEditionId: edition?.id ?? null,
        editionPages: this.normalizeEditionPages(edition?.pages),
        matchMethod: 'metadata_id',
      };
    } catch (err) {
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(
        `[hardcover.book_match] [fail] userId=${userId} bookId=${book.bookId} method=metadata_slug error="${error}" - metadata_slug lookup failed`,
      );
      return null;
    }
  }

  private async matchByIsbn(userId: number, token: string, isbn: string, bookId: number, version: 10 | 13): Promise<HardcoverBookMatch | null> {
    const query = version === 13 ? FIND_BOOK_BY_ISBN13_QUERY : FIND_BOOK_BY_ISBN10_QUERY;
    try {
      const data = await this.client.query<BooksQueryResult>(userId, token, query, { isbn });
      const hardcoverBook = data.books?.[0];
      if (!hardcoverBook) return null;
      const edition = hardcoverBook.editions?.[0];
      return {
        hardcoverBookId: hardcoverBook.id,
        hardcoverEditionId: edition?.id ?? null,
        editionPages: this.normalizeEditionPages(edition?.pages),
        matchMethod: 'isbn',
      };
    } catch (err) {
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(`[hardcover.book_match] [fail] userId=${userId} bookId=${bookId} method=isbn${version} error="${error}" - ISBN lookup failed`);
      return null;
    }
  }

  private async matchByTitleAuthor(
    userId: number,
    token: string,
    title: string,
    author: string,
    book: BookSyncData,
  ): Promise<HardcoverBookMatch | null> {
    try {
      const searchData = await this.client.query<SearchBooksResult>(userId, token, SEARCH_BOOKS_QUERY, {
        query: `${title} ${author}`,
      });
      const ids = searchData.search?.ids?.filter((id) => Number.isInteger(id)).slice(0, 5) ?? [];
      if (ids.length === 0) return null;

      const data = await this.client.query<BooksQueryResult>(userId, token, FIND_BOOKS_BY_IDS_QUERY, { ids });
      const booksById = new Map((data.books ?? []).map((candidate) => [candidate.id, candidate]));
      const hardcoverBook = ids.map((id) => booksById.get(id)).find((candidate): candidate is BooksQueryResult['books'][number] => candidate != null);
      if (!hardcoverBook) return null;
      const edition = this.pickBestEdition(hardcoverBook.editions ?? [], book);
      return {
        hardcoverBookId: hardcoverBook.id,
        hardcoverEditionId: edition?.id ?? null,
        editionPages: this.normalizeEditionPages(edition?.pages),
        matchMethod: 'title',
      };
    } catch (err) {
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(
        `[hardcover.book_match] [fail] userId=${userId} bookId=${book.bookId} method=title_author error="${error}" - title lookup failed`,
      );
      return null;
    }
  }

  private async resolveCachedMatch(
    userId: number,
    token: string,
    book: BookSyncData,
    hardcoverBookId: number,
    cachedEditionId: number | null,
  ): Promise<{ hardcoverEditionId: number | null; editionPages: number | null }> {
    try {
      const data = await this.client.query<BooksQueryResult>(userId, token, FIND_BOOK_EDITIONS_BY_HARDCOVER_ID_QUERY, {
        id: hardcoverBookId,
      });
      const hardcoverBook = data.books?.[0];
      if (!hardcoverBook) {
        return { hardcoverEditionId: cachedEditionId, editionPages: null };
      }

      const editions = hardcoverBook.editions ?? [];

      // A missing page count is not a reason to silently re-point the user's edition.
      if (cachedEditionId != null) {
        const cachedEdition = editions.find((edition) => edition.id === cachedEditionId);
        if (cachedEdition) {
          return { hardcoverEditionId: cachedEditionId, editionPages: this.normalizeEditionPages(cachedEdition.pages) };
        }
      }

      const edition = this.pickBestEdition(editions, book);
      if (!edition) {
        return { hardcoverEditionId: cachedEditionId, editionPages: null };
      }
      return { hardcoverEditionId: edition.id, editionPages: this.normalizeEditionPages(edition.pages) };
    } catch (err) {
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(
        `[hardcover.book_match] [fail] userId=${userId} bookId=${book.bookId} method=cached_pages error="${error}" - cached edition pages lookup failed`,
      );
      return { hardcoverEditionId: cachedEditionId, editionPages: null };
    }
  }

  /**
   * Choose the edition that best represents the local book. Priority:
   * 1. exact ISBN match (strongest, most specific signal),
   * 2. language alignment with the local book (never track an English read against a translation),
   * 3. format alignment (don't track an audiobook against a text file, etc.),
   * 4. closest page count to the local book,
   * 5. presence of a page count (needed for page-based progress),
   * 6. stable fallback to Hardcover's own ordering.
   *
   * Language outranks page count deliberately: a translation frequently has a page count nearer to
   * the local file than any English edition does, so page proximity alone will happily select a
   * foreign edition (a 377-page Catalan Guards! Guards! beat every English edition for a 376-page
   * local book). Tracking the wrong language is far more visible to the user than a small
   * page-count delta.
   */
  private pickBestEdition(editions: HardcoverEdition[], book: BookSyncData): HardcoverEdition | undefined {
    if (editions.length === 0) return undefined;

    if (book.isbn13) {
      const isbnMatch = editions.find((edition) => edition.isbn_13 && edition.isbn_13 === book.isbn13);
      if (isbnMatch) return isbnMatch;
    }
    if (book.isbn10) {
      const isbnMatch = editions.find((edition) => edition.isbn_10 && edition.isbn_10 === book.isbn10);
      if (isbnMatch) return isbnMatch;
    }

    let best = editions[0]!;
    for (let i = 1; i < editions.length; i++) {
      if (this.isBetterEdition(editions[i]!, best, book)) best = editions[i]!;
    }
    return best;
  }

  private isBetterEdition(candidate: HardcoverEdition, current: HardcoverEdition, book: BookSyncData): boolean {
    const desiredLanguageId = this.desiredLanguageId(book.language);
    if (desiredLanguageId != null) {
      const candidateAligned = this.editionMatchesLanguage(candidate, desiredLanguageId);
      const currentAligned = this.editionMatchesLanguage(current, desiredLanguageId);
      if (candidateAligned !== currentAligned) return candidateAligned;
    }

    const wantAudio = this.localIsAudio(book.format);
    const candidateAligned = this.editionIsAudio(candidate) === wantAudio;
    const currentAligned = this.editionIsAudio(current) === wantAudio;
    if (candidateAligned !== currentAligned) return candidateAligned;

    const candidatePages = this.normalizeEditionPages(candidate.pages);
    const currentPages = this.normalizeEditionPages(current.pages);

    if (book.pageCount != null) {
      if ((candidatePages != null) !== (currentPages != null)) return candidatePages != null;
      if (candidatePages != null && currentPages != null) {
        const candidateDelta = Math.abs(candidatePages - book.pageCount);
        const currentDelta = Math.abs(currentPages - book.pageCount);
        if (candidateDelta !== currentDelta) return candidateDelta < currentDelta;
      }
      return false;
    }

    if ((candidatePages != null) !== (currentPages != null)) return candidatePages != null;
    return false;
  }

  /**
   * Map the local book's free-text language onto a Hardcover language id.
   *
   * `book_metadata.language` is unnormalized in practice — real libraries hold `en`, `eng`,
   * `English`, `en-US`, `EN-US`, and junk like `und`. Only English is mapped: it is the one id we
   * can assert without shipping Hardcover's whole language table, and an unrecognized value must
   * return null so the ranking falls through to the previous (page/format) behaviour rather than
   * guessing. An untagged edition (`language_id` null) is never treated as a mismatch.
   */
  private desiredLanguageId(language: string | null | undefined): number | null {
    if (!language) return null;
    const normalized = language.trim().toLowerCase();
    if (!normalized) return null;
    const base = normalized.split(/[-_]/)[0]!;
    if (base === 'en' || base === 'eng' || base === 'english') return HARDCOVER_ENGLISH_LANGUAGE_ID;
    return null;
  }

  private editionMatchesLanguage(edition: HardcoverEdition, desiredLanguageId: number): boolean {
    // Untagged editions are given the benefit of the doubt: a large share of Hardcover editions have
    // no language_id, and penalising them would push good matches below known-foreign ones.
    if (edition.language_id == null) return true;
    return edition.language_id === desiredLanguageId;
  }

  private editionIsAudio(edition: HardcoverEdition): boolean {
    return typeof edition.audio_seconds === 'number' && edition.audio_seconds > 0;
  }

  private localIsAudio(format: string | null): boolean {
    if (!format) return false;
    return AUDIO_FORMATS.has(format.toLowerCase());
  }

  private normalizeEditionPages(pages: number | null | undefined): number | null {
    if (typeof pages !== 'number' || !Number.isFinite(pages) || pages <= 0) return null;
    return Math.round(pages);
  }
}
