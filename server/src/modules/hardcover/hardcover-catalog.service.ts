import type { ExternalBookSearchResult } from '@bookorbit/types';
import { Injectable } from '@nestjs/common';

import { HardcoverClientService } from './hardcover-client.service';
import { HardcoverSettingsService } from './hardcover-settings.service';

const SEARCH_CATALOG_QUERY = `
query SearchCatalog($query: String!) {
  search(
    query: $query
    query_type: "Book"
    per_page: 20
    page: 1
  ) {
    results
  }
}`;

const CATALOG_EDITIONS_QUERY = `
query CatalogEditions($ids: [Int!]!) {
  books(where: { id: { _in: $ids } }, limit: 20) {
    id
    default_ebook_edition {
      isbn_10
      isbn_13
      pages
    }
    default_physical_edition {
      isbn_10
      isbn_13
      pages
    }
  }
}`;

interface HardcoverSearchDocument {
  id?: string | number;
  slug?: string | null;
  title?: string | null;
  description?: string | null;
  author_names?: unknown;
  contributions?: unknown;
  image?: { url?: string | null } | null;
  isbns?: unknown;
  pages?: number | null;
  rating?: number | null;
  ratings_count?: number | null;
  release_year?: number | null;
  has_ebook?: boolean | null;
  featured_series?: {
    position?: number | null;
    series?: { name?: string | null } | null;
  } | null;
}

interface HardcoverSearchResponse {
  search?: {
    results?: {
      hits?: Array<{ document?: HardcoverSearchDocument | null }>;
    } | null;
  } | null;
}

interface HardcoverDefaultEdition {
  isbn_10?: string | null;
  isbn_13?: string | null;
  pages?: number | null;
}

interface HardcoverBookEditions {
  id: number;
  default_ebook_edition?: HardcoverDefaultEdition | null;
  default_physical_edition?: HardcoverDefaultEdition | null;
}

interface HardcoverEditionsResponse {
  books?: HardcoverBookEditions[];
}

@Injectable()
export class HardcoverCatalogService {
  constructor(
    private readonly client: HardcoverClientService,
    private readonly settings: HardcoverSettingsService,
  ) {}

  async search(userId: number, query: string): Promise<ExternalBookSearchResult[]> {
    const token = await this.settings.getTokenForUser(userId);
    if (!token) return [];

    const response = await this.client.query<HardcoverSearchResponse>(userId, token, SEARCH_CATALOG_QUERY, { query });
    const documents = (response.search?.results?.hits ?? []).flatMap((hit) => (hit.document ? [hit.document] : []));
    const ids = documents.map((document) => Number(document.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
    const editionResponse =
      ids.length > 0 ? await this.client.query<HardcoverEditionsResponse>(userId, token, CATALOG_EDITIONS_QUERY, { ids }) : { books: [] };
    const editionsByBookId = new Map((editionResponse.books ?? []).map((book) => [String(book.id), book]));

    return documents
      .map((document) => this.mapDocument(document, editionsByBookId.get(String(document.id))))
      .filter((book): book is ExternalBookSearchResult => book !== null);
  }

  private mapDocument(document: HardcoverSearchDocument | null | undefined, editions?: HardcoverBookEditions): ExternalBookSearchResult | null {
    if (!document) return null;
    const externalId = document.id == null ? '' : String(document.id);
    const title = document.title?.trim() ?? '';
    if (!externalId || !title) return null;

    const slug = document.slug?.trim();
    const ebookEdition = editions?.default_ebook_edition;
    const physicalEdition = editions?.default_physical_edition;

    return {
      id: `hardcover:${externalId}`,
      title,
      authors: this.resolveAuthors(document),
      coverUrl: document.image?.url ?? null,
      description: document.description ?? null,
      publishedYear: this.positiveInteger(document.release_year),
      rating: this.finiteNumber(document.rating),
      ratingsCount: this.nonNegativeInteger(document.ratings_count),
      isbn10: this.normalizeIsbn(ebookEdition?.isbn_10, 10) ?? this.normalizeIsbn(physicalEdition?.isbn_10, 10),
      isbn13: this.normalizeIsbn(ebookEdition?.isbn_13, 13) ?? this.normalizeIsbn(physicalEdition?.isbn_13, 13),
      pageCount: this.positiveInteger(document.pages) ?? this.positiveInteger(physicalEdition?.pages) ?? this.positiveInteger(ebookEdition?.pages),
      seriesName: document.featured_series?.series?.name?.trim() || null,
      seriesPosition: this.finiteNumber(document.featured_series?.position),
      hasEbook: typeof document.has_ebook === 'boolean' ? document.has_ebook : null,
      sources: [
        {
          source: 'hardcover',
          externalId,
          url: slug ? `https://hardcover.app/books/${encodeURIComponent(slug)}` : `https://hardcover.app/books/${externalId}`,
        },
      ],
    };
  }

  private resolveAuthors(document: HardcoverSearchDocument): string[] {
    if (Array.isArray(document.contributions)) {
      const primaryAuthors = document.contributions
        .filter(
          (entry): entry is { primary?: boolean; contribution?: string; author?: { name?: string } } => typeof entry === 'object' && entry !== null,
        )
        .filter((entry) => entry.primary === true && entry.contribution?.toLowerCase() === 'author')
        .map((entry) => entry.author?.name?.trim() ?? '')
        .filter(Boolean);
      if (primaryAuthors.length > 0) return primaryAuthors;
    }

    return Array.isArray(document.author_names)
      ? document.author_names.map((author) => (typeof author === 'string' ? author.trim() : '')).filter(Boolean)
      : [];
  }

  private finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private positiveInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
  }

  private nonNegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  }

  private normalizeIsbn(value: string | null | undefined, length: 10 | 13): string | null {
    const normalized = value?.replace(/[^0-9X]/gi, '') ?? '';
    return normalized.length === length ? normalized : null;
  }
}
