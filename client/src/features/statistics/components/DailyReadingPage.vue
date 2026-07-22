<script setup lang="ts">
import { computed, ref, shallowRef, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import VChart from 'vue-echarts'
import { AlertCircle, BookOpen, CalendarCheck, CalendarClock, Clock, Flame } from '@lucide/vue'
import { Skeleton } from '@/components/ui/skeleton'
import { useThemeStore } from '@/stores/theme'
import { getThemePalette } from '@/lib/echarts'
import ChartEmptyState from './ChartEmptyState.vue'
import { useUserDailyReadingByBook } from '../composables/useUserDailyReadingByBook'

const RANGE_OPTIONS = [30, 90, 180, 365] as const
const MAX_BOOK_SERIES = 8
const LEGEND_LABEL_MAX_CHARS = 28
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const { t } = useI18n()
const router = useRouter()
const themeStore = useThemeStore()

const days = ref<number>(90)
const { data, loading, error } = useUserDailyReadingByBook(days)

const palette = computed(() => getThemePalette(themeStore.resolvedTheme, themeStore.accent))

function setRange(value: number) {
  days.value = value
}

// Local-calendar day keys: the server buckets sessions in the profile timezone,
// so the axis must be built from local date parts, not UTC (toISOString would
// shift evening reading onto the next day's bar).
function formatDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const dayOfMonth = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${dayOfMonth}`
}

function truncateLabel(label: string): string {
  return label.length > LEGEND_LABEL_MAX_CHARS ? `${label.slice(0, LEGEND_LABEL_MAX_CHARS - 1)}…` : label
}

function formatDayLabel(dayKey: string): string {
  const month = Number(dayKey.slice(5, 7))
  const dayOfMonth = Number(dayKey.slice(8, 10))
  return `${MONTH_NAMES[month - 1]} ${dayOfMonth}`
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.round(totalSeconds / 60)
  if (minutes < 60) return t('statistics.dailyReading.minutesShort', { minutes })
  const hours = Math.floor(minutes / 60)
  const remaining = minutes % 60
  if (remaining === 0) return t('statistics.dailyReading.hoursShort', { hours })
  return t('statistics.dailyReading.hoursMinutesShort', { hours, minutes: remaining })
}

const dayKeys = computed(() => {
  const keys: string[] = []
  const now = new Date()
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  cursor.setDate(cursor.getDate() - (days.value - 1))
  for (let i = 0; i < days.value; i += 1) {
    keys.push(formatDayKey(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return keys
})

interface BookGroup {
  key: string
  bookId: number | null
  label: string
  totalSeconds: number
  byDay: Map<string, number>
}

const bookGroups = computed<BookGroup[]>(() => {
  const byBook = new Map<number, { label: string; totalSeconds: number; byDay: Map<string, number> }>()
  for (const row of data.value) {
    let entry = byBook.get(row.bookId)
    if (!entry) {
      entry = { label: row.bookTitle?.trim() || t('statistics.dailyReading.unknownBook'), totalSeconds: 0, byDay: new Map() }
      byBook.set(row.bookId, entry)
    }
    entry.totalSeconds += row.readingSeconds
    entry.byDay.set(row.day, (entry.byDay.get(row.day) ?? 0) + row.readingSeconds)
  }

  const ranked = [...byBook.entries()].sort((a, b) => b[1].totalSeconds - a[1].totalSeconds)
  const groups: BookGroup[] = ranked
    .slice(0, MAX_BOOK_SERIES)
    .map(([bookId, entry]) => ({ key: `book-${bookId}`, bookId, label: entry.label, totalSeconds: entry.totalSeconds, byDay: entry.byDay }))

  const rest = ranked.slice(MAX_BOOK_SERIES)
  if (rest.length > 0) {
    const byDay = new Map<string, number>()
    let totalSeconds = 0
    for (const [, entry] of rest) {
      totalSeconds += entry.totalSeconds
      for (const [day, seconds] of entry.byDay) {
        byDay.set(day, (byDay.get(day) ?? 0) + seconds)
      }
    }
    groups.push({ key: 'other', bookId: null, label: t('statistics.dailyReading.otherBooks', { count: rest.length }), totalSeconds, byDay })
  }
  return groups
})

function openBook(bookId: number | null) {
  if (bookId == null) return
  void router.push({ name: 'book-detail', params: { bookId } })
}

const totalsByDay = computed(() => {
  const totals = new Map<string, number>()
  for (const row of data.value) {
    totals.set(row.day, (totals.get(row.day) ?? 0) + row.readingSeconds)
  }
  return totals
})

const summary = computed(() => {
  const totals = totalsByDay.value
  let totalSeconds = 0
  let activeDays = 0
  let busiestDay: { day: string; seconds: number } | null = null
  for (const day of dayKeys.value) {
    const seconds = totals.get(day) ?? 0
    totalSeconds += seconds
    if (seconds > 0) activeDays += 1
    if (seconds > 0 && (!busiestDay || seconds > busiestDay.seconds)) busiestDay = { day, seconds }
  }

  let streak = 0
  for (let i = dayKeys.value.length - 1; i >= 0; i -= 1) {
    const seconds = totals.get(dayKeys.value[i]!) ?? 0
    if (seconds > 0) {
      streak += 1
    } else if (i === dayKeys.value.length - 1) {
      continue
    } else {
      break
    }
  }

  return {
    totalSeconds,
    activeDays,
    avgSecondsPerActiveDay: activeDays > 0 ? totalSeconds / activeDays : 0,
    streak,
    busiestDay,
  }
})

const isEmpty = computed(() => !loading.value && !error.value && summary.value.totalSeconds === 0)

const option = shallowRef({})

watchEffect(() => {
  option.value = {}
  if (loading.value || error.value || isEmpty.value) return

  const keys = dayKeys.value
  const labels = keys.map(formatDayLabel)
  const groups = bookGroups.value
  const colors = palette.value
  const totals = totalsByDay.value

  const series = groups.map((group, index) => ({
    name: group.label,
    type: 'bar',
    stack: 'reading',
    barMaxWidth: 26,
    itemStyle: { color: colors[index % colors.length] },
    emphasis: { focus: 'series' },
    data: keys.map((day) => {
      const seconds = group.byDay.get(day) ?? 0
      return seconds > 0 ? Number((seconds / 60).toFixed(1)) : 0
    }),
  }))

  option.value = {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: Array<{ seriesName: string; value: number; dataIndex: number; marker: string }>) => {
        if (!params.length) return ''
        const index = params[0]!.dataIndex
        const day = keys[index] ?? ''
        const totalSeconds = totals.get(day) ?? 0
        const rows = params
          .filter((point) => point.value > 0)
          .sort((a, b) => b.value - a.value)
          .map((point) => `${point.marker} ${point.seriesName}: <strong>${formatDuration(point.value * 60)}</strong>`)
        const header = `${formatDayLabel(day)}<br/>${t('statistics.dailyReading.tooltipTotal')}: <strong>${formatDuration(totalSeconds)}</strong>`
        return rows.length ? `${header}<br/>${rows.join('<br/>')}` : header
      },
    },
    legend: {
      type: 'scroll',
      bottom: 0,
      itemWidth: 12,
      itemHeight: 12,
      textStyle: { fontSize: 11 },
      formatter: truncateLabel,
    },
    grid: { left: 8, right: 12, top: 16, bottom: 46, containLabel: true },
    xAxis: {
      type: 'category',
      data: labels,
      axisTick: { show: false },
      axisLabel: { fontSize: 10, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      min: 0,
      name: t('statistics.dailyReading.yAxisMinutes'),
      nameTextStyle: { fontSize: 10 },
      axisLabel: { fontSize: 10 },
    },
    dataZoom:
      keys.length > 120
        ? [
            { type: 'inside', start: Math.max(0, 100 - (120 / keys.length) * 100), end: 100 },
            { type: 'slider', height: 14, bottom: 24 },
          ]
        : undefined,
    series,
  }
})

const bookTotals = computed(() => {
  const groups = bookGroups.value
  const max = groups.reduce((m, g) => Math.max(m, g.totalSeconds), 0)
  return groups.map((group, index) => ({
    key: group.key,
    bookId: group.bookId,
    label: group.label,
    totalSeconds: group.totalSeconds,
    sharePct: max > 0 ? Math.round((group.totalSeconds / max) * 100) : 0,
    color: palette.value[index % palette.value.length],
  }))
})

const summaryCards = computed(() => [
  { key: 'total', icon: Clock, label: t('statistics.dailyReading.totalTime'), value: formatDuration(summary.value.totalSeconds) },
  {
    key: 'activeDays',
    icon: CalendarCheck,
    label: t('statistics.dailyReading.activeDays'),
    value: t('statistics.dailyReading.activeDaysValue', { active: summary.value.activeDays, total: days.value }),
  },
  {
    key: 'average',
    icon: CalendarClock,
    label: t('statistics.dailyReading.avgPerActiveDay'),
    value: formatDuration(summary.value.avgSecondsPerActiveDay),
  },
  {
    key: 'streak',
    icon: Flame,
    label: t('statistics.dailyReading.currentStreak'),
    value: t('statistics.dailyReading.streakValue', { count: summary.value.streak }, summary.value.streak),
  },
])
</script>

<template>
  <div class="flex flex-col gap-6 pt-4">
    <div class="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">{{ t('statistics.dailyReading.title') }}</h1>
        <p class="text-muted-foreground text-sm">{{ t('statistics.dailyReading.subtitle') }}</p>
      </div>
      <div class="flex w-full items-center gap-1 rounded-lg bg-muted p-1 sm:w-auto">
        <button
          v-for="rangeOption in RANGE_OPTIONS"
          :key="rangeOption"
          :class="[
            'flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors sm:flex-none',
            days === rangeOption ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          ]"
          @click="setRange(rangeOption)"
        >
          {{ t('statistics.dailyReading.rangeDays', { count: rangeOption }) }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="flex flex-col gap-4">
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Skeleton v-for="index in 4" :key="index" class="h-24 w-full rounded-lg" />
      </div>
      <Skeleton class="h-[380px] w-full rounded-lg" />
    </div>

    <div v-else-if="error" class="text-muted-foreground flex min-h-[320px] flex-col items-center justify-center gap-2 rounded-lg border">
      <AlertCircle class="size-6" />
      <p class="text-sm">{{ t('statistics.card.loadError') }}</p>
    </div>

    <div v-else-if="isEmpty" class="min-h-[320px] rounded-lg border">
      <ChartEmptyState
        :icon="BookOpen"
        :title="t('statistics.dailyReading.emptyTitle')"
        :description="t('statistics.dailyReading.emptyDescription')"
      />
    </div>

    <template v-else>
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div v-for="card in summaryCards" :key="card.key" class="bg-card text-card-foreground flex flex-col gap-1.5 rounded-lg border p-4 shadow-sm">
          <div class="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            <component :is="card.icon" class="size-3.5" />
            {{ card.label }}
          </div>
          <p class="text-lg font-semibold tabular-nums">{{ card.value }}</p>
        </div>
      </div>

      <div class="bg-card text-card-foreground rounded-lg border p-4 shadow-sm">
        <p class="text-sm font-semibold">{{ t('statistics.dailyReading.chartTitle') }}</p>
        <div class="h-[380px] w-full">
          <VChart :option autoresize style="height: 100%; width: 100%" />
        </div>
      </div>

      <div class="bg-card text-card-foreground rounded-lg border p-4 shadow-sm">
        <p class="mb-3 text-sm font-semibold">{{ t('statistics.dailyReading.byBookTitle') }}</p>
        <ul class="flex flex-col gap-1">
          <li v-for="book in bookTotals" :key="book.key">
            <button
              type="button"
              class="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors enabled:hover:bg-muted/60 disabled:cursor-default"
              :disabled="book.bookId == null"
              @click="openBook(book.bookId)"
            >
              <span class="size-2.5 shrink-0 rounded-sm" :style="{ backgroundColor: book.color }" />
              <span class="min-w-0 flex-1 truncate text-sm" :class="book.bookId != null ? 'hover:underline' : 'text-muted-foreground'">{{
                book.label
              }}</span>
              <span class="bg-muted hidden h-1.5 w-40 overflow-hidden rounded-full sm:block">
                <span class="block h-full rounded-full" :style="{ width: `${book.sharePct}%`, backgroundColor: book.color }" />
              </span>
              <span class="text-muted-foreground w-20 shrink-0 text-right text-sm tabular-nums">{{ formatDuration(book.totalSeconds) }}</span>
            </button>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
