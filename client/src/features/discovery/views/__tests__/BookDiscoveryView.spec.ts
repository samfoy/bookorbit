import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>())
const permissionState = vi.hoisted(() => ({ canUpload: true }))

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
    apiMock.mockReset()
    apiMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/api/v1/libraries') return response([])
      if (url.endsWith('/browse/home')) {
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
          hasMore: false,
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
