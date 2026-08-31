import { Injectable } from '@nestjs/common';
import { ZipArchive } from 'archiver';
import * as cheerio from 'cheerio';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { rename, rm } from 'fs/promises';
import { posix } from 'path';
import * as unzipper from 'unzipper';
import { XMLParser } from 'fast-xml-parser';

import { extractEpubMetadata } from '../metadata/lib/epub';

const MANIFEST_PATH = 'META-INF/x-locations.json';
const WORDS_PER_LOCATION = 64;
const CHARACTERS_PER_REFERENCE_PAGE = 1500;
const MAX_MANIFEST_BYTES = 64 * 1024;

interface OpfItem {
  '@_id'?: string;
  '@_href'?: string;
}

interface OpfItemRef {
  '@_idref'?: string;
}

interface LocationSpineEntry {
  index: number;
  characterStart: number;
  characterCount: number;
  startLocation: number;
  endLocation: number;
}

interface XLocationsManifest {
  format: 'x-locations';
  version: 1;
  generator: 'bookorbit';
  unit: 'word';
  referencePageUnit: 'character';
  wordsPerLocation: number;
  charactersPerReferencePage: number;
  totalWords: number;
  totalCharacters: number;
  totalLocations: number;
  totalReferencePages: number;
  spine: LocationSpineEntry[];
}

export interface X3OptimizationResult {
  optimized: boolean;
  alreadyPresent: boolean;
  manifestBytes: number | null;
  reason: string | null;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  isArray: (name) => name === 'item' || name === 'itemref' || name === 'rootfile',
});

@Injectable()
export class X3EpubOptimizerService {
  async optimize(epubPath: string): Promise<X3OptimizationResult> {
    const tempPath = `${epubPath}.x3tmp-${randomUUID()}`;
    try {
      const zip = await unzipper.Open.file(epubPath);
      const existing = zip.files.find((file) => file.path === MANIFEST_PATH);
      if (existing) {
        return { optimized: true, alreadyPresent: true, manifestBytes: existing.uncompressedSize ?? null, reason: null };
      }

      const manifest = await this.buildManifest(zip);
      const payload = Buffer.from(JSON.stringify(manifest), 'utf8');
      if (manifest.totalLocations === 0) {
        return { optimized: false, alreadyPresent: false, manifestBytes: payload.length, reason: 'EPUB has no readable spine text' };
      }
      if (payload.length > MAX_MANIFEST_BYTES) {
        return { optimized: false, alreadyPresent: false, manifestBytes: payload.length, reason: 'CrossInk manifest exceeds 64 KB' };
      }

      await this.rebuildWithManifest(zip, tempPath, payload);
      const [metadata, rebuilt] = await Promise.all([extractEpubMetadata(tempPath), unzipper.Open.file(tempPath)]);
      const rebuiltManifest = rebuilt.files.find((file) => file.path === MANIFEST_PATH);
      if (!metadata || !rebuiltManifest || rebuiltManifest.uncompressedSize !== payload.length) {
        await rm(tempPath, { force: true });
        return { optimized: false, alreadyPresent: false, manifestBytes: payload.length, reason: 'Optimized EPUB failed verification' };
      }

      await rename(tempPath, epubPath);
      return { optimized: true, alreadyPresent: false, manifestBytes: payload.length, reason: null };
    } catch (error) {
      await rm(tempPath, { force: true });
      return {
        optimized: false,
        alreadyPresent: false,
        manifestBytes: null,
        reason: error instanceof Error ? error.message : 'EPUB optimization failed',
      };
    }
  }

  private async buildManifest(zip: unzipper.CentralDirectory): Promise<XLocationsManifest> {
    const container = await this.readEntry(zip, 'META-INF/container.xml');
    const parsedContainer = xmlParser.parse(container.toString('utf8')) as {
      container?: { rootfiles?: { rootfile?: Array<{ '@_full-path'?: string }> } };
    };
    const opfPath = parsedContainer.container?.rootfiles?.rootfile?.[0]?.['@_full-path'];
    if (!opfPath) throw new Error('Cannot locate OPF path in EPUB');

    const opf = await this.readEntry(zip, opfPath);
    const parsedOpf = xmlParser.parse(opf.toString('utf8')) as {
      package?: { manifest?: { item?: OpfItem[] }; spine?: { itemref?: OpfItemRef[] } };
    };
    const items = parsedOpf.package?.manifest?.item ?? [];
    const itemById = new Map(items.flatMap((item) => (item['@_id'] && item['@_href'] ? [[item['@_id'], item['@_href']] as const] : [])));
    const spinePaths = (parsedOpf.package?.spine?.itemref ?? [])
      .map((item) => itemById.get(item['@_idref'] ?? ''))
      .filter((href): href is string => Boolean(href))
      .map((href) => this.resolveSpinePath(opfPath, href));
    if (spinePaths.length === 0) throw new Error('EPUB spine is empty');

    let totalWords = 0;
    let totalCharacters = 0;
    let nextLocation = 1;
    const spine: LocationSpineEntry[] = [];

    for (const [index, path] of spinePaths.entries()) {
      const entry = zip.files.find((file) => file.path === path || decodeURIComponent(file.path) === decodeURIComponent(path));
      const text = entry ? this.extractText(await entry.buffer()) : '';
      const wordCount = this.countWords(text);
      const characterCount = text.length;
      const locationCount = Math.ceil(wordCount / WORDS_PER_LOCATION);
      if (locationCount > 0) {
        spine.push({
          index,
          characterStart: totalCharacters,
          characterCount,
          startLocation: nextLocation,
          endLocation: nextLocation + locationCount - 1,
        });
      }
      totalWords += wordCount;
      totalCharacters += characterCount;
      nextLocation += locationCount;
    }

    return {
      format: 'x-locations',
      version: 1,
      generator: 'bookorbit',
      unit: 'word',
      referencePageUnit: 'character',
      wordsPerLocation: WORDS_PER_LOCATION,
      charactersPerReferencePage: CHARACTERS_PER_REFERENCE_PAGE,
      totalWords,
      totalCharacters,
      totalLocations: Math.max(0, nextLocation - 1),
      totalReferencePages: Math.ceil(totalCharacters / CHARACTERS_PER_REFERENCE_PAGE),
      spine,
    };
  }

  private async rebuildWithManifest(zip: unzipper.CentralDirectory, outputPath: string, manifest: Buffer): Promise<void> {
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const output = createWriteStream(outputPath);
    archive.pipe(output);
    const completed = new Promise<void>((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
    });

    const mimetype = zip.files.find((file) => file.path === 'mimetype');
    if (!mimetype) throw new Error('EPUB mimetype entry is missing');
    archive.append(await mimetype.buffer(), { name: 'mimetype', store: true });

    for (const entry of zip.files) {
      if (entry.path === 'mimetype' || entry.path === MANIFEST_PATH || entry.type === 'Directory') continue;
      archive.append(entry.stream(), { name: entry.path, store: entry.compressionMethod === 0 });
    }
    archive.append(manifest, { name: MANIFEST_PATH });
    await archive.finalize();
    await completed;
  }

  private async readEntry(zip: unzipper.CentralDirectory, path: string): Promise<Buffer> {
    const entry = zip.files.find((file) => file.path === path || file.path === path.replace(/^\//, ''));
    if (!entry) throw new Error(`Missing EPUB entry: ${path}`);
    return entry.buffer();
  }

  private resolveSpinePath(opfPath: string, href: string): string {
    const decoded = decodeURIComponent(href.split('#', 1)[0] ?? href);
    return posix.normalize(posix.join(posix.dirname(opfPath), decoded));
  }

  private extractText(buffer: Buffer): string {
    const $ = cheerio.load(buffer.toString('utf8'), { xmlMode: true });
    $('script, style, svg, metadata').remove();
    return ($('body').text() || $.root().text()).replace(/\s+/g, ' ').trim();
  }

  private countWords(text: string): number {
    return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  }
}
