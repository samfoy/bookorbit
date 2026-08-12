<script setup lang="ts">
import { CalendarClock } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import type { DueSoonEntry, LoanUrgency } from '@bookorbit/types'
import BookCoverArtwork from '@/features/book/components/BookCoverArtwork.vue'
import BookCoverSurface from '@/features/book/components/BookCoverSurface.vue'
import { useDueSoonWidget } from '../../composables/useDueSoonWidget'

const { data, loading, error } = useDueSoonWidget()
const { t } = useI18n()
const router = useRouter()

const URGENCY_CLASSES: Record<LoanUrgency, string> = {
  overdue: 'border-[var(--urgency-overdue)]/40 bg-[var(--urgency-overdue)]/10 text-[var(--urgency-overdue)]',
  urgent: 'border-[var(--urgency-urgent)]/40 bg-[var(--urgency-urgent)]/10 text-[var(--urgency-urgent)]',
  tight: 'border-[var(--urgency-tight)]/40 bg-[var(--urgency-tight)]/10 text-[var(--urgency-tight)]',
  comfortable: 'border-[var(--urgency-comfortable)]/40 bg-[var(--urgency-comfortable)]/10 text-[var(--urgency-comfortable)]',
}

function dueLabel(entry: DueSoonEntry): string {
  if (entry.daysRemaining < 0) return t('dashboard.widgets.dueSoon.overdue')
  if (entry.daysRemaining === 0) return t('dashboard.widgets.dueSoon.dueToday')
  if (entry.daysRemaining === 1) return t('dashboard.widgets.dueSoon.dueTomorrow')
  return t('dashboard.widgets.dueSoon.dueInDays', { count: entry.daysRemaining })
}

function paceLabel(entry: DueSoonEntry): string {
  if (entry.pagesRemaining === null || entry.pagesPerDayNeeded === null) return t('dashboard.widgets.dueSoon.noPageCount')
  if (entry.pagesRemaining === 0) return t('dashboard.widgets.dueSoon.finished')
  if (entry.onTrack) return t('dashboard.widgets.dueSoon.onTrack')
  return t('dashboard.widgets.dueSoon.pacePerDay', { count: entry.pagesPerDayNeeded })
}

function goToBook(bookId: number) {
  void router.push({ name: 'book-detail', params: { bookId } })
}
</script>

<template>
  <div class="flex h-full flex-col p-3">
    <div class="mb-3 flex items-center gap-2 self-start">
      <CalendarClock :size="16" class="text-primary" />
      <span class="text-[15px] font-semibold text-foreground">{{ t('dashboard.widgets.dueSoon.title') }}</span>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex flex-1 flex-col gap-2">
      <div v-for="n in 3" :key="n" class="h-10 animate-pulse rounded bg-muted" />
    </div>

    <!-- Error -->
    <div v-else-if="error" class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {{ t('dashboard.common.failedToLoad') }}
    </div>

    <!-- Empty -->
    <div v-else-if="!data || data.entries.length === 0" class="flex flex-1 flex-col items-center justify-center gap-2">
      <div class="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
        <CalendarClock :size="16" class="text-muted-foreground" />
      </div>
      <p class="text-center text-xs text-muted-foreground">{{ t('dashboard.widgets.dueSoon.empty') }}</p>
    </div>

    <!-- Loans -->
    <ul v-else class="flex flex-1 flex-col gap-2 overflow-y-auto">
      <li v-for="entry in data.entries" :key="entry.bookId">
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 rounded-md p-1 text-left transition-colors hover:bg-muted"
          @click="goToBook(entry.bookId)"
        >
          <BookCoverSurface size="mini" class="book-cover-surface--spine-fitted h-11 w-8 shrink-0 overflow-hidden rounded">
            <BookCoverArtwork
              :src="entry.coverUrl"
              :has-cover="entry.coverUrl !== null"
              :title="entry.title"
              :author-line="entry.authorName"
              :is-audio="false"
              :seed="entry.title"
              :alt="entry.title"
              frame-aspect-ratio="8/11"
            />
          </BookCoverSurface>
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-semibold">{{ entry.title }}</p>
            <p class="truncate text-[11px] text-muted-foreground">
              <span v-if="entry.pagesRemaining !== null && entry.pagesRemaining > 0">
                {{ t('dashboard.widgets.dueSoon.pagesLeft', { count: entry.pagesRemaining }) }}
                &middot;
              </span>
              {{ paceLabel(entry) }}
            </p>
          </div>
          <span class="shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium" :class="URGENCY_CLASSES[entry.urgency]">
            {{ dueLabel(entry) }}
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>
