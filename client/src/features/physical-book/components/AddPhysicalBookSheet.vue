<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Camera, CameraOff, Loader2, X } from '@lucide/vue'

import type { MetadataCandidate, PhysicalAcquisition } from '@bookorbit/types'

import { formatIsbn, isValidIsbn, normalizeIsbn } from '../lib/isbn'
import { useBarcodeScanner } from '../composables/useBarcodeScanner'

/**
 * Add a physical book: scan a barcode, type an ISBN, or paste a batch.
 *
 * The camera stays open after a successful scan so a stack of books can be worked
 * through in one pass. Every decode is checksum-validated locally before it is
 * accepted, so a misread never triggers a lookup.
 */

const props = defineProps<{
  open: boolean
  libraryId: number | null
  saving: boolean
  error: string | null
  candidate: MetadataCandidate | null
  looking: boolean
  conflictBookId: number | null
}>()

const emit = defineEmits<{
  close: []
  lookup: [isbn: string]
  submit: [payload: { isbn?: string; title?: string; author?: string; acquisition: PhysicalAcquisition; lender?: string; dueOn?: string; pageCount?: number }]
  bulk: [payload: { isbns: string[]; acquisition: PhysicalAcquisition; lender?: string }]
  openBook: [bookId: number]
}>()

const { t } = useI18n()

type Mode = 'single' | 'batch'
const mode = ref<Mode>('single')
const isbn = ref('')
const title = ref('')
const author = ref('')
const acquisition = ref<PhysicalAcquisition>('owned')
const lender = ref('')
const dueOn = ref('')
const pageCount = ref<number | null>(null)
const batchText = ref('')
const localError = ref<string | null>(null)
const scannedCount = ref(0)

const isLoan = computed(() => acquisition.value !== 'owned')

const { status: scanStatus, error: scanError, lastRejected, videoEl, start: startScan, stop: stopScan } = useBarcodeScanner({
  onIsbn: (found) => {
    isbn.value = found
    scannedCount.value += 1
    if (mode.value === 'batch') {
      // Append to the batch list instead of looking each one up, so scanning a
      // shelf never blocks on the network.
      const existing = batchText.value.split(/\s+/).filter(Boolean)
      if (!existing.includes(found)) batchText.value = [...existing, found].join('\n')
      return
    }
    emit('lookup', found)
  },
})

watch(
  () => props.open,
  (open) => {
    if (open) {
      localError.value = null
      scannedCount.value = 0
      return
    }
    // Always release the camera when the sheet closes.
    stopScan()
    isbn.value = ''
    title.value = ''
    author.value = ''
    lender.value = ''
    dueOn.value = ''
    pageCount.value = null
    batchText.value = ''
    mode.value = 'single'
    acquisition.value = 'owned'
  },
)

const normalizedIsbn = computed(() => normalizeIsbn(isbn.value))
const isbnLooksValid = computed(() => (isbn.value ? isValidIsbn(isbn.value) : false))

const batchIsbns = computed(() =>
  batchText.value
    .split(/[\s,]+/)
    .map((entry) => normalizeIsbn(entry))
    .filter((entry): entry is string => entry !== null && isValidIsbn(entry)),
)

const batchRejected = computed(() => {
  const raw = batchText.value.split(/[\s,]+/).filter(Boolean)
  return raw.length - batchIsbns.value.length
})

function setModeSingle() {
  mode.value = 'single'
}

function setModeBatch() {
  mode.value = 'batch'
}

function handleClose() {
  emit('close')
}

function handleLookup() {
  localError.value = null
  if (!isbnLooksValid.value) {
    localError.value = t('physicalBook.add.invalidIsbn')
    return
  }
  emit('lookup', normalizedIsbn.value as string)
}

async function handleToggleCamera() {
  if (scanStatus.value === 'scanning' || scanStatus.value === 'starting') {
    stopScan()
    return
  }
  await startScan()
}

function handleOpenConflict() {
  if (props.conflictBookId !== null) emit('openBook', props.conflictBookId)
}

function handleSubmit() {
  localError.value = null
  if (props.libraryId === null) {
    localError.value = t('physicalBook.add.noLibrary')
    return
  }
  if (isLoan.value && !lender.value.trim()) {
    localError.value = t('physicalBook.add.lenderRequired')
    return
  }

  if (mode.value === 'batch') {
    if (batchIsbns.value.length === 0) {
      localError.value = t('physicalBook.add.noValidIsbns')
      return
    }
    emit('bulk', {
      isbns: batchIsbns.value,
      acquisition: acquisition.value,
      ...(isLoan.value ? { lender: lender.value.trim() } : {}),
    })
    return
  }

  const hasIsbn = isbnLooksValid.value
  const hasTitle = title.value.trim().length > 0
  if (!hasIsbn && !hasTitle) {
    localError.value = t('physicalBook.add.needIsbnOrTitle')
    return
  }

  emit('submit', {
    ...(hasIsbn ? { isbn: normalizedIsbn.value as string } : {}),
    ...(hasTitle ? { title: title.value.trim() } : {}),
    ...(author.value.trim() ? { author: author.value.trim() } : {}),
    acquisition: acquisition.value,
    ...(isLoan.value ? { lender: lender.value.trim() } : {}),
    ...(dueOn.value ? { dueOn: dueOn.value } : {}),
    ...(pageCount.value ? { pageCount: pageCount.value } : {}),
  })
}

const shownError = computed(() => localError.value ?? props.error ?? scanError.value)
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
    role="dialog"
    aria-modal="true"
    :aria-label="t('physicalBook.add.title')"
  >
    <div class="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-card p-5 shadow-xl sm:rounded-2xl">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-base font-semibold text-foreground">{{ t('physicalBook.add.title') }}</h2>
        <button
          type="button"
          class="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          :aria-label="t('common.close')"
          @click="handleClose"
        >
          <X class="size-4" />
        </button>
      </div>

      <div class="mb-4 flex gap-1 rounded-lg border border-border p-1">
        <button
          type="button"
          :class="[
            'flex-1 rounded-md px-3 py-1.5 text-xs',
            mode === 'single' ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
          ]"
          @click="setModeSingle"
        >
          {{ t('physicalBook.add.modeSingle') }}
        </button>
        <button
          type="button"
          :class="[
            'flex-1 rounded-md px-3 py-1.5 text-xs',
            mode === 'batch' ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
          ]"
          @click="setModeBatch"
        >
          {{ t('physicalBook.add.modeBatch') }}
        </button>
      </div>

      <div class="mb-3">
        <button
          type="button"
          class="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          @click="handleToggleCamera"
        >
          <Camera v-if="scanStatus !== 'scanning'" class="size-4" />
          <CameraOff v-else class="size-4" />
          {{ scanStatus === 'scanning' ? t('physicalBook.add.stopCamera') : t('physicalBook.add.startCamera') }}
        </button>
        <p v-if="scanStatus === 'unsupported'" class="mt-1 text-[11px] text-muted-foreground">
          {{ t('physicalBook.add.cameraUnsupported') }}
        </p>
      </div>

      <div v-show="scanStatus === 'scanning' || scanStatus === 'starting'" class="mb-3">
        <video ref="videoEl" class="h-44 w-full rounded-lg bg-black object-cover" muted playsinline />
        <p class="mt-1 text-[11px] text-muted-foreground">
          {{ t('physicalBook.add.scanHint') }}
          <span v-if="scannedCount > 0" class="ml-1">· {{ t('physicalBook.add.scannedCount', { count: scannedCount }) }}</span>
        </p>
        <p v-if="lastRejected" class="mt-1 text-[11px] text-[var(--warning)]">
          {{ t('physicalBook.add.rejectedScan') }}
        </p>
      </div>

      <template v-if="mode === 'single'">
        <label class="mb-1 block text-xs font-medium text-muted-foreground" for="physical-isbn">
          {{ t('physicalBook.add.isbn') }}
        </label>
        <div class="flex gap-2">
          <input
            id="physical-isbn"
            v-model="isbn"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            :placeholder="t('physicalBook.add.isbnPlaceholder')"
            class="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
          />
          <button
            type="button"
            class="rounded-lg border border-border px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            :disabled="looking || !isbnLooksValid"
            @click="handleLookup"
          >
            <Loader2 v-if="looking" class="size-4 animate-spin" />
            <span v-else>{{ t('physicalBook.add.lookup') }}</span>
          </button>
        </div>
        <p v-if="isbn && !isbnLooksValid" class="mt-1 text-[11px] text-[var(--warning)]">
          {{ t('physicalBook.add.checksumFailed') }}
        </p>
        <p v-else-if="normalizedIsbn" class="mt-1 text-[11px] text-muted-foreground tabular-nums">
          {{ formatIsbn(normalizedIsbn) }}
        </p>

        <div v-if="conflictBookId !== null" class="mt-3 rounded-lg border border-border bg-background p-3">
          <p class="text-xs text-foreground">{{ t('physicalBook.add.alreadyOnShelf') }}</p>
          <button type="button" class="mt-1 text-xs text-primary underline" @click="handleOpenConflict">
            {{ t('physicalBook.add.openExisting') }}
          </button>
        </div>

        <div v-if="candidate" class="mt-3 flex gap-3 rounded-lg border border-border bg-background p-3">
          <img
            v-if="candidate.coverUrl"
            :src="candidate.coverUrl"
            alt=""
            class="h-20 w-14 flex-none rounded object-cover"
          />
          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-foreground">{{ candidate.title }}</p>
            <p v-if="candidate.authors?.length" class="truncate text-xs text-muted-foreground">
              {{ candidate.authors.join(', ') }}
            </p>
            <p v-if="candidate.pageCount" class="text-[11px] text-muted-foreground">
              {{ t('physicalBook.add.pageCountFound', { count: candidate.pageCount }) }}
            </p>
          </div>
        </div>

        <details class="mt-3">
          <summary class="cursor-pointer text-xs text-muted-foreground">{{ t('physicalBook.add.manualEntry') }}</summary>
          <div class="mt-2 space-y-2">
            <input
              v-model="title"
              type="text"
              :placeholder="t('physicalBook.add.titlePlaceholder')"
              class="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
            />
            <input
              v-model="author"
              type="text"
              :placeholder="t('physicalBook.add.authorPlaceholder')"
              class="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
            />
            <input
              v-model.number="pageCount"
              type="number"
              min="1"
              :placeholder="t('physicalBook.add.pageCountPlaceholder')"
              class="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
            />
          </div>
        </details>
      </template>

      <template v-else>
        <label class="mb-1 block text-xs font-medium text-muted-foreground" for="physical-batch">
          {{ t('physicalBook.add.batchLabel') }}
        </label>
        <textarea
          id="physical-batch"
          v-model="batchText"
          rows="6"
          :placeholder="t('physicalBook.add.batchPlaceholder')"
          class="w-full rounded-lg border border-border bg-background p-3 font-mono text-xs text-foreground"
        />
        <p class="mt-1 text-[11px] text-muted-foreground">
          {{ t('physicalBook.add.batchValid', { count: batchIsbns.length }) }}
          <span v-if="batchRejected > 0" class="ml-1 text-[var(--warning)]">
            · {{ t('physicalBook.add.batchRejected', { count: batchRejected }) }}
          </span>
        </p>
      </template>

      <label class="mt-4 mb-1 block text-xs font-medium text-muted-foreground" for="physical-acquisition">
        {{ t('physicalBook.add.acquisition') }}
      </label>
      <select
        id="physical-acquisition"
        v-model="acquisition"
        class="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
      >
        <option value="owned">{{ t('physicalBook.acquisition.owned') }}</option>
        <option value="borrowed_library">{{ t('physicalBook.acquisition.borrowed_library') }}</option>
        <option value="borrowed_personal">{{ t('physicalBook.acquisition.borrowed_personal') }}</option>
      </select>

      <div v-if="isLoan" class="mt-3 space-y-2">
        <input
          v-model="lender"
          type="text"
          :placeholder="t('physicalBook.add.lenderPlaceholder')"
          class="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
        />
        <div>
          <label class="mb-1 block text-xs font-medium text-muted-foreground" for="physical-due">
            {{ t('physicalBook.add.dueOn') }}
          </label>
          <input
            id="physical-due"
            v-model="dueOn"
            type="date"
            class="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
          />
        </div>
      </div>

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
          {{ saving ? t('physicalBook.common.saving') : t('physicalBook.add.save') }}
        </button>
      </div>
    </div>
  </div>
</template>
