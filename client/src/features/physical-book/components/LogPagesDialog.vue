<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Minus, Plus, X } from '@lucide/vue'

/**
 * Log a new current page for a physical book.
 *
 * This is the interaction Sam uses every day, so it is built for speed: the page
 * field autofocuses and selects, +/- steppers move by 1 and 10, and minutes is
 * optional. Minutes is what turns the update into a real reading session (and so
 * into streak/Daily Reading data); without it the change is treated as a
 * correction.
 */

const props = defineProps<{
  open: boolean
  currentPage: number
  pageCount: number | null
  saving: boolean
  error: string | null
}>()

const emit = defineEmits<{
  close: []
  submit: [payload: { currentPage: number; minutes?: number }]
}>()

const { t } = useI18n()

const page = ref(0)
const minutes = ref<number | null>(null)
const localError = ref<string | null>(null)
const pageInput = ref<HTMLInputElement | null>(null)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    page.value = props.currentPage
    minutes.value = null
    localError.value = null
    // Select the existing value so typing replaces it -- one gesture, not two.
    requestAnimationFrame(() => {
      pageInput.value?.focus()
      pageInput.value?.select()
    })
  },
)

const maxPage = computed(() => props.pageCount ?? null)

const pagesRead = computed(() => {
  const delta = page.value - props.currentPage
  return delta > 0 ? delta : 0
})

const percentage = computed(() => {
  const total = maxPage.value
  if (!total || total <= 0) return null
  return Math.max(0, Math.min(100, Math.round((page.value / total) * 1000) / 10))
})

const isFinishing = computed(() => percentage.value !== null && percentage.value >= 100)

function clamp(value: number): number {
  const total = maxPage.value
  const upper = total && total > 0 ? total : Number.MAX_SAFE_INTEGER
  return Math.max(0, Math.min(upper, Math.round(value)))
}

function bumpPage(delta: number) {
  page.value = clamp(page.value + delta)
}

function stepDownOne() {
  bumpPage(-1)
}

function stepUpOne() {
  bumpPage(1)
}

function stepDownTen() {
  bumpPage(-10)
}

function stepUpTen() {
  bumpPage(10)
}

function handleClose() {
  emit('close')
}

function handleSubmit() {
  localError.value = null
  const next = clamp(Number(page.value))
  if (!Number.isFinite(next)) {
    localError.value = t('physicalBook.logPages.invalidPage')
    return
  }
  // A decrease is only a correction, never a reading session: logging minutes
  // against negative progress would poison pace and the progress delta.
  if (next < props.currentPage && minutes.value !== null) {
    localError.value = t('physicalBook.logPages.decreaseWithMinutes')
    return
  }
  const mins = minutes.value
  if (mins !== null && (!Number.isFinite(mins) || mins < 1 || mins > 1440)) {
    localError.value = t('physicalBook.logPages.invalidMinutes')
    return
  }
  emit('submit', mins === null ? { currentPage: next } : { currentPage: next, minutes: Math.round(mins) })
}

const shownError = computed(() => localError.value ?? props.error)
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
    role="dialog"
    aria-modal="true"
    :aria-label="t('physicalBook.logPages.title')"
  >
    <div class="w-full max-w-md rounded-t-2xl bg-card p-5 shadow-xl sm:rounded-2xl">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-base font-semibold text-foreground">{{ t('physicalBook.logPages.title') }}</h2>
        <button
          type="button"
          class="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          :aria-label="t('common.close')"
          @click="handleClose"
        >
          <X class="size-4" />
        </button>
      </div>

      <label class="mb-1 block text-xs font-medium text-muted-foreground" for="physical-page-input">
        {{ t('physicalBook.logPages.currentPage') }}
      </label>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex size-11 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          :aria-label="t('physicalBook.logPages.minusTen')"
          @click="stepDownTen"
        >
          <span class="text-xs font-semibold">-10</span>
        </button>
        <button
          type="button"
          class="flex size-11 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          :aria-label="t('physicalBook.logPages.minusOne')"
          @click="stepDownOne"
        >
          <Minus class="size-4" />
        </button>
        <input
          id="physical-page-input"
          ref="pageInput"
          v-model.number="page"
          type="number"
          inputmode="numeric"
          min="0"
          :max="maxPage ?? undefined"
          class="h-14 min-w-0 flex-1 rounded-lg border border-border bg-background text-center text-2xl font-semibold tabular-nums text-foreground"
        />
        <button
          type="button"
          class="flex size-11 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          :aria-label="t('physicalBook.logPages.plusOne')"
          @click="stepUpOne"
        >
          <Plus class="size-4" />
        </button>
        <button
          type="button"
          class="flex size-11 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          :aria-label="t('physicalBook.logPages.plusTen')"
          @click="stepUpTen"
        >
          <span class="text-xs font-semibold">+10</span>
        </button>
      </div>

      <p v-if="maxPage" class="mt-2 text-xs text-muted-foreground">
        {{ t('physicalBook.logPages.ofPages', { count: maxPage }) }}
        <span v-if="percentage !== null" class="ml-1 tabular-nums">· {{ percentage }}%</span>
      </p>
      <p v-else class="mt-2 text-xs text-muted-foreground">{{ t('physicalBook.logPages.noPageCount') }}</p>

      <div v-if="percentage !== null" class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div class="h-full rounded-full bg-primary transition-[width]" :style="{ width: `${percentage}%` }" />
      </div>

      <label class="mt-4 mb-1 block text-xs font-medium text-muted-foreground" for="physical-minutes-input">
        {{ t('physicalBook.logPages.minutesOptional') }}
      </label>
      <input
        id="physical-minutes-input"
        v-model.number="minutes"
        type="number"
        inputmode="numeric"
        min="1"
        max="1440"
        :placeholder="t('physicalBook.logPages.minutesPlaceholder')"
        class="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
      />
      <p class="mt-1 text-xs text-muted-foreground">{{ t('physicalBook.logPages.minutesHint') }}</p>

      <p v-if="pagesRead > 0" class="mt-3 text-xs text-muted-foreground">
        {{ t('physicalBook.logPages.pagesReadSummary', { count: pagesRead }) }}
      </p>
      <p v-if="isFinishing" class="mt-1 text-xs text-[var(--success)]">
        {{ t('physicalBook.logPages.willFinish') }}
      </p>
      <p v-if="shownError" class="mt-3 text-xs text-[var(--error)]">{{ shownError }}</p>

      <div class="mt-5 flex justify-end gap-2">
        <button
          type="button"
          class="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          @click="handleClose"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          :disabled="saving"
          @click="handleSubmit"
        >
          {{ saving ? t('physicalBook.common.saving') : t('physicalBook.logPages.save') }}
        </button>
      </div>
    </div>
  </div>
</template>
