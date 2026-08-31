<script setup lang="ts">
import type { DiscoveryBrowseKind, DiscoveryBrowseSection, ExternalBookSearchResult } from '@bookorbit/types'
import { ChevronRight } from '@lucide/vue'

import { Button } from '@/components/ui/button'
import DiscoveryBookCard from './DiscoveryBookCard.vue'

const props = defineProps<{
  section: DiscoveryBrowseSection
  canAcquire: boolean
}>()

const emit = defineEmits<{
  'view-all': [kind: DiscoveryBrowseKind, value: string | null]
  acquire: [book: ExternalBookSearchResult]
  'browse-author': [author: string]
  'browse-genre': [genre: string]
  'browse-similar': [hardcoverId: string]
}>()

function handleViewAll() {
  emit('view-all', props.section.kind, props.section.value)
}
</script>

<template>
  <section class="space-y-4" :aria-labelledby="`shelf-${section.id}`">
    <div class="flex items-end justify-between gap-4 px-1">
      <div class="min-w-0">
        <h2 :id="`shelf-${section.id}`" class="font-serif text-2xl font-semibold tracking-tight">{{ section.title }}</h2>
        <p v-if="section.subtitle" class="mt-0.5 text-sm text-muted-foreground">{{ section.subtitle }}</p>
      </div>
      <Button
        data-testid="view-all-shelf"
        variant="ghost"
        size="sm"
        class="shrink-0 gap-1 text-muted-foreground hover:text-primary"
        @click="handleViewAll"
      >
        {{ $t('discovery.browse.viewAll') }}
        <ChevronRight :size="15" />
      </Button>
    </div>

    <div
      data-testid="discovery-shelf-track"
      class="grid snap-x snap-mandatory grid-flow-col auto-cols-[minmax(14rem,17rem)] gap-4 overflow-x-auto overscroll-x-contain pb-3 [scrollbar-width:thin]"
    >
      <DiscoveryBookCard
        v-for="book in section.items"
        :key="book.id"
        class="snap-start"
        :book="book"
        :can-acquire="canAcquire"
        @acquire="emit('acquire', $event)"
        @browse-author="emit('browse-author', $event)"
        @browse-genre="emit('browse-genre', $event)"
        @browse-similar="emit('browse-similar', $event)"
      />
    </div>
  </section>
</template>
