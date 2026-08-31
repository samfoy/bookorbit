import type { BookAcquisitionSourceCapability, ExternalBookSearchResult, Library } from '@bookorbit/types'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import AcquisitionSheet from '../AcquisitionSheet.vue'

const book: ExternalBookSearchResult = {
  id: 'hardcover:1',
  title: 'Piranesi',
  authors: ['Susanna Clarke'],
  coverUrl: null,
  description: null,
  publishedYear: 2020,
  rating: null,
  ratingsCount: null,
  isbn10: null,
  isbn13: '9781635575637',
  pageCount: 272,
  seriesName: null,
  seriesPosition: null,
  hasEbook: true,
  sources: [{ source: 'hardcover', externalId: '1', url: 'https://hardcover.app/books/piranesi' }],
}

const library = {
  id: 3,
  name: 'Ebooks',
  folders: [{ id: 9, path: '/books', createdAt: '2026-01-01T00:00:00.000Z' }],
} as Library

const capabilities: BookAcquisitionSourceCapability[] = [
  { source: 'libgen', available: true, label: 'LibGen', message: null },
  { source: 'annas_archive', available: false, label: "Anna's Archive", message: 'Membership key required' },
]

describe('AcquisitionSheet', () => {
  it('emits the selected library, folder, and source', async () => {
    const wrapper = mount(AcquisitionSheet, {
      props: { open: true, book, libraries: [library], capabilities, submitting: false },
      global: {
        stubs: {
          Sheet: { template: '<div><slot /></div>' },
          SheetContent: { template: '<div><slot /></div>' },
          SheetHeader: { template: '<div><slot /></div>' },
          SheetTitle: { template: '<h2><slot /></h2>' },
          SheetDescription: { template: '<p><slot /></p>' },
          SheetFooter: { template: '<div><slot /></div>' },
        },
      },
    })

    await wrapper.get('[data-testid="acquisition-source"]').setValue('libgen')
    await wrapper.get('[data-testid="confirm-acquisition"]').trigger('click')

    expect(wrapper.emitted('confirm')).toEqual([[{ libraryId: 3, folderId: 9, source: 'libgen' }]])
  })

  it("disables Anna's Archive when no member key is configured", () => {
    const wrapper = mount(AcquisitionSheet, {
      props: { open: true, book, libraries: [library], capabilities, submitting: false },
      global: {
        stubs: {
          Sheet: { template: '<div><slot /></div>' },
          SheetContent: { template: '<div><slot /></div>' },
          SheetHeader: { template: '<div><slot /></div>' },
          SheetTitle: { template: '<h2><slot /></h2>' },
          SheetDescription: { template: '<p><slot /></p>' },
          SheetFooter: { template: '<div><slot /></div>' },
        },
      },
    })

    expect(wrapper.get('option[value="annas_archive"]').attributes('disabled')).toBeDefined()
  })
})
