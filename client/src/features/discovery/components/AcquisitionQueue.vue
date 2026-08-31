<script setup lang="ts">
import type { BookAcquisitionJob } from '@bookorbit/types'
import { useI18n } from 'vue-i18n'
import { Ban, CheckCircle2, CircleX, Download, LoaderCircle, Sparkles, Upload, X } from '@lucide/vue'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/formatting'

defineProps<{
  jobs: BookAcquisitionJob[]
}>()

const emit = defineEmits<{
  cancel: [jobId: string]
}>()

const { t } = useI18n()
const activeStatuses = new Set(['queued', 'downloading', 'optimizing', 'importing'])
const cancellableStatuses = new Set(['queued', 'downloading', 'optimizing'])

function isActive(job: BookAcquisitionJob): boolean {
  return activeStatuses.has(job.status)
}

function isCancellable(job: BookAcquisitionJob): boolean {
  return cancellableStatuses.has(job.status)
}

function statusLabel(job: BookAcquisitionJob): string {
  return t(`discovery.queue.status.${job.status}`)
}

function sourceLabel(job: BookAcquisitionJob): string {
  return t(`discovery.acquire.sources.${job.source}`)
}
</script>

<template>
  <section v-if="jobs.length > 0" class="rounded-2xl border border-border/70 bg-card/80 shadow-sm backdrop-blur">
    <div class="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
      <div class="flex min-w-0 items-center gap-2.5">
        <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Download :size="16" />
        </div>
        <div class="min-w-0">
          <h2 class="text-sm font-semibold">{{ t('discovery.queue.title') }}</h2>
          <p class="text-xs text-muted-foreground">{{ t('discovery.queue.description') }}</p>
        </div>
      </div>
      <Badge variant="secondary" class="tabular-nums">{{ jobs.length }}</Badge>
    </div>

    <div class="divide-y divide-border/60">
      <div v-for="job in jobs" :key="job.id" class="relative flex items-center gap-3 px-4 py-3 sm:px-5">
        <div
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          :class="isActive(job) ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'"
        >
          <LoaderCircle v-if="job.status === 'queued' || job.status === 'downloading'" :size="17" class="animate-spin" />
          <Sparkles v-else-if="job.status === 'optimizing'" :size="17" class="animate-pulse" />
          <Upload v-else-if="job.status === 'importing'" :size="17" class="animate-pulse" />
          <CheckCircle2 v-else-if="job.status === 'completed'" :size="17" class="text-primary" />
          <Ban v-else-if="job.status === 'cancelled'" :size="17" />
          <CircleX v-else :size="17" class="text-destructive" />
        </div>

        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-2">
            <RouterLink
              v-if="job.bookId"
              :to="{ name: 'book-detail', params: { bookId: job.bookId } }"
              class="truncate text-sm font-semibold hover:text-primary hover:underline"
            >
              {{ job.title }}
            </RouterLink>
            <p v-else class="truncate text-sm font-semibold">{{ job.title }}</p>
            <Badge variant="outline" class="hidden shrink-0 text-[10px] sm:inline-flex">{{ sourceLabel(job) }}</Badge>
          </div>
          <p class="mt-0.5 truncate text-xs text-muted-foreground">
            {{ statusLabel(job) }}
            <span v-if="job.bytesDownloaded"> · {{ formatBytes(job.bytesDownloaded) }}</span>
            <span v-if="job.x3Optimized"> · {{ t('discovery.queue.x3Ready') }}</span>
          </p>
          <p v-if="job.error" class="mt-1 line-clamp-1 text-xs text-destructive" :title="job.error">{{ job.error }}</p>
        </div>

        <Button
          v-if="isCancellable(job)"
          variant="ghost"
          size="icon-sm"
          :aria-label="t('discovery.queue.cancel', { title: job.title })"
          class="shrink-0 text-muted-foreground hover:text-destructive"
          @click="emit('cancel', job.id)"
        >
          <X :size="14" />
        </Button>

        <div v-if="isActive(job)" class="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-primary/10">
          <div class="h-full w-1/3 animate-[pulse_1.5s_ease-in-out_infinite] rounded-full bg-primary" />
        </div>
      </div>
    </div>
  </section>
</template>
