import { computed, ref } from 'vue'

import type { PhysicalCopySummary } from '@bookorbit/types'

import { fetchPhysicalCopy, logPhysicalProgress, returnPhysicalCopy, updatePhysicalCopy } from '../api/physical-book.api'
import type { UpdatePhysicalCopyInput } from '../api/physical-book.api'

/**
 * State for one physical copy: load it, log page progress, edit it, return it.
 *
 * The server owns every derived value (percentage, pace, urgency), so this
 * composable never recomputes them locally -- it just swaps in the copy the
 * server returns after a mutation. That keeps one source of truth for the
 * timezone-sensitive day math.
 */
export function usePhysicalCopy(bookId: () => number | null) {
  const copy = ref<PhysicalCopySummary | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)

  const isPhysical = computed(() => copy.value !== null)
  const isLoan = computed(() => copy.value !== null && copy.value.acquisition !== 'owned')
  const isReturned = computed(() => copy.value?.returnedOn != null)

  /** Page count actually usable for progress math, or null when unknown. */
  const effectivePageCount = computed(() => copy.value?.effectivePageCount ?? null)

  async function load(): Promise<void> {
    const id = bookId()
    if (id === null) return
    loading.value = true
    error.value = null
    try {
      copy.value = await fetchPhysicalCopy(id)
    } catch {
      // A book with no physical copy is a normal case (every ebook), not an error
      // worth surfacing -- the panel simply does not render.
      copy.value = null
    } finally {
      loading.value = false
    }
  }

  async function logProgress(input: { currentPage: number; minutes?: number; startedAt?: string }): Promise<boolean> {
    const id = bookId()
    if (id === null) return false
    saving.value = true
    error.value = null
    try {
      copy.value = await logPhysicalProgress(id, input)
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to log progress'
      return false
    } finally {
      saving.value = false
    }
  }

  async function update(input: UpdatePhysicalCopyInput): Promise<boolean> {
    const id = bookId()
    if (id === null) return false
    saving.value = true
    error.value = null
    try {
      copy.value = await updatePhysicalCopy(id, input)
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to update copy'
      return false
    } finally {
      saving.value = false
    }
  }

  async function markReturned(): Promise<boolean> {
    const id = bookId()
    if (id === null) return false
    saving.value = true
    error.value = null
    try {
      copy.value = await returnPhysicalCopy(id)
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to mark returned'
      return false
    } finally {
      saving.value = false
    }
  }

  return {
    copy,
    loading,
    saving,
    error,
    isPhysical,
    isLoan,
    isReturned,
    effectivePageCount,
    load,
    logProgress,
    update,
    markReturned,
  }
}
