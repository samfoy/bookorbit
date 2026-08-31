export const EXTERNAL_CATALOG_SOURCES = ["hardcover", "storygraph"] as const;
export type ExternalCatalogSource = (typeof EXTERNAL_CATALOG_SOURCES)[number];

export interface ExternalBookSourceLink {
  source: ExternalCatalogSource;
  externalId: string;
  url: string;
}

export interface ExternalBookSearchResult {
  id: string;
  title: string;
  authors: string[];
  coverUrl: string | null;
  description: string | null;
  publishedYear: number | null;
  rating: number | null;
  ratingsCount: number | null;
  isbn10: string | null;
  isbn13: string | null;
  pageCount: number | null;
  seriesName: string | null;
  seriesPosition: number | null;
  hasEbook: boolean | null;
  sources: ExternalBookSourceLink[];
}

export interface ExternalBookSearchRequest {
  query: string;
  sources: ExternalCatalogSource[];
}

export interface ExternalCatalogSourceStatus {
  source: ExternalCatalogSource;
  configured: boolean;
  available: boolean;
  resultCount: number;
  message: string | null;
}

export interface ExternalBookSearchResponse {
  results: ExternalBookSearchResult[];
  sources: ExternalCatalogSourceStatus[];
}

export const BOOK_ACQUISITION_SOURCES = ["auto", "libgen", "annas_archive"] as const;
export type BookAcquisitionSource = (typeof BOOK_ACQUISITION_SOURCES)[number];

export const BOOK_ACQUISITION_STATUSES = ["queued", "downloading", "optimizing", "importing", "completed", "failed", "cancelled"] as const;
export type BookAcquisitionStatus = (typeof BOOK_ACQUISITION_STATUSES)[number];

export interface CreateBookAcquisitionRequest {
  libraryId: number;
  folderId?: number;
  title: string;
  authors: string[];
  isbn10?: string | null;
  isbn13?: string | null;
  source: BookAcquisitionSource;
}

export interface BookAcquisitionJob {
  id: string;
  title: string;
  author: string | null;
  status: BookAcquisitionStatus;
  source: BookAcquisitionSource;
  libraryId: number;
  bookId: number | null;
  bytesDownloaded: number | null;
  x3Optimized: boolean | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BookAcquisitionSourceCapability {
  source: Exclude<BookAcquisitionSource, "auto">;
  available: boolean;
  label: string;
  message: string | null;
}
