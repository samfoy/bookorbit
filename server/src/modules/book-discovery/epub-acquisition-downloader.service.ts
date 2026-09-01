import type { BookAcquisitionAttempt, BookAcquisitionSource, BookAcquisitionSourceCapability } from '@bookorbit/types';
import { Injectable, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { Readable, Transform } from 'stream';

import { extractEpubMetadata } from '../metadata/lib/epub';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { UploadStorageService } from '../upload/upload-storage.service';
import { AnnasArchiveService } from './annas-archive.service';
import { normalizeBookText, titleMatchesRequestedBook } from './book-match.util';
import { LibgenService, type LibgenCandidate } from './libgen.service';

export type AcquisitionDownloadSource = BookAcquisitionSource;

export interface EpubAcquisitionDownloadRequest {
  title: string;
  authors: string[];
  isbn10?: string | null;
  isbn13?: string | null;
  source: AcquisitionDownloadSource;
}

export interface VerifiedEpubDownload {
  tempPath: string;
  sizeBytes: number;
  source: Exclude<AcquisitionDownloadSource, 'auto'>;
  md5: string;
  verifiedTitle: string;
  attempts: BookAcquisitionAttempt[];
}

export class AcquisitionAttemptsError extends NotFoundException {
  constructor(public readonly attempts: BookAcquisitionAttempt[]) {
    super('No verified EPUB was found for this book');
  }
}

@Injectable()
export class EpubAcquisitionDownloaderService {
  constructor(
    private readonly libgen: LibgenService,
    private readonly annas: AnnasArchiveService,
    private readonly storage: UploadStorageService,
    private readonly appSettings: AppSettingsService,
  ) {}

  getCapabilities(): BookAcquisitionSourceCapability[] {
    const annasAvailable = this.annas.isConfigured();
    return [
      { source: 'libgen', available: true, label: 'LibGen', message: null },
      {
        source: 'annas_archive',
        available: annasAvailable,
        label: "Anna's Archive",
        message: annasAvailable ? null : 'Add ANNAS_ARCHIVE_SECRET_KEY to enable member fast downloads',
      },
    ];
  }

  async download(request: EpubAcquisitionDownloadRequest, signal?: AbortSignal): Promise<VerifiedEpubDownload> {
    if (request.source === 'annas_archive' && !this.annas.isConfigured()) {
      throw new ServiceUnavailableException("Anna's Archive member key is not configured");
    }

    const candidates = await this.libgen.findCandidates(request, signal);
    const attemptLog: BookAcquisitionAttempt[] = [];
    for (const candidate of candidates) {
      const sources = this.sourceOrder(request.source);
      for (const source of sources) {
        const attempts = source === 'libgen' ? this.libgen.downloadAttemptCount : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
          if (signal?.aborted) throw signal.reason;
          let response: Response;
          try {
            response =
              source === 'libgen' ? await this.libgen.downloadAttempt(candidate, attempt, signal) : await this.annas.download(candidate.md5, signal);
          } catch (error) {
            if (signal?.aborted) throw error;
            attemptLog.push({ source, outcome: 'request_failed', message: 'Download source did not respond' });
            continue;
          }

          if (!response.ok || !response.body) {
            await response.body?.cancel();
            attemptLog.push({ source, outcome: 'request_failed', message: `Download source returned HTTP ${response.status}` });
            continue;
          }

          const verified = await this.persistAndVerify(response, source, candidate, request, signal);
          if (verified) {
            attemptLog.push({ source, outcome: 'verified', message: 'EPUB metadata verified' });
            return { ...verified, attempts: attemptLog };
          }
          attemptLog.push({ source, outcome: 'rejected', message: 'Candidate failed EPUB metadata verification' });
        }
      }
    }

    throw new AcquisitionAttemptsError(attemptLog);
  }

  private sourceOrder(source: AcquisitionDownloadSource): Array<Exclude<AcquisitionDownloadSource, 'auto'>> {
    if (source === 'libgen') return ['libgen'];
    if (source === 'annas_archive') return ['annas_archive'];
    return this.annas.isConfigured() ? ['annas_archive', 'libgen'] : ['libgen'];
  }

  private async persistAndVerify(
    response: Response,
    source: Exclude<AcquisitionDownloadSource, 'auto'>,
    candidate: LibgenCandidate,
    request: EpubAcquisitionDownloadRequest,
    signal?: AbortSignal,
  ): Promise<Omit<VerifiedEpubDownload, 'attempts'> | null> {
    if (!response.ok || !response.body) return null;

    const maxBytes = (await this.appSettings.getMaxUploadSizeMb()) * 1024 * 1024;
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new PayloadTooLargeException('Downloaded file exceeds the configured upload limit');
    }

    const sourceStream = Readable.fromWeb(response.body as never);
    const limitedStream = sourceStream.pipe(this.createLimitStream(maxBytes, signal));
    const { tempPath, sizeBytes } = await this.storage.streamToTemp(limitedStream);

    const metadata = await extractEpubMetadata(tempPath);
    const title = metadata?.title?.trim() ?? '';
    const validTitle = titleMatchesRequestedBook(request.title, title);
    const validAuthor = this.authorMatches(request.authors, metadata?.authors.map((author) => author.name) ?? []);
    if (!metadata || !validTitle || !validAuthor) {
      await this.storage.cleanup(tempPath);
      return null;
    }

    return {
      tempPath,
      sizeBytes,
      source,
      md5: candidate.md5,
      verifiedTitle: title,
    };
  }

  private authorMatches(requested: string[], embedded: string[]): boolean {
    if (requested.length === 0) return true;
    if (embedded.length === 0) return false;
    const embeddedNames = embedded.map(normalizeBookText);
    return requested.some((author) => {
      const normalized = normalizeBookText(author);
      const lastName = normalized.split(' ').at(-1) ?? normalized;
      return lastName.length > 1 && embeddedNames.some((candidate) => candidate.split(' ').includes(lastName));
    });
  }

  private createLimitStream(maxBytes: number, signal?: AbortSignal): Transform {
    let received = 0;
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (signal?.aborted) {
          callback(signal.reason instanceof Error ? signal.reason : new Error('Download cancelled'));
          return;
        }
        received += chunk.length;
        if (received > maxBytes) {
          callback(new PayloadTooLargeException('Downloaded file exceeds the configured upload limit'));
          return;
        }
        callback(null, chunk);
      },
    });
  }
}
