import type { ExternalBookSearchResult } from '@bookorbit/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as BookDiscoveryApi from '../../api/book-discovery.api'

const apiMocks = vi.hoisted(() => ({
  searchExternalBooks: vi.fn<typeof BookDiscoveryApi.searchExternalBooks>(),
  fetchAcquisitionSources: vi.fn<typeof BookDiscoveryApi.fetchAcquisitionSources>(),
  startBookAcquisition: vi.fn<typeof BookDiscoveryApi.startBookAcquisition>(),
  fetchBookAcquisitions: vi.fn<typeof BookDiscoveryApi.fetchBookAcquisitions>(),
  cancelBookAcquisition: vi.fn<typeof BookDiscoveryApi.cancelBookAcquisition>(),
}))

vi.mock('../../api/book-discovery.api', () => apiMocks)

import { useBookDiscovery } from '../useBookDiscovery'

const book: ExternalBookSearchResult = {
  id: 'hardcover:1',
  title: 'Piranesi',
  authors: ['Susanna Clarke'],
  coverUrl: null,
  description: null,
  publishedYear: 2020,
  rating: 4.2,
  ratingsCount: 1000,
  isbn10: null,
  isbn13: '9781635575637',
  pageCount: 272,
  seriesName: null,
  seriesPosition: null,
  hasEbook: true,
  sources: [{ source: 'hardcover', externalId: '1', url: 'https://hardcover.app/books/piranesi' }],
}

describe('useBookDiscovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.fetchAcquisitionSources.mockResolvedValue([])
    apiMocks.fetchBookAcquisitions.mockResolvedValue([])
  })

  it('trims a query and stores merged catalog results with source health', async () => {
    apiMocks.searchExternalBooks.mockResolvedValue({
      results: [book],
      sources: [{ source: 'hardcover', configured: true, available: true, resultCount: 1, message: null }],
    })
    const discovery = useBookDiscovery()
    discovery.query.value = '  Piranesi  '

    await discovery.search()

    expect(apiMocks.searchExternalBooks).toHaveBeenCalledWith('Piranesi', ['hardcover', 'storygraph'])
    expect(discovery.results.value).toEqual([book])
    expect(discovery.sourceStatuses.value).toEqual([{ source: 'hardcover', configured: true, available: true, resultCount: 1, message: null }])
    expect(discovery.hasSearched.value).toBe(true)
    expect(discovery.error.value).toBeNull()
  })

  it('starts acquisition from a result and adds the returned job', async () => {
    const job = {
      id: 'job-1',
      title: 'Piranesi',
      author: 'Susanna Clarke',
      status: 'queued' as const,
      source: 'auto' as const,
      libraryId: 3,
      bookId: null,
      bytesDownloaded: null,
      x3Optimized: null,
      error: null,
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    }
    apiMocks.startBookAcquisition.mockResolvedValue(job)
    const discovery = useBookDiscovery()

    await discovery.acquire(book, { libraryId: 3, folderId: 9, source: 'auto' })

    expect(apiMocks.startBookAcquisition).toHaveBeenCalledWith({
      libraryId: 3,
      folderId: 9,
      title: 'Piranesi',
      authors: ['Susanna Clarke'],
      isbn10: null,
      isbn13: '9781635575637',
      source: 'auto',
    })
    expect(discovery.jobs.value).toEqual([job])
  })
})
