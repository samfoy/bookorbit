import type { ExternalBookSearchResult } from '@bookorbit/types'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import DiscoveryBookCard from '../DiscoveryBookCard.vue'

const book: ExternalBookSearchResult = {
  id: 'hardcover:1',
  title: 'Piranesi',
  authors: ['Susanna Clarke'],
  coverUrl: 'https://covers.example/piranesi.jpg',
  description: 'A labyrinth, a mystery, and an ocean.',
  publishedYear: 2020,
  rating: 4.2,
  ratingsCount: 1000,
  isbn10: null,
  isbn13: '9781635575637',
  pageCount: 272,
  seriesName: null,
  seriesPosition: null,
  hasEbook: true,
  genres: [{ name: 'Fantasy', slug: 'fantasy' }],
  sources: [
    { source: 'hardcover', externalId: '1', url: 'https://hardcover.app/books/piranesi' },
    { source: 'storygraph', externalId: 'piranesi', url: 'https://app.thestorygraph.com/books/piranesi' },
  ],
}

describe('DiscoveryBookCard', () => {
  it('renders merged catalog details and emits the acquire action', async () => {
    const wrapper = mount(DiscoveryBookCard, { props: { book, canAcquire: true } })

    expect(wrapper.text()).toContain('Piranesi')
    expect(wrapper.text()).toContain('Susanna Clarke')
    expect(wrapper.findAll('[data-source-badge]')).toHaveLength(2)

    await wrapper.get('[data-testid="browse-author"]').trigger('click')
    await wrapper.get('[data-testid="browse-genre"]').trigger('click')
    await wrapper.get('[data-testid="browse-similar"]').trigger('click')
    expect(wrapper.emitted('browse-author')).toEqual([['Susanna Clarke']])
    expect(wrapper.emitted('browse-genre')).toEqual([['fantasy']])
    expect(wrapper.emitted('browse-similar')).toEqual([['1']])

    await wrapper.get('[data-testid="acquire-book"]').trigger('click')
    expect(wrapper.emitted('acquire')).toEqual([[book]])
  })

  it('hides acquisition when the user lacks upload permission', () => {
    const wrapper = mount(DiscoveryBookCard, { props: { book, canAcquire: false } })
    expect(wrapper.find('[data-testid="acquire-book"]').exists()).toBe(false)
  })
})
