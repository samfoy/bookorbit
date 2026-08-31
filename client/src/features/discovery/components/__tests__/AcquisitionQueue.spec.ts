import type { BookAcquisitionJob } from '@bookorbit/types'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import AcquisitionQueue from '../AcquisitionQueue.vue'

const importingJob: BookAcquisitionJob = {
  id: 'job-1',
  title: 'Piranesi',
  author: 'Susanna Clarke',
  status: 'importing',
  source: 'libgen',
  libraryId: 3,
  bookId: null,
  bytesDownloaded: 1234,
  x3Optimized: true,
  error: null,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:01:00.000Z',
}

describe('AcquisitionQueue', () => {
  it('does not offer cancellation after the irreversible import stage starts', () => {
    const wrapper = mount(AcquisitionQueue, {
      props: { jobs: [importingJob] },
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
        },
      },
    })

    expect(wrapper.find('button').exists()).toBe(false)
  })
})
