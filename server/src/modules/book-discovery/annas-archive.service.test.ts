import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../common/utils/ssrf.utils', () => ({
  ensureSafeUrl: vi.fn((value: string) => Promise.resolve(new URL(value))),
}));

import { AnnasArchiveService } from './annas-archive.service';

describe('AnnasArchiveService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the configured member key to resolve and fetch a fast download', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ download_url: 'https://downloads.example/book.epub', error: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('epub bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = { get: vi.fn().mockReturnValue('member-secret') };

    const response = await new AnnasArchiveService(config as never).download('11111111111111111111111111111111');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.any(URL),
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('md5=11111111111111111111111111111111');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('key=member-secret');
    expect(fetchMock).toHaveBeenNthCalledWith(2, new URL('https://downloads.example/book.epub'), expect.objectContaining({ redirect: 'manual' }));
    expect(response.status).toBe(200);
  });
});
