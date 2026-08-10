import { ref, watch, type Ref } from 'vue'

import type { UserDailyReadingDetail } from '@bookorbit/types'
import { fetchUserDailyReadingDetail } from '../api/statistics.api'

export function useUserDailyReadingDayDetail(day: Ref<string | null>) {
  const data = ref<UserDailyReadingDetail | null>(null)
  const loading = ref(false)
  const error = ref(false)
  let latestRequestId = 0

  async function load() {
    const selectedDay = day.value
    if (!selectedDay) {
      latestRequestId += 1
      data.value = null
      loading.value = false
      error.value = false
      return
    }

    const requestId = ++latestRequestId
    loading.value = true
    error.value = false
    try {
      const next = await fetchUserDailyReadingDetail(selectedDay)
      if (requestId !== latestRequestId) return
      data.value = next
    } catch {
      if (requestId !== latestRequestId) return
      data.value = null
      error.value = true
    } finally {
      if (requestId === latestRequestId) {
        loading.value = false
      }
    }
  }

  watch(day, load, { immediate: true })

  return { data, loading, error, reload: load }
}
