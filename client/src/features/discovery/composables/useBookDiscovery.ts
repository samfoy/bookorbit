import type {
  BookAcquisitionJob,
  BookAcquisitionSource,
  BookAcquisitionSourceCapability,
  ExternalBookSearchResult,
  ExternalCatalogSource,
  ExternalCatalogSourceStatus,
} from '@bookorbit/types'
import { computed, ref } from 'vue'

import {
  cancelBookAcquisition,
  fetchAcquisitionSources,
  fetchBookAcquisitions,
  searchExternalBooks,
  startBookAcquisition,
} from '../api/book-discovery.api'

interface AcquireBookOptions {
  libraryId: number
  folderId?: number
  source: BookAcquisitionSource
}

const ACTIVE_JOB_STATUSES = new Set(['queued', 'downloading', 'optimizing', 'importing'])

export function useBookDiscovery() {
  const query = ref('')
  const selectedSources = ref<ExternalCatalogSource[]>(['hardcover', 'storygraph'])
  const results = ref<ExternalBookSearchResult[]>([])
  const sourceStatuses = ref<ExternalCatalogSourceStatus[]>([])
  const searching = ref(false)
  const hasSearched = ref(false)
  const error = ref<string | null>(null)

  const acquisitionSources = ref<BookAcquisitionSourceCapability[]>([])
  const jobs = ref<BookAcquisitionJob[]>([])
  const acquisitionLoading = ref(false)
  const acquisitionError = ref<string | null>(null)

  const hasActiveJobs = computed(() => jobs.value.some((job) => ACTIVE_JOB_STATUSES.has(job.status)))

  async function search(): Promise<void> {
    const normalizedQuery = query.value.trim()
    if (normalizedQuery.length < 2 || selectedSources.value.length === 0) return

    searching.value = true
    error.value = null
    try {
      const response = await searchExternalBooks(normalizedQuery, [...selectedSources.value])
      results.value = response.results
      sourceStatuses.value = response.sources
      hasSearched.value = true
    } catch (cause) {
      error.value = errorMessage(cause, 'Failed to search external catalogs')
      results.value = []
      sourceStatuses.value = []
      hasSearched.value = true
    } finally {
      searching.value = false
    }
  }

  function toggleSource(source: ExternalCatalogSource): void {
    selectedSources.value = selectedSources.value.includes(source)
      ? selectedSources.value.filter((candidate) => candidate !== source)
      : [...selectedSources.value, source]
  }

  async function loadAcquisitionState(): Promise<void> {
    acquisitionLoading.value = true
    acquisitionError.value = null
    const [sourcesResult, jobsResult] = await Promise.allSettled([fetchAcquisitionSources(), fetchBookAcquisitions()])
    if (sourcesResult.status === 'fulfilled') acquisitionSources.value = sourcesResult.value
    if (jobsResult.status === 'fulfilled') jobs.value = jobsResult.value
    if (sourcesResult.status === 'rejected' || jobsResult.status === 'rejected') {
      const cause = sourcesResult.status === 'rejected' ? sourcesResult.reason : jobsResult.status === 'rejected' ? jobsResult.reason : null
      acquisitionError.value = errorMessage(cause, 'Failed to load acquisition state')
    }
    acquisitionLoading.value = false
  }

  async function acquire(book: ExternalBookSearchResult, options: AcquireBookOptions): Promise<BookAcquisitionJob> {
    acquisitionError.value = null
    const job = await startBookAcquisition({
      libraryId: options.libraryId,
      ...(options.folderId === undefined ? {} : { folderId: options.folderId }),
      title: book.title,
      authors: book.authors,
      isbn10: book.isbn10,
      isbn13: book.isbn13,
      source: options.source,
    })
    jobs.value = [job, ...jobs.value.filter((candidate) => candidate.id !== job.id)]
    return job
  }

  async function refreshJobs(): Promise<void> {
    try {
      jobs.value = await fetchBookAcquisitions()
    } catch (cause) {
      acquisitionError.value = errorMessage(cause, 'Failed to refresh acquisitions')
    }
  }

  async function cancelJob(jobId: string): Promise<void> {
    const job = await cancelBookAcquisition(jobId)
    jobs.value = jobs.value.map((candidate) => (candidate.id === job.id ? job : candidate))
  }

  return {
    query,
    selectedSources,
    results,
    sourceStatuses,
    searching,
    hasSearched,
    error,
    acquisitionSources,
    jobs,
    acquisitionLoading,
    acquisitionError,
    hasActiveJobs,
    search,
    toggleSource,
    loadAcquisitionState,
    acquire,
    refreshJobs,
    cancelJob,
  }
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}
