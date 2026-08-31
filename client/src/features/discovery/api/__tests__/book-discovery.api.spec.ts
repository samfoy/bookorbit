import type { CreateBookAcquisitionRequest } from '@bookorbit/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type ApiFn = (input: RequestInfo | URL, init?: RequestInit & { _isRetry?: boolean }) => Promise<Response>

vi.mock('@/lib/api', () => ({
  api: vi.fn<ApiFn>(),
}))

import { api } from '@/lib/api'
import {
  cancelBookAcquisition,
  fetchAcquisitionSources,
  fetchBookAcquisition,
  fetchBookAcquisitions,
  fetchDiscoveryBrowse,
  fetchDiscoveryBrowseHome,
  searchExternalBooks,
  startBookAcquisition,
} from '../book-discovery.api'

const mockApi = vi.mocked(api)

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn<() => Promise<unknown>>().mockResolvedValue(body),
  } as unknown as Response
}

describe('book-discovery.api', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  it('searches selected external catalogs with URL-safe query parameters', async () => {
    mockApi.mockResolvedValue(jsonResponse({ results: [], sources: [] }))

    await expect(searchExternalBooks('A Psalm & a Wild-Built', ['hardcover', 'storygraph'])).resolves.toEqual({ results: [], sources: [] })

    expect(mockApi).toHaveBeenCalledWith('/api/v1/discovery/search?query=A+Psalm+%26+a+Wild-Built&sources=hardcover%2Cstorygraph')
  })

  it('loads browse home and URL-safe paginated browse modes', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ genreShelves: [] })).mockResolvedValueOnce(jsonResponse({ items: [], page: 2 }))

    await fetchDiscoveryBrowseHome(true)
    await fetchDiscoveryBrowse('author', 'Ursula K. Le Guin', 2, 20, true)

    expect(mockApi).toHaveBeenNthCalledWith(1, '/api/v1/discovery/browse/home?hideRead=true')
    expect(mockApi).toHaveBeenNthCalledWith(2, '/api/v1/discovery/browse?kind=author&value=Ursula+K.+Le+Guin&page=2&pageSize=20&hideRead=true')
  })

  it('starts an acquisition with the exact backend DTO shape', async () => {
    const request: CreateBookAcquisitionRequest = {
      libraryId: 3,
      folderId: 9,
      title: 'Piranesi',
      authors: ['Susanna Clarke'],
      isbn13: '9781635575637',
      source: 'auto',
    }
    mockApi.mockResolvedValue(jsonResponse({ id: 'job-1', status: 'queued' }))

    await startBookAcquisition(request)

    expect(mockApi).toHaveBeenCalledWith('/api/v1/discovery/acquisitions', expect.objectContaining({ method: 'POST', body: JSON.stringify(request) }))
  })

  it('reads capabilities and manages user acquisition jobs', async () => {
    mockApi
      .mockResolvedValueOnce(jsonResponse([{ source: 'libgen', available: true }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'job-1' }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'cancelled' }))

    await fetchAcquisitionSources()
    await fetchBookAcquisitions()
    await fetchBookAcquisition('job-1')
    await cancelBookAcquisition('job-1')

    expect(mockApi).toHaveBeenNthCalledWith(1, '/api/v1/discovery/acquisition-sources')
    expect(mockApi).toHaveBeenNthCalledWith(2, '/api/v1/discovery/acquisitions')
    expect(mockApi).toHaveBeenNthCalledWith(3, '/api/v1/discovery/acquisitions/job-1')
    expect(mockApi).toHaveBeenNthCalledWith(4, '/api/v1/discovery/acquisitions/job-1', { method: 'DELETE' })
  })
})
