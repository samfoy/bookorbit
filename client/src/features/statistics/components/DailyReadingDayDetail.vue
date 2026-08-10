<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { AlertCircle, CalendarDays, Clock, X } from '@lucide/vue'
import { READING_SESSION_SOURCE_BUCKET_LABELS, type UserDailyReadingDetail } from '@bookorbit/types'
import { Skeleton } from '@/components/ui/skeleton'
import { useThemeStore } from '@/stores/theme'
import { resolveSourceBucketColors } from '../lib/source-bucket-colors'
import ChartEmptyState from './ChartEmptyState.vue'

const MAX_SESSIONS = 500

const props = defineProps<{
  day: string
  detail: UserDailyReadingDetail | null
  loading: boolean
  error: boolean
}>()

const emit = defineEmits<{ close: []; retry: [] }>()

const { t, locale } = useI18n()
const router = useRouter()
const themeStore = useThemeStore()

const sourceColors = computed(() => resolveSourceBucketColors(`${themeStore.resolvedTheme}:${themeStore.accent}`))

const isEmpty = computed(() => !props.loading && !props.error && (props.detail?.sessions.length ?? 0) === 0)

const dayLabel = computed(() => {
  const parsed = new Date(`${props.day}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return props.day
  return parsed.toLocaleDateString(locale.value, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
})

function formatDuration(totalSeconds: number): string {
  const minutes = Math.round(totalSeconds / 60)
  if (minutes < 60) return t('statistics.dailyReading.minutesShort', { minutes })
  const hours = Math.floor(minutes / 60)
  const remaining = minutes % 60
  if (remaining === 0) return t('statistics.dailyReading.hoursShort', { hours })
  return t('statistics.dailyReading.hoursMinutesShort', { hours, minutes: remaining })
}

function formatTime(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleTimeString(locale.value, { hour: 'numeric', minute: '2-digit' })
}

const sessionRows = computed(() =>
  (props.detail?.sessions ?? []).map((session) => ({
    key: session.sessionId,
    bookId: session.bookId,
    label: session.bookTitle?.trim() || t('statistics.dailyReading.unknownBook'),
    format: session.bookFormat?.trim() ? session.bookFormat.trim().toUpperCase() : null,
    sourceLabel: READING_SESSION_SOURCE_BUCKET_LABELS[session.source],
    sourceColor: sourceColors.value[session.source],
    timeRange: t('statistics.dailyReading.dayDetailTimeRange', {
      start: formatTime(session.startedAt),
      end: formatTime(session.endedAt),
    }),
    duration: formatDuration(session.durationSeconds),
    progressDelta:
      session.progressDelta != null && session.progressDelta > 0
        ? t('statistics.dailyReading.dayDetailProgressDelta', { percent: session.progressDelta.toFixed(1) })
        : null,
    endProgress: session.endProgress != null ? t('statistics.dailyReading.dayDetailEndProgress', { percent: Math.round(session.endProgress) }) : null,
  })),
)

const sourceTotals = computed(() => {
  const bySource = props.detail?.bySource
  if (!bySource) return []
  return Object.entries(bySource)
    .filter(([, seconds]) => seconds > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([bucket, seconds]) => ({
      key: bucket,
      label: READING_SESSION_SOURCE_BUCKET_LABELS[bucket as keyof typeof READING_SESSION_SOURCE_BUCKET_LABELS],
      color: sourceColors.value[bucket as keyof typeof READING_SESSION_SOURCE_BUCKET_LABELS],
      duration: formatDuration(seconds),
    }))
})

const isTruncated = computed(() => (props.detail?.sessions.length ?? 0) >= MAX_SESSIONS)

function handleClose() {
  emit('close')
}

function handleRetry() {
  emit('retry')
}

function openBook(bookId: number) {
  void router.push({ name: 'book-detail', params: { bookId } })
}
</script>

<template>
  <div class="bg-card text-card-foreground flex flex-col gap-4 rounded-lg border p-4 shadow-sm" data-testid="day-detail">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm font-semibold">{{ t('statistics.dailyReading.dayDetailTitle') }}</p>
        <p class="text-muted-foreground flex items-center gap-1.5 text-xs">
          <CalendarDays class="size-3.5 shrink-0" />
          <span class="truncate">{{ dayLabel }}</span>
        </p>
      </div>
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground hover:bg-muted/60 flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors"
        :aria-label="t('statistics.dailyReading.dayDetailClear')"
        @click="handleClose"
      >
        <X class="size-3.5" />
        <span class="hidden sm:inline">{{ t('statistics.dailyReading.dayDetailClear') }}</span>
      </button>
    </div>

    <div v-if="loading" class="flex flex-col gap-2" data-testid="day-detail-loading">
      <Skeleton class="h-12 w-full rounded-md" />
      <Skeleton class="h-12 w-full rounded-md" />
      <Skeleton class="h-12 w-full rounded-md" />
    </div>

    <div
      v-else-if="error"
      class="text-muted-foreground flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-md border"
      data-testid="day-detail-error"
    >
      <AlertCircle class="size-6" />
      <p class="text-sm">{{ t('statistics.dailyReading.dayDetailErrorTitle') }}</p>
      <button type="button" class="hover:bg-muted/60 rounded-md border px-2.5 py-1 text-xs transition-colors" @click="handleRetry">
        {{ t('statistics.dailyReading.dayDetailRetry') }}
      </button>
    </div>

    <div v-else-if="isEmpty" class="min-h-[160px]" data-testid="day-detail-empty">
      <ChartEmptyState
        :icon="Clock"
        :title="t('statistics.dailyReading.dayDetailEmptyTitle')"
        :description="t('statistics.dailyReading.dayDetailEmptyDescription')"
      />
    </div>

    <template v-else-if="detail">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span class="font-semibold tabular-nums">{{ formatDuration(detail.totalSeconds) }}</span>
        <span class="text-muted-foreground text-xs">{{
          t('statistics.dailyReading.dayDetailSessions', { count: detail.sessionsCount }, detail.sessionsCount)
        }}</span>
        <span v-for="total in sourceTotals" :key="total.key" class="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span class="size-2 shrink-0 rounded-full" :style="{ backgroundColor: total.color }" />
          {{ total.label }}
          <span class="tabular-nums">{{ total.duration }}</span>
        </span>
      </div>

      <ul class="flex flex-col gap-1.5">
        <li v-for="session in sessionRows" :key="session.key" class="hover:bg-muted/40 flex flex-col gap-1 rounded-md border p-2.5 transition-colors">
          <div class="flex items-start justify-between gap-2">
            <button
              type="button"
              class="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline"
              :aria-label="t('statistics.dailyReading.dayDetailOpenBook')"
              @click="openBook(session.bookId)"
            >
              {{ session.label }}
            </button>
            <span class="text-muted-foreground shrink-0 text-sm tabular-nums">{{ session.duration }}</span>
          </div>
          <div class="text-muted-foreground flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
            <span class="flex items-center gap-1">
              <span class="size-2 shrink-0 rounded-full" :style="{ backgroundColor: session.sourceColor }" />
              {{ session.sourceLabel }}
            </span>
            <span class="tabular-nums">{{ session.timeRange }}</span>
            <span v-if="session.format" class="bg-muted rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide">{{ session.format }}</span>
            <span v-if="session.progressDelta" class="tabular-nums">{{ session.progressDelta }}</span>
            <span v-if="session.endProgress" class="tabular-nums opacity-70">{{ session.endProgress }}</span>
          </div>
        </li>
      </ul>

      <p v-if="isTruncated" class="text-muted-foreground text-xs">
        {{ t('statistics.dailyReading.dayDetailTruncated', { count: MAX_SESSIONS }) }}
      </p>
    </template>
  </div>
</template>
