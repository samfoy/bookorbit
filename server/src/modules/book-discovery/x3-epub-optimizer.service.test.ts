import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ZipArchive } from 'archiver';
import * as unzipper from 'unzipper';
import { afterEach, describe, expect, it } from 'vitest';

import { extractEpubMetadata } from '../metadata/lib/epub';
import { X3EpubOptimizerService } from './x3-epub-optimizer.service';

const tempDirs: string[] = [];

async function writeTestEpub(path: string, emptySpineItems = 0): Promise<void> {
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
  const emptyItems = Array.from(
    { length: emptySpineItems },
    (_, index) => `<item id="empty-${index}" href="text/empty-${index}.xhtml" media-type="application/xhtml+xml"/>`,
  ).join('');
  const emptyRefs = Array.from({ length: emptySpineItems }, (_, index) => `<itemref idref="empty-${index}"/>`).join('');
  archive.append(
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Piranesi</dc:title><dc:creator>Susanna Clarke</dc:creator></metadata><manifest><item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>${emptyItems}</manifest><spine><itemref idref="ch1"/>${emptyRefs}</spine></package>`,
    { name: 'OEBPS/content.opf' },
  );
  archive.append(
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>The Beauty of the House is immeasurable; its Kindness infinite.</p></body></html>',
    { name: 'OEBPS/text/ch1.xhtml' },
  );
  for (let index = 0; index < emptySpineItems; index += 1) {
    archive.append('<html xmlns="http://www.w3.org/1999/xhtml"><body></body></html>', { name: `OEBPS/text/empty-${index}.xhtml` });
  }
  await archive.finalize();
  await done;
  await writeFile(path, Buffer.concat(chunks));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('X3EpubOptimizerService', () => {
  it('drops empty spine entries to keep a useful manifest below the firmware limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bookorbit-x3-'));
    tempDirs.push(dir);
    const path = join(dir, 'fragmented.epub');
    await writeTestEpub(path, 700);

    const result = await new X3EpubOptimizerService().optimize(path);

    expect(result.optimized).toBe(true);
    const zip = await unzipper.Open.file(path);
    const entry = zip.files.find((file) => file.path === 'META-INF/x-locations.json');
    const manifest = JSON.parse((await entry!.buffer()).toString('utf8')) as { spine: unknown[] };
    expect(manifest.spine).toHaveLength(1);
  });

  it('adds a firmware-valid x-locations manifest before library ingest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bookorbit-x3-'));
    tempDirs.push(dir);
    const path = join(dir, 'piranesi.epub');
    await writeTestEpub(path);

    const result = await new X3EpubOptimizerService().optimize(path);

    expect(result.optimized).toBe(true);
    const zip = await unzipper.Open.file(path);
    const entry = zip.files.find((file) => file.path === 'META-INF/x-locations.json');
    expect(entry).toBeDefined();
    const manifestBuffer = await entry!.buffer();
    const manifest = JSON.parse(manifestBuffer.toString('utf8')) as {
      format: string;
      version: number;
      totalLocations: number;
      spine: Array<{ startLocation: number; endLocation: number }>;
    };
    expect(manifestBuffer.length).toBeLessThanOrEqual(64 * 1024);
    expect(manifest).toMatchObject({ format: 'x-locations', version: 1 });
    expect(manifest.totalLocations).toBeGreaterThan(0);
    expect(manifest.spine.some((item) => item.startLocation > 0 && item.endLocation >= item.startLocation)).toBe(true);
    await expect(extractEpubMetadata(path)).resolves.toMatchObject({ title: 'Piranesi' });
  });
});
