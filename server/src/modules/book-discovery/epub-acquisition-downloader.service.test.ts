import { rm } from 'fs/promises';
import { ZipArchive } from 'archiver';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UploadStorageService } from '../upload/upload-storage.service';
import { EpubAcquisitionDownloaderService } from './epub-acquisition-downloader.service';

const MD5 = '11111111111111111111111111111111';
const createdPaths: string[] = [];

async function makeEpub(title: string, author: string): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 0 } });
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  archive.append('application/epub+zip', { name: 'mimetype', store: true });
  archive.append(
    '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    { name: 'META-INF/container.xml' },
  );
  archive.append(
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator></metadata><manifest><item id="ch1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></spine></package>`,
    { name: 'OEBPS/content.opf' },
  );
  archive.append('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>A house with an ocean in it.</p></body></html>', {
    name: 'OEBPS/chapter.xhtml',
  });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { force: true })));
});

describe('EpubAcquisitionDownloaderService', () => {
  it('downloads and verifies a real EPUB before returning it for upload', async () => {
    const epub = await makeEpub('Piranesi', 'Susanna Clarke');
    const candidate = { md5: MD5, format: 'epub' as const, mirror: 'https://libgen.li', description: 'Piranesi Susanna Clarke English epub' };
    const libgen = {
      findCandidates: vi.fn().mockResolvedValue([candidate]),
      downloadAttemptCount: 3,
      downloadAttempt: vi.fn().mockResolvedValue(
        new Response(epub, {
          status: 200,
          headers: { 'Content-Length': String(epub.length) },
        }),
      ),
    };
    const annas = { isConfigured: vi.fn().mockReturnValue(false), download: vi.fn() };
    const appSettings = { getMaxUploadSizeMb: vi.fn().mockResolvedValue(100) };
    const storage = new UploadStorageService(appSettings as never);
    const service = new EpubAcquisitionDownloaderService(libgen as never, annas as never, storage, appSettings as never);

    const result = await service.download({
      title: 'Piranesi',
      authors: ['Susanna Clarke'],
      isbn13: '9781635575637',
      source: 'libgen',
    });
    createdPaths.push(result.tempPath);

    expect(result).toMatchObject({
      source: 'libgen',
      md5: MD5,
      verifiedTitle: 'Piranesi',
      sizeBytes: epub.length,
    });
    expect(libgen.downloadAttempt).toHaveBeenCalledWith(candidate, 0, undefined);
    expect(annas.download).not.toHaveBeenCalled();
  });

  it('classifies upstream HTTP failures as request failures rather than metadata rejections', async () => {
    const candidate = {
      md5: MD5,
      format: 'epub' as const,
      mirror: 'https://libgen.li',
      description: 'Klara and the Sun Kazuo Ishiguro English epub',
    };
    const libgen = {
      findCandidates: vi.fn().mockResolvedValue([candidate]),
      downloadAttemptCount: 2,
      downloadAttempt: vi
        .fn()
        .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
        .mockResolvedValueOnce(new Response('error', { status: 500 })),
    };
    const annas = { isConfigured: vi.fn().mockReturnValue(false), download: vi.fn() };
    const appSettings = { getMaxUploadSizeMb: vi.fn().mockResolvedValue(100) };
    const storage = new UploadStorageService(appSettings as never);
    const service = new EpubAcquisitionDownloaderService(libgen as never, annas as never, storage, appSettings as never);

    try {
      await service.download({ title: 'Klara and the Sun', authors: ['Kazuo Ishiguro'], source: 'libgen' });
      expect.unreachable('expected acquisition to fail');
    } catch (error) {
      expect(error).toMatchObject({
        attempts: [
          { source: 'libgen', outcome: 'request_failed', message: 'Download source returned HTTP 503' },
          { source: 'libgen', outcome: 'request_failed', message: 'Download source returned HTTP 500' },
        ],
      });
    }
  });

  it('rejects an embedded author whose surname only contains the requested surname', async () => {
    const epub = await makeEpub('The Shining', 'Stephen Kingsley');
    const candidate = {
      md5: MD5,
      format: 'epub' as const,
      mirror: 'https://libgen.li',
      description: 'The Shining Stephen King English epub',
    };
    const libgen = {
      findCandidates: vi.fn().mockResolvedValue([candidate]),
      downloadAttemptCount: 1,
      downloadAttempt: vi.fn().mockImplementation(() => Promise.resolve(new Response(new Uint8Array(epub), { status: 200 }))),
    };
    const annas = { isConfigured: vi.fn().mockReturnValue(false), download: vi.fn() };
    const appSettings = { getMaxUploadSizeMb: vi.fn().mockResolvedValue(100) };
    const storage = new UploadStorageService(appSettings as never);
    const service = new EpubAcquisitionDownloaderService(libgen as never, annas as never, storage, appSettings as never);

    await expect(service.download({ title: 'The Shining', authors: ['Stephen King'], source: 'libgen' })).rejects.toThrow(
      'No verified EPUB was found for this book',
    );
  });

  it("reports Anna's Archive as optional when no member key is configured", () => {
    const libgen = {};
    const annas = { isConfigured: vi.fn().mockReturnValue(false) };
    const storage = {};
    const appSettings = {};
    const service = new EpubAcquisitionDownloaderService(libgen as never, annas as never, storage as never, appSettings as never);

    expect(service.getCapabilities()).toEqual([
      { source: 'libgen', available: true, label: 'LibGen', message: null },
      {
        source: 'annas_archive',
        available: false,
        label: "Anna's Archive",
        message: 'Add ANNAS_ARCHIVE_SECRET_KEY to enable member fast downloads',
      },
    ]);
  });
});
