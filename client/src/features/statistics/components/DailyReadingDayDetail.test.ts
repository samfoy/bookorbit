import { mount } from '@vue/test-utils'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import type { UserDailyReadingDetail } from '@bookorbit/types'

const mocks = vi.hoisted(() => ({ routerPush: vi.fn<(to: unknown) => void>() }))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}))

vi.mock('@/stores/theme', () => ({
  useThemeStore: () => ({ resolvedTheme: 'dark', accent: 'blue' }),
}))

import DailyReadingDayDetail from './DailyReadingDayDetail.vue'

function makeDetail(overrides: Partial<UserDailyReadingDetail> = {}): UserDailyReadingDetail {
  return {
    day: '2026-04-12',
    totalSeconds: 2400,
    sessionsCount: 2,
    bySource: { bookorbit: 600, koreader: 0, kobo: 1800, crosspoint: 0, audiobookshelf: 0 },
    sessions: [
      {
        sessionId: 91,
        bookId: 7,
        bookTitle: 'Dune',
        bookFormat: 'epub',
        source: 'kobo',
        startedAt: '2026-04-12T15:00:00.000Z',
        endedAt: '2026-04-12T15:30:00.000Z',
        durationSeconds: 1800,
        progressDelta: 1.5,
        endProgress: 42,
      },
      {
        sessionId: 92,
        bookId: 8,
        bookTitle: null,
        bookFormat: null,
        source: 'bookorbit',
        startedAt: '2026-04-12T18:00:00.000Z',
        endedAt: '2026-04-12T18:10:00.000Z',
        durationSeconds: 600,
        progressDelta: null,
        endProgress: null,
      },
    ],
    ...overrides,
  }
}

function mountComponent(props: Partial<InstanceType<typeof DailyReadingDayDetail>['$props']> = {}) {
  return mount(DailyReadingDayDetail, {
    props: { day: '2026-04-12', detail: null, loading: false, error: false, ...props },
  })
}

describe('DailyReadingDayDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the loading state without a session list', () => {
    const wrapper = mountComponent({ loading: true })

    expect(wrapper.find('[data-testid="day-detail-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="day-detail-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="day-detail-error"]').exists()).toBe(false)
    expect(wrapper.findAll('li')).toHaveLength(0)
  })

  it('renders the empty state when the day has no sessions', () => {
    const wrapper = mountComponent({ detail: makeDetail({ totalSeconds: 0, sessionsCount: 0, sessions: [] }) })

    expect(wrapper.find('[data-testid="day-detail-empty"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('No sessions on this day')
    expect(wrapper.findAll('li')).toHaveLength(0)
  })

  it('renders the error state and emits retry', async () => {
    const wrapper = mountComponent({ error: true })

    const errorBlock = wrapper.find('[data-testid="day-detail-error"]')
    expect(errorBlock.exists()).toBe(true)
    expect(wrapper.text()).toContain('Could not load this day')

    await errorBlock.find('button').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('renders the populated session list with totals, sources and formats', () => {
    const wrapper = mountComponent({ detail: makeDetail() })

    const rows = wrapper.findAll('li')
    expect(rows).toHaveLength(2)
    expect(wrapper.find('[data-testid="day-detail-loading"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="day-detail-empty"]').exists()).toBe(false)

    const text = wrapper.text()
    expect(text).toContain('Dune')
    expect(text).toContain('Unknown book')
    expect(text).toContain('Kobo')
    expect(text).toContain('BookOrbit')
    expect(text).toContain('EPUB')
    expect(text).toContain('40m')
    expect(text).toContain('2 sessions')
    expect(text).toContain('+1.5% progress')
  })

  it('navigates to the book and emits close from the header control', async () => {
    const wrapper = mountComponent({ detail: makeDetail() })

    await wrapper.findAll('li')[0]!.find('button').trigger('click')
    expect(mocks.routerPush).toHaveBeenCalledWith({ name: 'book-detail', params: { bookId: 7 } })

    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
