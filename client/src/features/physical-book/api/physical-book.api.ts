import type { MetadataCandidate, PhysicalAcquisition, PhysicalBinding, PhysicalCopySummary } from '@bookorbit/types'
import { api } from '@/lib/api'

/**
 * Client for the physical-book endpoints.
 *
 * Physical books are fileless `books` rows (`medium = 'physical'`), so nothing
 * here takes a file id -- every call is keyed by book id. Response shapes mirror
 * `server/src/modules/physical-book/physical-book.controller.ts`.
 */

export type CreatePhysicalBookInput = {
  libraryId: number
  acquisition: PhysicalAcquisition
  isbn?: string
  title?: string
  author?: string
  lender?: string
  dueOn?: string
  pageCount?: number
  currentPage?: number
  renewalLimit?: number
  binding?: PhysicalBinding
  shelfLocation?: string
  acquiredOn?: string
  notes?: string
}

export type UpdatePhysicalCopyInput = {
  acquisition?: PhysicalAcquisition
  pageCount?: number | null
  lender?: string | null
  dueOn?: string | null
  renewalsUsed?: number
  renewalLimit?: number | null
  binding?: PhysicalBinding | null
  shelfLocation?: string | null
  acquiredOn?: string | null
  notes?: string | null
}

export type BulkImportResult = {
  created: { isbn: string; bookId: number }[]
  failed: { isbn: string; reason: string }[]
}

/** Preview metadata for an ISBN without writing anything. Returns null on no match. */
export async function lookupPhysicalIsbn(isbn: string): Promise<MetadataCandidate | null> {
  const res = await api('/api/v1/physical-books/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isbn }),
  })
  if (!res.ok) throw new Error('Failed to look up ISBN')
  return res.json()
}

export type CreatePhysicalBookOutcome =
  | { conflict: true; bookId: number }
  | { conflict: false; bookId: number; copy: PhysicalCopySummary }

/**
 * Shelve a physical copy.
 *
 * A 409 is an expected OUTCOME, not a failure: it means this ISBN already has a
 * physical copy for this user. Returning it as a typed result lets the caller say
 * "already on your shelf" and link to the existing book rather than showing an
 * error for what is really a duplicate scan.
 */
export async function createPhysicalBook(input: CreatePhysicalBookInput): Promise<CreatePhysicalBookOutcome> {
  const res = await api('/api/v1/physical-books', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (res.status === 409) {
    const body = await res.json().catch(() => null)
    return { conflict: true, bookId: Number(body?.bookId ?? 0) }
  }
  if (!res.ok) throw new Error('Failed to add physical book')
  const body = await res.json()
  return { conflict: false, bookId: body.bookId, copy: body.copy }
}

export async function bulkImportPhysicalBooks(input: {
  libraryId: number
  isbns: string[]
  acquisition: PhysicalAcquisition
  lender?: string
}): Promise<BulkImportResult> {
  const res = await api('/api/v1/physical-books/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error('Failed to import physical books')
  return res.json()
}

export async function fetchPhysicalCopy(bookId: number): Promise<PhysicalCopySummary> {
  const res = await api(`/api/v1/physical-books/${bookId}`)
  if (!res.ok) throw new Error('Failed to fetch physical copy')
  return res.json()
}

/**
 * Record a new current page, optionally with minutes spent.
 *
 * Passing `minutes` is what creates a real reading session (source='physical'),
 * which is how a physical book feeds the streak and Daily Reading. A page-only
 * update is treated as a correction and logs no session.
 */
export async function logPhysicalProgress(
  bookId: number,
  input: { currentPage: number; minutes?: number; startedAt?: string },
): Promise<PhysicalCopySummary> {
  const res = await api(`/api/v1/physical-books/${bookId}/progress`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error('Failed to log progress')
  return res.json()
}

export async function updatePhysicalCopy(bookId: number, input: UpdatePhysicalCopyInput): Promise<PhysicalCopySummary> {
  const res = await api(`/api/v1/physical-books/${bookId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error('Failed to update physical copy')
  return res.json()
}

export async function returnPhysicalCopy(bookId: number): Promise<PhysicalCopySummary> {
  const res = await api(`/api/v1/physical-books/${bookId}/return`, { method: 'POST' })
  if (!res.ok) throw new Error('Failed to mark copy returned')
  return res.json()
}

export async function deletePhysicalCopy(bookId: number): Promise<void> {
  const res = await api(`/api/v1/physical-books/${bookId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to remove physical copy')
}
