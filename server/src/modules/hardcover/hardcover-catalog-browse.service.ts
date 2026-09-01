import type {
  DiscoveryBrowseHomeResponse,
  DiscoveryBrowseKind,
  DiscoveryBrowseResponse,
  DiscoveryBrowseSection,
  ExternalBookGenre,
  ExternalBookSearchResult,
} from '@bookorbit/types';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { HardcoverCatalogService, type HardcoverCatalogRow } from './hardcover-catalog.service';
import { HardcoverClientService } from './hardcover-client.service';
import { HardcoverReadBooksService } from './hardcover-read-books.service';
import { HardcoverSettingsService } from './hardcover-settings.service';

const HOME_TRENDING_LIMIT = 80;
const HOME_SECTION_SIZE = 10;

export const DISCOVERY_GENRES: ExternalBookGenre[] = [
  { name: 'Fantasy', slug: 'fantasy' },
  { name: 'Science Fiction', slug: 'science-fiction' },
  { name: 'Mystery', slug: 'mystery' },
  { name: 'Romance', slug: 'romance' },
  { name: 'Thriller', slug: 'thriller' },
  { name: 'Historical Fiction', slug: 'historical-fiction' },
  { name: 'Horror', slug: 'horror' },
  { name: 'Young Adult', slug: 'young-adult' },
  { name: 'Literary Fiction', slug: 'literary-fiction' },
  { name: 'Nonfiction', slug: 'nonfiction' },
];

const BOOK_FIELDS = `
  id
  title
  slug
  description
  pages
  rating
  ratings_count
  release_year
  users_count
  cached_tags
  cached_contributors
  cached_featured_series
  image { url }
  default_ebook_edition { isbn_10 isbn_13 pages }
  default_physical_edition { isbn_10 isbn_13 pages }
`;

const TRENDING_IDS_QUERY = `
query TrendingBooks($duration: TrendingDuration!, $limit: Int!, $offset: Int!) {
  books_trending(duration: $duration, limit: $limit, offset: $offset) { ids error }
}`;

const BOOKS_BY_IDS_QUERY = `
query CatalogBooksByIds($ids: [Int!]!) {
  books(where: { id: { _in: $ids } }, limit: 100) { ${BOOK_FIELDS} }
}`;

const GENRE_BOOKS_QUERY = `
query CatalogBooksByGenre($filter: jsonb!, $readIds: [Int!]!, $limit: Int!, $offset: Int!) {
  books(
    where: { book_category_id: { _eq: 1 }, id: { _nin: $readIds }, cached_tags: { _contains: $filter } }
    order_by: [{ users_count: desc }, { ratings_count: desc }]
    limit: $limit
    offset: $offset
  ) { ${BOOK_FIELDS} }
}`;

const AUTHOR_SEARCH_QUERY = `
query CatalogAuthor($query: String!) {
  search(query: $query, query_type: "Author", per_page: 5, page: 1) { results }
}`;

const AUTHOR_BOOKS_QUERY = `
query CatalogBooksByAuthor($authorId: Int!, $readIds: [Int!]!, $limit: Int!, $offset: Int!) {
  books(
    where: { book_category_id: { _eq: 1 }, id: { _nin: $readIds }, contributions: { author_id: { _eq: $authorId }, contributor_role_id: { _eq: 1 } } }
    order_by: [{ users_count: desc }, { ratings_count: desc }]
    limit: $limit
    offset: $offset
  ) { ${BOOK_FIELDS} }
}`;

const SIMILAR_SEED_QUERY = `
query CatalogSimilarSeed($id: Int!) {
  books(where: { id: { _eq: $id } }, limit: 1) { id title cached_similar_book_ids }
}`;

interface TrendingResponse {
  books_trending?: { ids?: number[] | null; error?: string | null } | null;
}

interface CatalogBooksResponse {
  books?: HardcoverCatalogRow[];
}

interface AuthorSearchResponse {
  search?: { results?: { hits?: Array<{ document?: { id?: string | number; name?: string | null } | null }> } | null } | null;
}

interface SimilarSeedResponse {
  books?: Array<{ id: number; title?: string | null; cached_similar_book_ids?: unknown }>;
}

export interface HardcoverBrowseRequest {
  kind: DiscoveryBrowseKind;
  value?: string;
  page: number;
  pageSize: number;
  hideRead: boolean;
}

@Injectable()
export class HardcoverCatalogBrowseService {
  constructor(
    private readonly client: HardcoverClientService,
    private readonly settings: HardcoverSettingsService,
    private readonly catalog: HardcoverCatalogService,
    private readonly readBooks: HardcoverReadBooksService,
  ) {}

  async getBrowseHome(userId: number, hideRead = true): Promise<DiscoveryBrowseHomeResponse> {
    const token = await this.requireToken(userId);
    const readIds = hideRead ? await this.readBooks.getReadBookIds(userId) : new Set<number>();
    const ids = await this.fetchFilteredTrendingPage(userId, token, readIds, 0, HOME_TRENDING_LIMIT);
    const books = await this.fetchBooksByIds(userId, token, ids);
    const trendingItems = this.orderByIds(books, ids);
    const genreShelves = DISCOVERY_GENRES.map((genre) =>
      this.section(
        `genre-${genre.slug}`,
        `Trending ${genre.name}`,
        `Popular on Hardcover this week`,
        'genre',
        genre.slug,
        trendingItems.filter((book) => book.genres.some((bookGenre) => bookGenre.slug === genre.slug)).slice(0, HOME_SECTION_SIZE),
      ),
    ).filter((section) => section.items.length > 0);

    return {
      generatedAt: new Date().toISOString(),
      trending: this.section(
        'trending-week',
        'Trending this week',
        'Books readers are reaching for right now',
        'trending',
        null,
        trendingItems.slice(0, HOME_SECTION_SIZE + 2),
      ),
      genreShelves,
      genres: DISCOVERY_GENRES,
    };
  }

  async browse(userId: number, request: HardcoverBrowseRequest): Promise<DiscoveryBrowseResponse> {
    const token = await this.requireToken(userId);
    const readIds = request.hideRead ? await this.readBooks.getReadBookIds(userId) : new Set<number>();
    if (request.kind === 'trending') return this.browseTrending(userId, token, request, readIds);
    if (request.kind === 'genre') return this.browseGenre(userId, token, request, readIds);
    if (request.kind === 'author') return this.browseAuthor(userId, token, request, readIds);
    return this.browseSimilar(userId, token, request, readIds);
  }

  async getBooksByIds(userId: number, ids: number[]): Promise<ExternalBookSearchResult[]> {
    const token = await this.requireToken(userId);
    return this.fetchBooksByIds(userId, token, ids.slice(0, 100));
  }

  private async browseTrending(
    userId: number,
    token: string,
    request: HardcoverBrowseRequest,
    readIds: Set<number>,
  ): Promise<DiscoveryBrowseResponse> {
    const filteredOffset = (request.page - 1) * request.pageSize;
    const ids = await this.fetchFilteredTrendingPage(userId, token, readIds, filteredOffset, request.pageSize);
    const pageIds = ids.slice(0, request.pageSize);
    const books = await this.fetchBooksByIds(userId, token, pageIds);
    return this.response(
      'trending-week',
      'Trending this week',
      'Updated from Hardcover reader activity',
      'trending',
      null,
      this.orderByIds(books, pageIds),
      request,
      ids.length > request.pageSize,
    );
  }

  private async browseGenre(userId: number, token: string, request: HardcoverBrowseRequest, readIds: Set<number>): Promise<DiscoveryBrowseResponse> {
    const genre = this.resolveGenre(request.value);
    const limit = request.pageSize + 1;
    const response = await this.client.query<CatalogBooksResponse>(userId, token, GENRE_BOOKS_QUERY, {
      filter: { Genre: [{ tagSlug: genre.slug }] },
      readIds: [...readIds],
      limit,
      offset: (request.page - 1) * request.pageSize,
    });
    const rows = response.books ?? [];
    return this.response(
      `genre-${genre.slug}`,
      `${genre.name} books`,
      `Popular ${genre.name.toLowerCase()} books on Hardcover`,
      'genre',
      genre.slug,
      this.catalog.mapCatalogRows(rows.slice(0, request.pageSize)),
      request,
      rows.length > request.pageSize,
    );
  }

  private async browseAuthor(userId: number, token: string, request: HardcoverBrowseRequest, readIds: Set<number>): Promise<DiscoveryBrowseResponse> {
    const value = this.requireValue(request.value, 'Author is required');
    const author = await this.resolveAuthor(userId, token, value);
    const limit = request.pageSize + 1;
    const response = await this.client.query<CatalogBooksResponse>(userId, token, AUTHOR_BOOKS_QUERY, {
      authorId: author.id,
      readIds: [...readIds],
      limit,
      offset: (request.page - 1) * request.pageSize,
    });
    const rows = response.books ?? [];
    return this.response(
      `author-${author.id}`,
      `Books by ${author.name}`,
      null,
      'author',
      author.name,
      this.catalog.mapCatalogRows(rows.slice(0, request.pageSize)),
      request,
      rows.length > request.pageSize,
    );
  }

  private async browseSimilar(
    userId: number,
    token: string,
    request: HardcoverBrowseRequest,
    readIds: Set<number>,
  ): Promise<DiscoveryBrowseResponse> {
    const id = Number(this.requireValue(request.value, 'Hardcover book id is required'));
    if (!Number.isSafeInteger(id) || id <= 0) throw new BadRequestException('Invalid Hardcover book id');
    const seedResponse = await this.client.query<SimilarSeedResponse>(userId, token, SIMILAR_SEED_QUERY, { id });
    const seed = seedResponse.books?.[0];
    if (!seed) throw new NotFoundException('Hardcover book not found');
    const allIds = Array.isArray(seed.cached_similar_book_ids)
      ? seed.cached_similar_book_ids.filter((candidate): candidate is number => Number.isSafeInteger(candidate) && candidate > 0)
      : [];
    const visibleIds = allIds.filter((candidate) => !readIds.has(candidate));
    const offset = (request.page - 1) * request.pageSize;
    const pageIds = visibleIds.slice(offset, offset + request.pageSize);
    const books = await this.fetchBooksByIds(userId, token, pageIds);
    return this.response(
      `similar-${id}`,
      `More like ${seed.title?.trim() || 'this book'}`,
      'Ranked by Hardcover reader similarity',
      'similar',
      String(id),
      this.orderByIds(books, pageIds),
      request,
      visibleIds.length > offset + request.pageSize,
    );
  }

  private async resolveAuthor(userId: number, token: string, query: string): Promise<{ id: number; name: string }> {
    const response = await this.client.query<AuthorSearchResponse>(userId, token, AUTHOR_SEARCH_QUERY, { query });
    const documents = response.search?.results?.hits?.flatMap((hit) => (hit.document ? [hit.document] : [])) ?? [];
    const normalized = query.trim().toLowerCase();
    const document = documents.find((candidate) => candidate.name?.trim().toLowerCase() === normalized) ?? documents[0];
    const id = Number(document?.id);
    const name = document?.name?.trim() ?? '';
    if (!Number.isSafeInteger(id) || id <= 0 || !name) throw new NotFoundException('Hardcover author not found');
    return { id, name };
  }

  private async fetchTrendingIds(userId: number, token: string, limit: number, offset: number): Promise<number[]> {
    const response = await this.client.query<TrendingResponse>(userId, token, TRENDING_IDS_QUERY, { duration: 'week', limit, offset });
    if (response.books_trending?.error) throw new BadRequestException('Hardcover trending books are unavailable');
    return (response.books_trending?.ids ?? []).filter((id) => Number.isSafeInteger(id) && id > 0);
  }

  private async fetchFilteredTrendingPage(
    userId: number,
    token: string,
    readIds: Set<number>,
    filteredOffset: number,
    pageSize: number,
  ): Promise<number[]> {
    const target = filteredOffset + pageSize + 1;
    const visible: number[] = [];
    const chunkSize = 100;
    for (let rawOffset = 0; rawOffset < 1000 && visible.length < target; rawOffset += chunkSize) {
      const chunk = await this.fetchTrendingIds(userId, token, chunkSize, rawOffset);
      visible.push(...chunk.filter((id) => !readIds.has(id)));
      if (chunk.length < chunkSize) break;
    }
    return visible.slice(filteredOffset, target);
  }

  private async fetchBooksByIds(userId: number, token: string, ids: number[]): Promise<ExternalBookSearchResult[]> {
    if (ids.length === 0) return [];
    const response = await this.client.query<CatalogBooksResponse>(userId, token, BOOKS_BY_IDS_QUERY, { ids });
    return this.catalog.mapCatalogRows(response.books ?? []);
  }

  private orderByIds(books: ExternalBookSearchResult[], ids: number[]): ExternalBookSearchResult[] {
    const byId = new Map(books.map((book) => [Number(book.sources.find((source) => source.source === 'hardcover')?.externalId), book]));
    return ids.flatMap((id) => {
      const book = byId.get(id);
      return book ? [book] : [];
    });
  }

  private resolveGenre(value: string | undefined): ExternalBookGenre {
    const slug = this.requireValue(value, 'Genre is required').toLowerCase();
    const genre = DISCOVERY_GENRES.find((candidate) => candidate.slug === slug);
    if (!genre) throw new BadRequestException('Unsupported discovery genre');
    return genre;
  }

  private requireValue(value: string | undefined, message: string): string {
    const normalized = value?.trim() ?? '';
    if (!normalized) throw new BadRequestException(message);
    return normalized;
  }

  private section(
    id: string,
    title: string,
    subtitle: string | null,
    kind: DiscoveryBrowseKind,
    value: string | null,
    items: ExternalBookSearchResult[],
  ): DiscoveryBrowseSection {
    return { id, title, subtitle, kind, value, items };
  }

  private response(
    id: string,
    title: string,
    subtitle: string | null,
    kind: DiscoveryBrowseKind,
    value: string | null,
    items: ExternalBookSearchResult[],
    request: HardcoverBrowseRequest,
    hasMore: boolean,
  ): DiscoveryBrowseResponse {
    return { ...this.section(id, title, subtitle, kind, value, items), page: request.page, pageSize: request.pageSize, hasMore };
  }

  private async requireToken(userId: number): Promise<string> {
    const token = await this.settings.getTokenForUser(userId);
    if (!token) throw new BadRequestException('Hardcover integration is not configured');
    return token;
  }
}
