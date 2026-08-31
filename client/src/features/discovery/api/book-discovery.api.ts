import type {
  BookAcquisitionJob,
  BookAcquisitionSourceCapability,
  CreateBookAcquisitionRequest,
  DiscoveryBrowseHomeResponse,
  DiscoveryBrowseKind,
  DiscoveryBrowseResponse,
  ExternalBookSearchResponse,
  ExternalCatalogSource,
} from '@bookorbit/types'
import { api } from '@/lib/api'

const BASE = '/api/v1/discovery'

export async function searchExternalBooks(query: string, sources: ExternalCatalogSource[]): Promise<ExternalBookSearchResponse> {
  const params = new URLSearchParams({ query, sources: sources.join(',') })
  const response = await api(`${BASE}/search?${params.toString()}`)
  return readJson<ExternalBookSearchResponse>(response, 'Failed to search external catalogs')
}

export async function fetchDiscoveryBrowseHome(): Promise<DiscoveryBrowseHomeResponse> {
  const response = await api(`${BASE}/browse/home`)
  return readJson<DiscoveryBrowseHomeResponse>(response, 'Failed to load book discovery')
}

export async function fetchDiscoveryBrowse(
  kind: DiscoveryBrowseKind,
  value: string | null,
  page: number,
  pageSize: number,
): Promise<DiscoveryBrowseResponse> {
  const params = new URLSearchParams({ kind })
  if (value) params.set('value', value)
  params.set('page', String(page))
  params.set('pageSize', String(pageSize))
  const response = await api(`${BASE}/browse?${params.toString()}`)
  return readJson<DiscoveryBrowseResponse>(response, 'Failed to browse external books')
}

export async function fetchAcquisitionSources(): Promise<BookAcquisitionSourceCapability[]> {
  const response = await api(`${BASE}/acquisition-sources`)
  return readJson<BookAcquisitionSourceCapability[]>(response, 'Failed to load acquisition sources')
}

export async function startBookAcquisition(request: CreateBookAcquisitionRequest): Promise<BookAcquisitionJob> {
  const response = await api(`${BASE}/acquisitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  return readJson<BookAcquisitionJob>(response, 'Failed to start book acquisition')
}

export async function fetchBookAcquisitions(): Promise<BookAcquisitionJob[]> {
  const response = await api(`${BASE}/acquisitions`)
  return readJson<BookAcquisitionJob[]>(response, 'Failed to load acquisitions')
}

export async function fetchBookAcquisition(jobId: string): Promise<BookAcquisitionJob> {
  const response = await api(`${BASE}/acquisitions/${encodeURIComponent(jobId)}`)
  return readJson<BookAcquisitionJob>(response, 'Failed to load acquisition')
}

export async function cancelBookAcquisition(jobId: string): Promise<BookAcquisitionJob> {
  const response = await api(`${BASE}/acquisitions/${encodeURIComponent(jobId)}`, { method: 'DELETE' })
  return readJson<BookAcquisitionJob>(response, 'Failed to cancel acquisition')
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string' ? body.message : fallback
    throw new Error(message)
  }
  return body as T
}
