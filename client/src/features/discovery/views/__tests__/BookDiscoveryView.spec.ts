import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>())
const permissionState = vi.hoisted(() => ({ canUpload: true }))
const browseResponseState = vi.hoisted(() => ({ hasMore: false }))

vi.mock('@/lib/api', () => ({ api: apiMock }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({
    hasPermission: (name: string) => name === 'library_upload' && permissionState.canUpload,
    isDemoRestrictedAccount: { value: false },
  }),
}))

import BookDiscoveryView from '../BookDiscoveryView.vue'

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

describe('BookDiscoveryView', () => {
  beforeEach(() => {
    permissionState.canUpload = true
    browseResponseState.hasMore = false
    apiMock.mockReset()
    apiMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/api/v1/libraries') return response([])
      if (url.includes('/browse/home')) {
        return response({
          generatedAt: '2026-08-31T00:00:00.000Z',
          trending: { id: 'trending', title: 'Trending this week', subtitle: null, kind: 'trending', value: null, items: [] },
          genreShelves: [],
          genres: [{ name: 'Fantasy', slug: 'fantasy' }],
        })
      }
      if (url.includes('/browse?')) {
        return response({
          id: 'genre-fantasy',
          title: 'Fantasy books',
          subtitle: null,
          kind: 'genre',
          value: 'fantasy',
          items: [],
          page: 1,
          pageSize: 20,
          hasMore: browseResponseState.hasMore,
        })
      }
      if (url.endsWith('/acquisition-sources')) return response([])
      if (url.endsWith('/acquisitions')) return response([])
      if (url.includes('/search?')) return response({ results: [], sources: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
  })

  it('loads browse shelves without requiring a search', async () => {
    const wrapper = mount(BookDiscoveryView, {
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          AcquisitionSheet: true,
        },
      },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Explore by genre')
    expect(wrapper.text()).toContain('Trending this week')
    expect(wrapper.text()).toContain('Fantasy')
    expect(wrapper.text()).toContain("Hiding books you've read")
    expect(apiMock).toHaveBeenCalledWith('/api/v1/discovery/browse/home?hideRead=true')
  })

  it('renders a compact mobile search shell with tap-sized discovery controls', async () => {
    const wrapper = mount(BookDiscoveryView, {
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          AcquisitionSheet: true,
        },
      },
    })
    await flushPromises()

    const shell = wrapper.get('[data-testid="discovery-mobile-shell"]')
    expect(shell.classes()).toEqual(expect.arrayContaining(['px-4', 'py-5', 'sm:px-8', 'sm:py-10']))
    expect(wrapper.get('[data-testid="discovery-title"]').classes()).toEqual(expect.arrayContaining(['text-2xl', 'sm:text-4xl']))
    expect(wrapper.get('[data-testid="discovery-search-form"]').classes()).toEqual(expect.arrayContaining(['mt-5', 'sm:mt-7']))
    expect(wrapper.get('[data-testid="discovery-query"]').classes()).toContain('h-11')
    expect(wrapper.get('[data-testid="discovery-submit"]').classes()).toContain('h-11')

    const sourceToggles = wrapper.findAll('[data-testid="discovery-source-toggle"]')
    expect(sourceToggles).toHaveLength(2)
    for (const toggle of sourceToggles) expect(toggle.classes()).toContain('min-h-11')
    const controls = shell.get('[data-testid="discovery-controls"]')
    expect(controls.classes()).toEqual(expect.arrayContaining(['flex-col', 'sm:flex-row']))
    expect(controls.get('[data-testid="toggle-hide-read"]').classes()).toContain('min-h-11')
  })

  it('keeps browse genres in a single horizontally scrollable snap track', async () => {
    const wrapper = mount(BookDiscoveryView, {
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          AcquisitionSheet: true,
        },
      },
    })
    await flushPromises()

    const track = wrapper.get('[data-testid="discovery-genre-track"]')
    expect(track.classes()).toEqual(expect.arrayContaining(['overflow-x-auto', 'flex-nowrap', 'snap-x']))
    const genre = wrapper.get('[data-testid="discovery-genre"]')
    expect(genre.classes()).toEqual(expect.arrayContaining(['min-h-11', 'shrink-0', 'snap-start']))
  })

  it('keeps an empty active browse header, count, and grid narrow-safe', async () => {
    const wrapper = mount(BookDiscoveryView, {
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          AcquisitionSheet: true,
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="discovery-genre"]').trigger('click')
    await flushPromises()

    const header = wrapper.get('[data-testid="discovery-browse-header"]')
    expect(header.classes()).toContain('min-w-0')
    expect(wrapper.get('[data-testid="discovery-browse-title"]').classes()).toEqual(
      expect.arrayContaining(['break-words', 'text-2xl', 'sm:text-3xl']),
    )
    expect(wrapper.get('[data-testid="discovery-browse-count"]').classes()).toContain('shrink-0')
    expect(wrapper.get('[data-testid="discovery-browse-back"]').classes()).toContain('min-h-11')
    expect(wrapper.get('[data-testid="discovery-results-grid"]').classes()).toEqual(expect.arrayContaining(['min-w-0', 'grid-cols-1']))
    expect(wrapper.get('[data-testid="discovery-browse-empty"]').classes()).toEqual(expect.arrayContaining(['min-w-0', 'px-4']))
  })

  it('keeps the active browse load-more action full width on narrow screens', async () => {
    browseResponseState.hasMore = true
    const wrapper = mount(BookDiscoveryView, {
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          AcquisitionSheet: true,
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="discovery-genre"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="discovery-browse-load-more"]').classes()).toEqual(expect.arrayContaining(['min-h-11', 'w-full', 'sm:w-auto']))
  })

  it('renders the loading state in a contained one-column mobile grid', async () => {
    let resolveBrowseHome!: (value: Response) => void
    const browseHomeRequest = new Promise<Response>((resolve) => {
      resolveBrowseHome = resolve
    })
    apiMock.mockImplementation(async (input) => {
      if (String(input).includes('/browse/home')) return browseHomeRequest
      return response([])
    })
    const wrapper = mount(BookDiscoveryView, {
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          AcquisitionSheet: true,
        },
      },
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="discovery-loading"]').classes()).toContain('min-w-0')
    expect(wrapper.get('[data-testid="discovery-loading-grid"]').classes()).toEqual(expect.arrayContaining(['min-w-0', 'grid-cols-1']))

    resolveBrowseHome(
      response({
        generatedAt: '2026-08-31T00:00:00.000Z',
        trending: { id: 'trending', title: 'Trending this week', subtitle: null, kind: 'trending', value: null, items: [] },
        genreShelves: [],
        genres: [],
      }),
    )
    await flushPromises()
  })

  it('wraps browse errors inside the narrow viewport', async () => {
    apiMock.mockImplementation(async (input) => {
      if (String(input).includes('/browse/home')) throw new Error('A long catalog error that must remain visible')
      return response([])
    })
    const wrapper = mount(BookDiscoveryView, {
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          AcquisitionSheet: true,
        },
      },
    })
    await flushPromises()

    const errorState = wrapper.get('[data-testid="discovery-browse-error"]')
    expect(errorState.classes()).toContain('min-w-0')
    expect(errorState.get('p').classes()).toEqual(expect.arrayContaining(['min-w-0', 'break-words']))
    expect(errorState.text()).toContain('A long catalog error that must remain visible')
  })

  it('can reveal books already read', async () => {
    const wrapper = mount(BookDiscoveryView, {
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          AcquisitionSheet: true,
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="toggle-hide-read"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain("Showing books you've read")
    expect(apiMock).toHaveBeenCalledWith('/api/v1/discovery/browse/home?hideRead=false')
  })

  it('does not request acquisition-only state without upload permission', async () => {
    permissionState.canUpload = false
    mount(BookDiscoveryView, {
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          AcquisitionSheet: true,
        },
      },
    })
    await flushPromises()

    const requestedUrls = apiMock.mock.calls.map(([input]) => String(input))
    expect(requestedUrls.some((url) => url.includes('/discovery/acquisition'))).toBe(false)
  })

  it('submits the search query through both selected catalog sources', async () => {
    const wrapper = mount(BookDiscoveryView, {
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          AcquisitionSheet: true,
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="discovery-query"]').setValue('Piranesi')
    await wrapper.get('[data-testid="discovery-search-form"]').trigger('submit')
    await flushPromises()

    expect(apiMock).toHaveBeenCalledWith('/api/v1/discovery/search?query=Piranesi&sources=hardcover%2Cstorygraph')
  })
})
