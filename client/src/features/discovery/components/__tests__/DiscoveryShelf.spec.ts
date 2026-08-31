import type { DiscoveryBrowseSection, ExternalBookSearchResult } from '@bookorbit/types'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import DiscoveryShelf from '../DiscoveryShelf.vue'

const book = {
  id: 'hardcover:1',
  title: 'Piranesi',
  authors: ['Susanna Clarke'],
  coverUrl: null,
  description: null,
  publishedYear: 2020,
  rating: 4.2,
  ratingsCount: 100,
  isbn10: null,
  isbn13: '9781635575644',
  pageCount: 245,
  seriesName: null,
  seriesPosition: null,
  hasEbook: true,
  genres: [{ name: 'Fantasy', slug: 'fantasy' }],
  sources: [{ source: 'hardcover', externalId: '1', url: 'https://hardcover.app/books/piranesi' }],
} satisfies ExternalBookSearchResult

const section: DiscoveryBrowseSection = {
  id: 'genre-fantasy',
  title: 'Trending Fantasy',
  subtitle: 'Popular this week',
  kind: 'genre',
  value: 'fantasy',
  items: [book],
}

describe('DiscoveryShelf', () => {
  it('renders a horizontally browsable shelf and exposes view-all and card actions', async () => {
    const wrapper = mount(DiscoveryShelf, { props: { section, canAcquire: true } })

    expect(wrapper.get('[data-testid="discovery-shelf-track"]').classes()).toContain('overflow-x-auto')
    await wrapper.get('[data-testid="view-all-shelf"]').trigger('click')
    await wrapper.get('[data-testid="acquire-book"]').trigger('click')

    expect(wrapper.emitted('view-all')).toEqual([['genre', 'fantasy']])
    expect(wrapper.emitted('acquire')).toEqual([[book]])
  })
})
