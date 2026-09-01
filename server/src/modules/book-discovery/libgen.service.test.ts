import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../common/utils/ssrf.utils', () => ({
  ensureSafeUrl: vi.fn((value: string) => Promise.resolve(new URL(value))),
}));

import { LibgenService } from './libgen.service';

const EPUB_MD5 = '11111111111111111111111111111111';
const PDF_MD5 = '22222222222222222222222222222222';
const WRONG_VOLUME_MD5 = '33333333333333333333333333333333';

describe('LibgenService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses ISBN first and returns the best EPUB candidate', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        `<table>
          <tr><td><a href="/ads.php?md5=${PDF_MD5}">Dune</a> Frank Herbert English pdf</td></tr>
          <tr><td><a href="/ads.php?md5=${EPUB_MD5}">Dune</a> Frank Herbert English epub</td></tr>
        </table>`,
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const candidates = await new LibgenService().findCandidates({
      title: 'Dune',
      authors: ['Frank Herbert'],
      isbn13: '9780441013593',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://libgen.li/index.php?req=9780441013593'),
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }), redirect: 'manual' }),
    );
    expect(candidates).toEqual([
      {
        md5: EPUB_MD5,
        format: 'epub',
        mirror: 'https://libgen.li',
        description: 'Dune Frank Herbert English epub',
      },
    ]);
  });

  it('filters a distinct sequel before attempting a download', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        `<table>
          <tr><td><a href="/edition.php?id=1">Dune Messiah</a> Frank Herbert English epub <a href="/ads.php?md5=${WRONG_VOLUME_MD5}">Libgen</a></td></tr>
          <tr><td><a href="/edition.php?id=2">Dune</a> Frank Herbert English epub <a href="/ads.php?md5=${EPUB_MD5}">Libgen</a></td></tr>
        </table>`,
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const candidates = await new LibgenService().findCandidates({ title: 'Dune', authors: ['Frank Herbert'] });

    expect(candidates).toEqual([
      {
        md5: EPUB_MD5,
        format: 'epub',
        mirror: 'https://libgen.li',
        description: 'Dune Frank Herbert English epub Libgen',
      },
    ]);
  });

  it('keeps more than five exact EPUB candidates so a stale storage record cannot hide later working copies', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => {
      const md5 = String(index + 1).repeat(32);
      return `<tr><td><a href="/edition.php?id=${index + 1}">Klara and the Sun</a> Kazuo Ishiguro English epub <a href="/ads.php?md5=${md5}">Libgen</a></td></tr>`;
    }).join('');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`<table>${rows}</table>`, { status: 200 })));

    const candidates = await new LibgenService().findCandidates({ title: 'Klara and the Sun', authors: ['Kazuo Ishiguro'] });

    expect(candidates).toHaveLength(8);
  });

  it('resolves a fresh LibGen key immediately before a CDN download attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(`<a href="/get.php?md5=${EPUB_MD5}&key=FRESHKEY">GET</a>`, { status: 200 }))
      .mockResolvedValueOnce(new Response('epub bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const candidate = {
      md5: EPUB_MD5,
      format: 'epub' as const,
      mirror: 'https://libgen.li',
      description: 'Dune Frank Herbert English epub',
    };

    const response = await new LibgenService().downloadAttempt(candidate, 0);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL(`https://libgen.li/ads.php?md5=${EPUB_MD5}`),
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }), redirect: 'manual' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL(`https://cdn4.booksdl.lc/get.php?md5=${EPUB_MD5}&key=FRESHKEY`),
      expect.objectContaining({
        headers: expect.objectContaining({ Referer: `https://libgen.li/ads.php?md5=${EPUB_MD5}` }),
        redirect: 'manual',
      }),
    );
  });
});
