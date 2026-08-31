<script setup lang="ts">
import type { ExternalBookSearchResult } from '@bookorbit/types'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Download, ExternalLink, Sparkles, Star } from '@lucide/vue'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  book: ExternalBookSearchResult
  canAcquire: boolean
}>()

const emit = defineEmits<{
  acquire: [book: ExternalBookSearchResult]
  'browse-author': [author: string]
  'browse-genre': [genre: string]
  'browse-similar': [hardcoverId: string]
}>()

const { t } = useI18n()

const authorLine = computed(() => props.book.authors.join(', ') || t('discovery.card.unknownAuthor'))
const ratingLabel = computed(() => (props.book.rating === null ? null : props.book.rating.toFixed(1)))
const hardcoverId = computed(() => props.book.sources.find((source) => source.source === 'hardcover')?.externalId ?? null)

function sourceLabel(source: 'hardcover' | 'storygraph'): string {
  return t(`discovery.sources.${source}`)
}

function handleAcquire() {
  emit('acquire', props.book)
}

function handleBrowseAuthor() {
  const author = props.book.authors[0]
  if (author) emit('browse-author', author)
}

function handleBrowseSimilar() {
  if (hardcoverId.value) emit('browse-similar', hardcoverId.value)
}
</script>

<template>
  <article
    class="group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-lg"
  >
    <div class="relative aspect-[2/3] overflow-hidden bg-muted">
      <img
        v-if="book.coverUrl"
        :src="book.coverUrl"
        :alt="t('discovery.card.coverAlt', { title: book.title })"
        class="h-full w-full object-cover transition duration-500 group-hover:scale-[1.025]"
        loading="lazy"
      />
      <div
        v-else
        class="flex h-full w-full flex-col items-center justify-center gap-3 bg-linear-to-br from-muted to-secondary/50 text-muted-foreground"
      >
        <BookOpen :size="40" :stroke-width="1.4" />
        <span class="px-4 text-center text-xs font-medium">{{ t('discovery.card.noCover') }}</span>
      </div>

      <div class="absolute inset-x-0 top-0 flex flex-wrap gap-1.5 bg-linear-to-b from-background/75 via-background/20 to-transparent p-3 pb-8">
        <Badge
          v-for="source in book.sources"
          :key="source.source"
          data-source-badge
          variant="secondary"
          class="border border-border/60 bg-background/90 text-[10px] font-semibold shadow-sm backdrop-blur"
        >
          {{ sourceLabel(source.source) }}
        </Badge>
      </div>
    </div>

    <div class="flex flex-1 flex-col p-4">
      <div class="min-h-16">
        <h2 class="line-clamp-2 font-serif text-lg font-semibold leading-tight text-card-foreground" :title="book.title">
          {{ book.title }}
        </h2>
        <button
          data-testid="browse-author"
          type="button"
          class="mt-1 line-clamp-1 text-left text-sm text-muted-foreground transition-colors hover:text-primary hover:underline"
          :title="authorLine"
          @click="handleBrowseAuthor"
        >
          {{ authorLine }}
        </button>
      </div>

      <div v-if="book.genres.length > 0" class="mt-2 flex flex-wrap gap-1.5">
        <button
          v-for="genre in book.genres.slice(0, 2)"
          :key="genre.slug"
          data-testid="browse-genre"
          type="button"
          class="rounded-full border border-border/70 bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary"
          @click="emit('browse-genre', genre.slug)"
        >
          {{ genre.name }}
        </button>
      </div>

      <div class="mt-3 flex min-h-6 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span v-if="book.publishedYear" class="rounded-full bg-muted px-2 py-1 tabular-nums">{{ book.publishedYear }}</span>
        <span v-if="book.pageCount" class="rounded-full bg-muted px-2 py-1 tabular-nums">
          {{ t('discovery.card.pages', { count: book.pageCount }) }}
        </span>
        <span v-if="ratingLabel" class="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 tabular-nums">
          <Star :size="11" class="fill-current text-primary" />
          {{ ratingLabel }}
        </span>
      </div>

      <p v-if="book.description" class="mt-3 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
        {{ book.description }}
      </p>
      <div v-else class="flex-1" />

      <div class="mt-4 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
        <div class="flex min-w-0 items-center gap-1">
          <Button
            v-for="source in book.sources"
            :key="source.url"
            variant="ghost"
            size="icon-sm"
            as="a"
            :href="source.url"
            target="_blank"
            rel="noreferrer"
            :aria-label="t('discovery.card.openSource', { source: sourceLabel(source.source) })"
            class="text-muted-foreground hover:text-foreground"
          >
            <ExternalLink :size="14" />
          </Button>
          <Button
            v-if="hardcoverId"
            data-testid="browse-similar"
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground"
            :aria-label="t('discovery.card.similar')"
            :title="t('discovery.card.similar')"
            @click="handleBrowseSimilar"
          >
            <Sparkles :size="14" />
          </Button>
        </div>

        <Button v-if="canAcquire" data-testid="acquire-book" size="sm" class="gap-1.5 rounded-full px-3" @click="handleAcquire">
          <Download :size="14" />
          {{ t('discovery.card.acquire') }}
        </Button>
      </div>
    </div>
  </article>
</template>
