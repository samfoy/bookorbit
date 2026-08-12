import { onMounted, ref } from 'vue'

import type { DueSoonWidgetData } from '@bookorbit/types'
import { fetchDueSoon } from '../api/dashboard-widget.api'

export function useDueSoonWidget() {
  const data = ref<DueSoonWidgetData | null>(null)
  const loading = ref(true)
  const error = ref(false)

  async function load() {
    loading.value = true
    error.value = false
    try {
      data.value = await fetchDueSoon()
    } catch {
      error.value = true
    } finally {
      loading.value = false
    }
  }

  onMounted(load)
  return { data, loading, error, refresh: load }
}
