import { onMounted, ref, watch, type Ref } from 'vue'

import type { UserDailyBookReadingStat } from '@bookorbit/types'
import { fetchUserDailyReadingByBook } from '../api/statistics.api'

export function useUserDailyReadingByBook(days: Ref<number>) {
  const data = ref<UserDailyBookReadingStat[]>([])
  const loading = ref(true)
  const error = ref(false)
  let latestRequestId = 0

  async function load() {
    const requestId = ++latestRequestId
    loading.value = true
    error.value = false
    try {
      const next = await fetchUserDailyReadingByBook(days.value)
      if (requestId !== latestRequestId) return
      data.value = next
    } catch {
      if (requestId !== latestRequestId) return
      error.value = true
    } finally {
      if (requestId === latestRequestId) {
        loading.value = false
      }
    }
  }

  watch(days, load)
  onMounted(load)

  return { data, loading, error }
}
