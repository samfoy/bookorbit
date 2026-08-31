import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ensureSafeUrlMock = vi.hoisted(() => vi.fn<(value: string) => Promise<URL>>());

vi.mock('../../common/utils/ssrf.utils', () => ({
  ensureSafeUrl: ensureSafeUrlMock,
}));

import { fetchWithSafeRedirects } from './safe-remote-fetch.util';

describe('fetchWithSafeRedirects', () => {
  beforeEach(() => {
    ensureSafeUrlMock.mockImplementation((value) => {
      if (value.includes('127.0.0.1')) return Promise.reject(new Error('unsafe redirect'));
      return Promise.resolve(new URL(value));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('rejects an unsafe redirect before requesting the redirected URL', async () => {
    const fetchMock = vi.fn<(input: string | URL | globalThis.Request, init?: RequestInit) => Promise<Response>>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'http://127.0.0.1/internal' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithSafeRedirects('https://downloads.example/book.epub')).rejects.toThrow('unsafe redirect');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ensureSafeUrlMock).toHaveBeenNthCalledWith(1, 'https://downloads.example/book.epub');
    expect(ensureSafeUrlMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1/internal');
  });
});
