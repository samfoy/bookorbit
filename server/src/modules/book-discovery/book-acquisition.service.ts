import type { BookAcquisitionJob, BookAcquisitionStatus, CreateBookAcquisitionRequest } from '@bookorbit/types';
import { HttpException, HttpStatus, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { UploadService } from '../upload/upload.service';
import { UploadStorageService } from '../upload/upload-storage.service';
import { EpubAcquisitionDownloaderService } from './epub-acquisition-downloader.service';
import { X3EpubOptimizerService } from './x3-epub-optimizer.service';

const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
const JOB_TIMEOUT_MS = 45 * 60 * 1000;
const MAX_ACTIVE_JOBS = 8;
const MAX_ACTIVE_JOBS_PER_USER = 2;

interface InternalJob {
  userId: number;
  public: BookAcquisitionJob;
  abortController: AbortController;
}

@Injectable()
export class BookAcquisitionService {
  private readonly logger = new Logger(BookAcquisitionService.name);
  private readonly jobs = new Map<string, InternalJob>();

  constructor(
    private readonly libraryService: LibraryService,
    private readonly downloader: EpubAcquisitionDownloaderService,
    private readonly optimizer: X3EpubOptimizerService,
    private readonly uploadService: UploadService,
    private readonly storage: UploadStorageService,
  ) {}

  async start(user: RequestUser, request: CreateBookAcquisitionRequest): Promise<BookAcquisitionJob> {
    await this.libraryService.verifyUserAccess(user.id, request.libraryId, user.isSuperuser);
    this.removeExpiredJobs();
    const activeJobs = [...this.jobs.values()].filter((job) => this.isActive(job.public.status));
    if (activeJobs.filter((job) => job.userId === user.id).length >= MAX_ACTIVE_JOBS_PER_USER) {
      throw new HttpException('Too many active book acquisitions', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (activeJobs.length >= MAX_ACTIVE_JOBS) {
      throw new ServiceUnavailableException('Book acquisition capacity is temporarily full');
    }
    const now = new Date().toISOString();
    const internal: InternalJob = {
      userId: user.id,
      abortController: new AbortController(),
      public: {
        id: randomUUID(),
        title: request.title,
        author: request.authors[0] ?? null,
        status: 'queued',
        source: request.source,
        libraryId: request.libraryId,
        bookId: null,
        bytesDownloaded: null,
        x3Optimized: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      },
    };
    this.jobs.set(internal.public.id, internal);
    void this.run(internal, user, request);
    return this.snapshot(internal.public);
  }

  getJob(userId: number, jobId: string): BookAcquisitionJob {
    this.removeExpiredJobs();
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) throw new NotFoundException('Acquisition job not found');
    return this.snapshot(job.public);
  }

  listJobs(userId: number): BookAcquisitionJob[] {
    this.removeExpiredJobs();
    return [...this.jobs.values()]
      .filter((job) => job.userId === userId)
      .map((job) => this.snapshot(job.public))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getCapabilities() {
    return this.downloader.getCapabilities();
  }

  cancel(userId: number, jobId: string): BookAcquisitionJob {
    const internal = this.jobs.get(jobId);
    if (!internal || internal.userId !== userId) throw new NotFoundException('Acquisition job not found');
    if (this.isCancellable(internal.public.status)) {
      internal.abortController.abort(new Error('Acquisition cancelled'));
      this.update(internal, { status: 'cancelled', error: null });
    }
    return this.snapshot(internal.public);
  }

  private async run(internal: InternalJob, user: RequestUser, request: CreateBookAcquisitionRequest): Promise<void> {
    const startedAt = Date.now();
    const timeout = setTimeout(() => internal.abortController.abort(new Error('Acquisition timed out')), JOB_TIMEOUT_MS);
    let tempPath: string | null = null;
    this.logger.log(
      `[book_acquisition.run] [start] userId=${user.id} libraryId=${request.libraryId} jobId=${internal.public.id} source=${request.source} - acquisition started`,
    );

    try {
      this.update(internal, { status: 'downloading' });
      const download = await this.downloader.download(request, internal.abortController.signal);
      internal.abortController.signal.throwIfAborted();
      tempPath = download.tempPath;
      this.update(internal, { source: download.source, bytesDownloaded: download.sizeBytes, status: 'optimizing' });

      const optimization = await this.optimizer.optimize(download.tempPath);
      internal.abortController.signal.throwIfAborted();
      this.update(internal, { x3Optimized: optimization.optimized, status: 'importing' });

      const upload = await this.uploadService.upload(
        request.libraryId,
        request.folderId,
        this.filenameFor(request.title),
        createReadStream(download.tempPath),
        user,
      );
      this.update(internal, { status: 'completed', bookId: upload.bookId, error: null });
      this.logger.log(
        `[book_acquisition.run] [end] userId=${user.id} libraryId=${request.libraryId} jobId=${internal.public.id} bookId=${upload.bookId} durationMs=${Date.now() - startedAt} source=${download.source} x3Optimized=${optimization.optimized} - acquisition completed`,
      );
    } catch (error) {
      const cancelled = internal.abortController.signal.aborted;
      const message = cancelled ? 'Acquisition cancelled' : this.publicError(error);
      this.update(internal, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : message });
      const errorClass = error instanceof Error ? error.constructor.name : 'Error';
      this.logger.warn(
        `[book_acquisition.run] [fail] userId=${user.id} libraryId=${request.libraryId} jobId=${internal.public.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - acquisition failed`,
      );
    } finally {
      clearTimeout(timeout);
      if (tempPath) await this.storage.cleanup(tempPath);
    }
  }

  private update(internal: InternalJob, patch: Partial<BookAcquisitionJob>): void {
    Object.assign(internal.public, patch, { updatedAt: new Date().toISOString() });
  }

  private snapshot(job: BookAcquisitionJob): BookAcquisitionJob {
    return { ...job };
  }

  private filenameFor(title: string): string {
    const stem = title
      .replace(/[\\/\0]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
    return `${stem || 'book'}.epub`;
  }

  private publicError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message.slice(0, 240);
    return 'Book acquisition failed';
  }

  private isActive(status: BookAcquisitionStatus): boolean {
    return status === 'queued' || status === 'downloading' || status === 'optimizing' || status === 'importing';
  }

  private isCancellable(status: BookAcquisitionStatus): boolean {
    return status === 'queued' || status === 'downloading' || status === 'optimizing';
  }

  private removeExpiredJobs(): void {
    const cutoff = Date.now() - JOB_RETENTION_MS;
    for (const [id, job] of this.jobs) {
      if (!this.isActive(job.public.status) && Date.parse(job.public.updatedAt) < cutoff) this.jobs.delete(id);
    }
  }
}
