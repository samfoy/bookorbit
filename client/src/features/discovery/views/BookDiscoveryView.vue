<script setup lang="ts">
import type { BookAcquisitionSource, DiscoveryBrowseKind, ExternalBookSearchResult, ExternalCatalogSource } from '@bookorbit/types'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  ChartNoAxesColumnIncreasing,
  Database,
  Flame,
  LoaderCircle,
  Search,
  Sparkles,
  Telescope,
} from '@lucide/vue'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useLibraries } from '@/features/library/composables/useLibraries'
import AcquisitionQueue from '../components/AcquisitionQueue.vue'
import AcquisitionSheet from '../components/AcquisitionSheet.vue'
import DiscoveryBookCard from '../components/DiscoveryBookCard.vue'
import DiscoveryShelf from '../components/DiscoveryShelf.vue'
import { useBookDiscovery } from '../composables/useBookDiscovery'

defineOptions({ name: 'BookDiscoveryView' })

const { t } = useI18n()
const { hasPermission } = usePermissions()
const { libraries, fetchLibraries } = useLibraries()
const {
  query,
  selectedSources,
  results,
  sourceStatuses,
  searching,
  hasSearched,
  error,
  browseHome,
  activeBrowse,
  browseLoading,
  browseMoreLoading,
  browseError,
  acquisitionSources,
  jobs,
  acquisitionError,
  hasActiveJobs,
  search,
  loadBrowseHome,
  openBrowse,
  loadMoreBrowse,
  closeBrowse,
  toggleSource,
  loadAcquisitionState,
  acquire,
  refreshJobs,
  cancelJob,
} = useBookDiscovery()

const selectedBook = ref<ExternalBookSearchResult | null>(null)
const acquisitionOpen = ref(false)
const acquisitionSubmitting = ref(false)
let pollingTimer: ReturnType<typeof setInterval> | null = null

const canAcquire = computed(() => hasPermission('library_upload') && libraries.value.length > 0)
const canSearch = computed(() => query.value.trim().length >= 2 && selectedSources.value.length > 0 && !searching.value)
const resultSummary = computed(() => t('discovery.results.count', { count: results.value.length }))

onMounted(() => {
  void loadBrowseHome()
  if (hasPermission('library_upload')) void Promise.all([fetchLibraries(), loadAcquisitionState()])
})

watch(
  hasActiveJobs,
  (active) => {
    if (active && pollingTimer === null) pollingTimer = setInterval(() => void refreshJobs(), 2500)
    if (!active && pollingTimer !== null) {
      clearInterval(pollingTimer)
      pollingTimer = null
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  if (pollingTimer !== null) clearInterval(pollingTimer)
})

function isSourceSelected(source: ExternalCatalogSource): boolean {
  return selectedSources.value.includes(source)
}

function sourceLabel(source: ExternalCatalogSource): string {
  return t(`discovery.sources.${source}`)
}

function handleSearch() {
  void search()
}

function handleAcquire(book: ExternalBookSearchResult) {
  selectedBook.value = book
  acquisitionOpen.value = true
}

function handleOpenBrowse(kind: DiscoveryBrowseKind, value: string | null) {
  void openBrowse(kind, value)
}

function handleBrowseAuthor(author: string) {
  void openBrowse('author', author)
}

function handleBrowseGenre(genre: string) {
  void openBrowse('genre', genre)
}

function handleBrowseSimilar(hardcoverId: string) {
  void openBrowse('similar', hardcoverId)
}

function handleBackToBrowse() {
  closeBrowse()
}

function handleLoadMoreBrowse() {
  void loadMoreBrowse()
}

function handleAcquisitionOpen(open: boolean) {
  acquisitionOpen.value = open
  if (!open) selectedBook.value = null
}

async function handleAcquisitionConfirm(options: { libraryId: number; folderId?: number; source: BookAcquisitionSource }) {
  if (!selectedBook.value || acquisitionSubmitting.value) return
  acquisitionSubmitting.value = true
  try {
    await acquire(selectedBook.value, options)
    toast.success(t('discovery.toast.started', { title: selectedBook.value.title }))
    acquisitionOpen.value = false
    selectedBook.value = null
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : t('discovery.toast.startFailed'))
  } finally {
    acquisitionSubmitting.value = false
  }
}

async function handleCancel(jobId: string) {
  try {
    await cancelJob(jobId)
  } catch {
    toast.error(t('discovery.toast.cancelFailed'))
  }
}
</script>

<template>
  <main class="mx-auto w-full max-w-[96rem] space-y-6 pb-12">
    <section class="relative isolate overflow-hidden rounded-3xl border border-border/70 bg-card px-5 py-8 shadow-sm sm:px-8 sm:py-10 lg:px-12">
      <div class="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
      <div class="pointer-events-none absolute -bottom-36 left-1/4 h-72 w-72 rounded-full bg-secondary/60 blur-3xl" />
      <div class="relative grid items-end gap-8 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div class="max-w-3xl">
          <div
            class="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs font-semibold text-primary"
          >
            <Sparkles :size="14" />
            {{ t('discovery.eyebrow') }}
          </div>
          <h1 class="font-serif text-3xl font-semibold tracking-tight text-foreground sm:text-4xl lg:text-5xl">
            {{ t('discovery.title') }}
          </h1>
          <p class="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            {{ t('discovery.subtitle') }}
          </p>

          <form
            data-testid="discovery-search-form"
            class="mt-7 flex flex-col gap-3 rounded-2xl border border-border/80 bg-background/90 p-2 shadow-lg shadow-primary/5 backdrop-blur sm:flex-row"
            @submit.prevent="handleSearch"
          >
            <label class="flex min-w-0 flex-1 items-center gap-3 px-3" for="discovery-query">
              <Search :size="19" class="shrink-0 text-muted-foreground" />
              <span class="sr-only">{{ t('discovery.search.label') }}</span>
              <input
                id="discovery-query"
                v-model="query"
                data-testid="discovery-query"
                type="search"
                autocomplete="off"
                :placeholder="t('discovery.search.placeholder')"
                class="h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
              />
            </label>
            <Button type="submit" size="lg" class="h-11 rounded-xl px-6" :disabled="!canSearch">
              <LoaderCircle v-if="searching" :size="17" class="animate-spin" />
              <Telescope v-else :size="17" />
              {{ searching ? t('discovery.search.searching') : t('discovery.search.submit') }}
            </Button>
          </form>

          <div class="mt-4 flex flex-wrap items-center gap-2">
            <span class="mr-1 text-xs font-medium text-muted-foreground">{{ t('discovery.search.searchIn') }}</span>
            <button
              v-for="source in ['hardcover', 'storygraph'] as ExternalCatalogSource[]"
              :key="source"
              type="button"
              class="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :class="
                isSourceSelected(source)
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border bg-background/60 text-muted-foreground hover:text-foreground'
              "
              :aria-pressed="isSourceSelected(source)"
              @click="toggleSource(source)"
            >
              <Database v-if="source === 'hardcover'" :size="13" />
              <ChartNoAxesColumnIncreasing v-else :size="13" />
              {{ sourceLabel(source) }}
            </button>
          </div>
        </div>

        <div
          class="hidden h-28 w-28 items-center justify-center rounded-[2rem] border border-primary/15 bg-primary/5 text-primary shadow-inner lg:flex"
        >
          <Telescope :size="52" :stroke-width="1.25" />
        </div>
      </div>
    </section>

    <AcquisitionQueue :jobs="jobs" @cancel="handleCancel" />

    <div
      v-if="acquisitionError"
      class="flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
    >
      <AlertCircle :size="17" class="mt-0.5 shrink-0" />
      <p>{{ acquisitionError }}</p>
    </div>

    <div
      v-if="browseError"
      class="flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
    >
      <AlertCircle :size="17" class="mt-0.5 shrink-0" />
      <p>{{ browseError }}</p>
    </div>

    <section v-if="sourceStatuses.length > 0" class="flex flex-wrap items-center gap-2" :aria-label="t('discovery.sources.statusLabel')">
      <div
        v-for="status in sourceStatuses"
        :key="status.source"
        class="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card px-3 py-1.5 text-xs"
      >
        <span class="h-2 w-2 rounded-full" :class="status.available ? 'bg-primary' : 'bg-destructive'" />
        <span class="font-semibold">{{ sourceLabel(status.source) }}</span>
        <span class="text-muted-foreground">
          {{ status.available ? t('discovery.sources.results', { count: status.resultCount }) : status.message }}
        </span>
      </div>
    </section>

    <section v-if="activeBrowse" class="space-y-5">
      <div class="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card p-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Button variant="ghost" size="sm" class="-ml-2 mb-2 gap-1.5 text-muted-foreground" @click="handleBackToBrowse">
            <ArrowLeft :size="15" />
            {{ t('discovery.browse.back') }}
          </Button>
          <h2 class="font-serif text-3xl font-semibold tracking-tight">{{ activeBrowse.title }}</h2>
          <p v-if="activeBrowse.subtitle" class="mt-1 text-sm text-muted-foreground">{{ activeBrowse.subtitle }}</p>
        </div>
        <Badge variant="secondary" class="w-fit tabular-nums">{{ activeBrowse.items.length }}</Badge>
      </div>

      <div class="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        <DiscoveryBookCard
          v-for="book in activeBrowse.items"
          :key="book.id"
          :book="book"
          :can-acquire="canAcquire"
          @acquire="handleAcquire"
          @browse-author="handleBrowseAuthor"
          @browse-genre="handleBrowseGenre"
          @browse-similar="handleBrowseSimilar"
        />
      </div>

      <div v-if="activeBrowse.hasMore" class="flex justify-center pt-2">
        <Button variant="outline" size="lg" class="min-w-44 gap-2" :disabled="browseMoreLoading" @click="handleLoadMoreBrowse">
          <LoaderCircle v-if="browseMoreLoading" :size="16" class="animate-spin" />
          {{ browseMoreLoading ? t('discovery.browse.loadingMore') : t('discovery.browse.loadMore') }}
        </Button>
      </div>
    </section>

    <div v-else-if="error" class="flex flex-col items-center rounded-2xl border border-destructive/25 bg-destructive/5 px-6 py-12 text-center">
      <AlertCircle :size="30" class="text-destructive" />
      <h2 class="mt-3 font-serif text-xl font-semibold">{{ t('discovery.error.title') }}</h2>
      <p class="mt-1 max-w-lg text-sm text-muted-foreground">{{ error }}</p>
      <Button variant="outline" class="mt-5" @click="handleSearch">{{ t('discovery.error.retry') }}</Button>
    </div>

    <section v-else-if="searching || (browseLoading && !hasSearched)" class="space-y-4" aria-live="polite">
      <div class="flex items-center justify-between">
        <Skeleton class="h-6 w-40" />
        <Skeleton class="h-6 w-24 rounded-full" />
      </div>
      <div class="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        <div v-for="index in 10" :key="index" class="overflow-hidden rounded-2xl border border-border/70 bg-card">
          <Skeleton class="aspect-[2/3] w-full rounded-none" />
          <div class="space-y-3 p-4">
            <Skeleton class="h-5 w-4/5" />
            <Skeleton class="h-4 w-1/2" />
            <Skeleton class="h-16 w-full" />
          </div>
        </div>
      </div>
    </section>

    <section v-else-if="results.length > 0" class="space-y-4">
      <div class="flex items-center justify-between gap-3 px-1">
        <div>
          <h2 class="font-serif text-2xl font-semibold">{{ t('discovery.results.title') }}</h2>
          <p class="text-sm text-muted-foreground">{{ resultSummary }}</p>
        </div>
        <Badge variant="secondary" class="tabular-nums">{{ results.length }}</Badge>
      </div>
      <div class="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        <DiscoveryBookCard
          v-for="book in results"
          :key="book.id"
          :book="book"
          :can-acquire="canAcquire"
          @acquire="handleAcquire"
          @browse-author="handleBrowseAuthor"
          @browse-genre="handleBrowseGenre"
          @browse-similar="handleBrowseSimilar"
        />
      </div>
    </section>

    <section
      v-else-if="hasSearched"
      class="flex flex-col items-center rounded-3xl border border-dashed border-border bg-card/40 px-6 py-16 text-center"
    >
      <div class="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <Search :size="25" />
      </div>
      <h2 class="mt-4 font-serif text-2xl font-semibold">{{ t('discovery.empty.title') }}</h2>
      <p class="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">{{ t('discovery.empty.description') }}</p>
    </section>

    <section v-else-if="browseHome" class="space-y-10">
      <div class="overflow-hidden rounded-2xl border border-border/70 bg-card p-5 sm:p-6">
        <div class="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div class="max-w-xl">
            <div class="flex items-center gap-2 text-primary">
              <Flame :size="18" />
              <span class="text-xs font-semibold uppercase tracking-[0.18em]">{{ t('discovery.browse.explore') }}</span>
            </div>
            <h2 class="mt-2 font-serif text-2xl font-semibold">{{ t('discovery.browse.byGenre') }}</h2>
            <p class="mt-1 text-sm leading-relaxed text-muted-foreground">{{ t('discovery.browse.genreDescription') }}</p>
          </div>
          <div class="flex max-w-3xl flex-wrap gap-2">
            <button
              v-for="genre in browseHome.genres"
              :key="genre.slug"
              type="button"
              class="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:border-primary/35 hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              @click="handleBrowseGenre(genre.slug)"
            >
              {{ genre.name }}
            </button>
          </div>
        </div>
      </div>

      <DiscoveryShelf
        :section="browseHome.trending"
        :can-acquire="canAcquire"
        @view-all="handleOpenBrowse"
        @acquire="handleAcquire"
        @browse-author="handleBrowseAuthor"
        @browse-genre="handleBrowseGenre"
        @browse-similar="handleBrowseSimilar"
      />

      <DiscoveryShelf
        v-for="section in browseHome.genreShelves"
        :key="section.id"
        :section="section"
        :can-acquire="canAcquire"
        @view-all="handleOpenBrowse"
        @acquire="handleAcquire"
        @browse-author="handleBrowseAuthor"
        @browse-genre="handleBrowseGenre"
        @browse-similar="handleBrowseSimilar"
      />
    </section>

    <section v-else class="grid gap-4 md:grid-cols-3">
      <div class="rounded-2xl border border-border/70 bg-card p-5">
        <Database :size="21" class="text-primary" />
        <h2 class="mt-4 font-serif text-lg font-semibold">{{ t('discovery.intro.catalogs.title') }}</h2>
        <p class="mt-1 text-sm leading-relaxed text-muted-foreground">{{ t('discovery.intro.catalogs.description') }}</p>
      </div>
      <div class="rounded-2xl border border-border/70 bg-card p-5">
        <BookOpen :size="21" class="text-primary" />
        <h2 class="mt-4 font-serif text-lg font-semibold">{{ t('discovery.intro.acquire.title') }}</h2>
        <p class="mt-1 text-sm leading-relaxed text-muted-foreground">{{ t('discovery.intro.acquire.description') }}</p>
      </div>
      <div class="rounded-2xl border border-border/70 bg-card p-5">
        <Sparkles :size="21" class="text-primary" />
        <h2 class="mt-4 font-serif text-lg font-semibold">{{ t('discovery.intro.verify.title') }}</h2>
        <p class="mt-1 text-sm leading-relaxed text-muted-foreground">{{ t('discovery.intro.verify.description') }}</p>
      </div>
    </section>

    <AcquisitionSheet
      :open="acquisitionOpen"
      :book="selectedBook"
      :libraries="libraries"
      :capabilities="acquisitionSources"
      :submitting="acquisitionSubmitting"
      @update:open="handleAcquisitionOpen"
      @confirm="handleAcquisitionConfirm"
    />
  </main>
</template>
