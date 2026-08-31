<script setup lang="ts">
import type { BookAcquisitionSource, BookAcquisitionSourceCapability, ExternalBookSearchResult, Library } from '@bookorbit/types'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Check, Download, KeyRound, LoaderCircle, ShieldCheck, Zap } from '@lucide/vue'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'

const props = defineProps<{
  open: boolean
  book: ExternalBookSearchResult | null
  libraries: Library[]
  capabilities: BookAcquisitionSourceCapability[]
  submitting: boolean
}>()

const emit = defineEmits<{
  'update:open': [open: boolean]
  confirm: [options: { libraryId: number; folderId?: number; source: BookAcquisitionSource }]
}>()

const { t } = useI18n()
const selectedLibraryId = ref<number | ''>('')
const selectedFolderId = ref<number | ''>('')
const selectedSource = ref<BookAcquisitionSource>('auto')

const selectedLibrary = computed(() => props.libraries.find((library) => library.id === selectedLibraryId.value) ?? null)
const folders = computed(() => selectedLibrary.value?.folders ?? [])
const canSubmit = computed(() => typeof selectedLibraryId.value === 'number' && !props.submitting)
const sourceOptions = computed(() => [
  {
    source: 'auto' as const,
    available: true,
    label: t('discovery.acquire.sources.auto'),
    message: t('discovery.acquire.sources.autoDescription'),
  },
  ...props.capabilities,
])
const selectedSourceInfo = computed(() => sourceOptions.value.find((source) => source.source === selectedSource.value) ?? sourceOptions.value[0])

watch(
  [() => props.open, () => props.book?.id, () => props.libraries],
  ([open]) => {
    if (!open) return
    selectedLibraryId.value = props.libraries[0]?.id ?? ''
    selectedFolderId.value = props.libraries[0]?.folders[0]?.id ?? ''
    selectedSource.value = 'auto'
  },
  { immediate: true, deep: true },
)

watch(selectedLibraryId, () => {
  selectedFolderId.value = selectedLibrary.value?.folders[0]?.id ?? ''
})

function handleOpenChange(open: boolean) {
  emit('update:open', open)
}

function handleSubmit() {
  if (typeof selectedLibraryId.value !== 'number' || !props.book) return
  emit('confirm', {
    libraryId: selectedLibraryId.value,
    ...(typeof selectedFolderId.value === 'number' ? { folderId: selectedFolderId.value } : {}),
    source: selectedSource.value,
  })
}
</script>

<template>
  <Sheet :open="open" @update:open="handleOpenChange">
    <SheetContent class="w-full overflow-y-auto sm:max-w-lg">
      <SheetHeader class="border-b border-border/60 pb-5 text-left">
        <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Download :size="19" />
        </div>
        <SheetTitle class="font-serif text-2xl">{{ t('discovery.acquire.title') }}</SheetTitle>
        <SheetDescription>{{ t('discovery.acquire.description') }}</SheetDescription>
      </SheetHeader>

      <form class="flex flex-1 flex-col gap-6 px-4 py-5" @submit.prevent="handleSubmit">
        <div v-if="book" class="flex gap-4 rounded-xl border border-border/70 bg-muted/35 p-3">
          <div class="flex h-24 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted shadow-sm">
            <img
              v-if="book.coverUrl"
              :src="book.coverUrl"
              :alt="t('discovery.card.coverAlt', { title: book.title })"
              class="h-full w-full object-cover"
            />
            <BookOpen v-else :size="24" class="text-muted-foreground" />
          </div>
          <div class="min-w-0 py-1">
            <p class="line-clamp-2 font-serif text-lg font-semibold leading-tight">{{ book.title }}</p>
            <p class="mt-1 line-clamp-1 text-sm text-muted-foreground">{{ book.authors.join(', ') }}</p>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <Badge v-if="book.isbn13" variant="outline" class="font-mono text-[10px]">ISBN {{ book.isbn13 }}</Badge>
              <Badge variant="secondary" class="text-[10px]">EPUB</Badge>
            </div>
          </div>
        </div>

        <div class="space-y-2">
          <label for="acquisition-library" class="text-sm font-semibold">{{ t('discovery.acquire.library') }}</label>
          <select
            id="acquisition-library"
            v-model.number="selectedLibraryId"
            class="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option disabled value="">{{ t('discovery.acquire.chooseLibrary') }}</option>
            <option v-for="library in libraries" :key="library.id" :value="library.id">{{ library.name }}</option>
          </select>
        </div>

        <div v-if="folders.length > 1" class="space-y-2">
          <label for="acquisition-folder" class="text-sm font-semibold">{{ t('discovery.acquire.folder') }}</label>
          <select
            id="acquisition-folder"
            v-model.number="selectedFolderId"
            class="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option v-for="folder in folders" :key="folder.id" :value="folder.id">{{ folder.path }}</option>
          </select>
        </div>

        <div class="space-y-2">
          <label for="acquisition-source" class="text-sm font-semibold">{{ t('discovery.acquire.source') }}</label>
          <select
            id="acquisition-source"
            v-model="selectedSource"
            data-testid="acquisition-source"
            class="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option v-for="source in sourceOptions" :key="source.source" :value="source.source" :disabled="!source.available">
              {{ source.label }}{{ source.available ? '' : ` (${t('discovery.acquire.unavailable')})` }}
            </option>
          </select>
          <p class="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <KeyRound v-if="selectedSource === 'annas_archive'" :size="14" class="mt-0.5 shrink-0" />
            <Zap v-else :size="14" class="mt-0.5 shrink-0" />
            {{ selectedSourceInfo?.message }}
          </p>
        </div>

        <div class="rounded-xl border border-primary/20 bg-primary/5 p-3.5">
          <div class="flex items-start gap-3">
            <ShieldCheck :size="18" class="mt-0.5 shrink-0 text-primary" />
            <div>
              <p class="text-sm font-semibold">{{ t('discovery.acquire.verifiedTitle') }}</p>
              <p class="mt-1 text-xs leading-relaxed text-muted-foreground">{{ t('discovery.acquire.verifiedDescription') }}</p>
            </div>
          </div>
        </div>

        <SheetFooter class="mt-auto gap-2 px-0 pt-2 sm:flex-col">
          <Button data-testid="confirm-acquisition" type="button" class="w-full gap-2" :disabled="!canSubmit" @click="handleSubmit">
            <LoaderCircle v-if="submitting" :size="15" class="animate-spin" />
            <Check v-else :size="15" />
            {{ submitting ? t('discovery.acquire.starting') : t('discovery.acquire.confirm') }}
          </Button>
          <p class="text-center text-[11px] leading-relaxed text-muted-foreground">{{ t('discovery.acquire.backgroundHint') }}</p>
        </SheetFooter>
      </form>
    </SheetContent>
  </Sheet>
</template>
