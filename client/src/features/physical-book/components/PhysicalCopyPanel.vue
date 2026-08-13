<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookMarked, CalendarClock, MapPin, RotateCcw } from '@lucide/vue'

import type { LoanUrgency, PhysicalCopySummary } from '@bookorbit/types'

/**
 * Book-detail panel for a physical copy.
 *
 * Shows the copy facts (binding, shelf location, acquisition) and, for a loan,
 * the pace-aware encouragement block: due date, urgency, and how many pages a day
 * are needed to finish in time. Every derived number comes from the server, whose
 * day math runs in the user's profile timezone -- recomputing here would risk a
 * different answer near midnight.
 */

const props = defineProps<{
  copy: PhysicalCopySummary
  saving: boolean
}>()

const emit = defineEmits<{
  logPages: []
  markReturned: []
  edit: []
}>()

const { t } = useI18n()

const URGENCY_CLASSES: Record<LoanUrgency, string> = {
  overdue: 'border-[var(--urgency-overdue)]/40 bg-[var(--urgency-overdue)]/10 text-[var(--urgency-overdue)]',
  urgent: 'border-[var(--urgency-urgent)]/40 bg-[var(--urgency-urgent)]/10 text-[var(--urgency-urgent)]',
  tight: 'border-[var(--urgency-tight)]/40 bg-[var(--urgency-tight)]/10 text-[var(--urgency-tight)]',
  comfortable: 'border-[var(--urgency-comfortable)]/40 bg-[var(--urgency-comfortable)]/10 text-[var(--urgency-comfortable)]',
}

const isLoan = computed(() => props.copy.acquisition !== 'owned')
const isReturned = computed(() => props.copy.returnedOn !== null)

const percentageLabel = computed(() => (props.copy.percentage === null ? null : `${Math.round(props.copy.percentage * 10) / 10}%`))

const progressWidth = computed(() => `${Math.max(0, Math.min(100, props.copy.percentage ?? 0))}%`)

const acquisitionLabel = computed(() => t(`physicalBook.acquisition.${props.copy.acquisition}`))

const bindingLabel = computed(() => (props.copy.binding ? t(`physicalBook.binding.${props.copy.binding}`) : null))

const dueLabel = computed(() => {
  const days = props.copy.daysRemaining
  if (days === null) return null
  if (days < 0) return t('physicalBook.panel.overdueBy', { count: Math.abs(days) })
  if (days === 0) return t('physicalBook.panel.dueToday')
  if (days === 1) return t('physicalBook.panel.dueTomorrow')
  return t('physicalBook.panel.dueInDays', { count: days })
})

/**
 * The encouragement line. Deliberately frames the loan as a pace rather than a
 * deadline -- "about 32 pages a day" is actionable, "due Friday" is not.
 */
const paceLabel = computed(() => {
  const { pagesRemaining, pagesPerDayNeeded, onTrack, paceLast7Days } = props.copy
  if (pagesRemaining === null || pagesPerDayNeeded === null) return t('physicalBook.panel.noPageCount')
  if (pagesRemaining === 0) return t('physicalBook.panel.finished')
  if (onTrack) return t('physicalBook.panel.onTrack', { count: Math.round(paceLast7Days) })
  return t('physicalBook.panel.needPace', { need: pagesPerDayNeeded, pace: Math.round(paceLast7Days) })
})

function handleLogPages() {
  emit('logPages')
}

function handleMarkReturned() {
  emit('markReturned')
}

function handleEdit() {
  emit('edit')
}
</script>

<template>
  <section class="rounded-xl border border-border bg-card p-4">
    <header class="mb-3 flex items-center justify-between gap-2">
      <h3 class="flex items-center gap-2 text-sm font-semibold text-foreground">
        <BookMarked class="size-4 text-muted-foreground" />
        {{ t('physicalBook.panel.title') }}
      </h3>
      <span class="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
        {{ acquisitionLabel }}
      </span>
    </header>

    <div class="mb-3">
      <div class="mb-1 flex items-baseline justify-between text-xs text-muted-foreground">
        <span class="tabular-nums">
          {{
            copy.effectivePageCount
              ? t('physicalBook.panel.pageOf', { page: copy.currentPage, total: copy.effectivePageCount })
              : t('physicalBook.panel.pageOnly', { page: copy.currentPage })
          }}
        </span>
        <span v-if="percentageLabel" class="tabular-nums">{{ percentageLabel }}</span>
      </div>
      <div v-if="copy.percentage !== null" class="h-1.5 overflow-hidden rounded-full bg-muted">
        <div class="h-full rounded-full bg-primary" :style="{ width: progressWidth }" />
      </div>
    </div>

    <div v-if="isLoan && !isReturned" class="mb-3 rounded-lg border border-border bg-background p-3">
      <div class="mb-1 flex items-center gap-2">
        <CalendarClock class="size-3.5 text-muted-foreground" />
        <span v-if="copy.urgency" :class="['rounded-full border px-2 py-0.5 text-[11px]', URGENCY_CLASSES[copy.urgency]]">
          {{ dueLabel }}
        </span>
        <span v-else class="text-xs text-muted-foreground">{{ t('physicalBook.panel.noDueDate') }}</span>
      </div>
      <p class="text-xs text-muted-foreground">{{ paceLabel }}</p>
      <p v-if="copy.lender" class="mt-1 text-[11px] text-muted-foreground">
        {{ t('physicalBook.panel.from', { lender: copy.lender }) }}
        <span v-if="copy.renewalLimit !== null" class="ml-1">
          · {{ t('physicalBook.panel.renewals', { used: copy.renewalsUsed, limit: copy.renewalLimit }) }}
        </span>
      </p>
    </div>

    <p v-if="isReturned" class="mb-3 text-xs text-muted-foreground">
      {{ t('physicalBook.panel.returnedOn', { date: copy.returnedOn }) }}
    </p>

    <dl class="mb-4 grid grid-cols-2 gap-2 text-xs">
      <div v-if="bindingLabel">
        <dt class="text-muted-foreground">{{ t('physicalBook.panel.binding') }}</dt>
        <dd class="text-foreground">{{ bindingLabel }}</dd>
      </div>
      <div v-if="copy.shelfLocation">
        <dt class="flex items-center gap-1 text-muted-foreground">
          <MapPin class="size-3" />
          {{ t('physicalBook.panel.shelf') }}
        </dt>
        <dd class="text-foreground">{{ copy.shelfLocation }}</dd>
      </div>
    </dl>

    <div class="flex flex-wrap gap-2">
      <button
        type="button"
        class="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        :disabled="saving"
        @click="handleLogPages"
      >
        {{ t('physicalBook.panel.logPages') }}
      </button>
      <button
        type="button"
        class="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        @click="handleEdit"
      >
        {{ t('physicalBook.panel.edit') }}
      </button>
      <button
        v-if="isLoan && !isReturned"
        type="button"
        class="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        :disabled="saving"
        @click="handleMarkReturned"
      >
        <RotateCcw class="size-3.5" />
        {{ t('physicalBook.panel.markReturned') }}
      </button>
    </div>
  </section>
</template>
