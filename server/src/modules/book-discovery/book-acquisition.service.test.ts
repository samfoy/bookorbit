import { rm, writeFile } from 'fs/promises';
import { describe, expect, it, vi } from 'vitest';

import { makeRequestUser } from '../upload/test-helpers';
import { BookAcquisitionService } from './book-acquisition.service';

const user = makeRequestUser({ id: 42, permissions: ['library_upload'] as never });

function makeService() {
  const library = { verifyUserAccess: vi.fn().mockResolvedValue(undefined) };
  const downloader = {
    download: vi.fn().mockResolvedValue({
      tempPath: '/tmp/acquired-piranesi.epub',
      sizeBytes: 12345,
      source: 'libgen',
      md5: '11111111111111111111111111111111',
      verifiedTitle: 'Piranesi',
    }),
  };
  const optimizer = {
    optimize: vi.fn().mockResolvedValue({ optimized: true, alreadyPresent: false, manifestBytes: 850, reason: null }),
  };
  const upload = {
    upload: vi.fn().mockImplementation(async (_libraryId, _folderId, _filename, stream: AsyncIterable<Buffer>) => {
      for await (const chunk of stream) {
        void chunk;
        // Consume the stream like UploadService does before resolving.
      }
      return { bookId: 55, filename: 'Piranesi.epub', format: 'epub', sizeBytes: 13000 };
    }),
  };
  const storage = { cleanup: vi.fn().mockImplementation((path: string) => rm(path, { force: true })) };

  return {
    service: new BookAcquisitionService(library as never, downloader as never, optimizer as never, upload as never, storage as never),
    library,
    downloader,
    optimizer,
    upload,
    storage,
  };
}

describe('BookAcquisitionService', () => {
  it('does not import a book cancelled while optimization is running', async () => {
    await writeFile('/tmp/acquired-piranesi.epub', 'test epub');
    const { service, optimizer, upload, storage } = makeService();
    let finishOptimization: ((value: { optimized: boolean; alreadyPresent: boolean; manifestBytes: number; reason: null }) => void) | undefined;
    optimizer.optimize.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOptimization = resolve;
        }),
    );

    const started = await service.start(user, {
      libraryId: 3,
      title: 'Piranesi',
      authors: ['Susanna Clarke'],
      source: 'libgen',
    });
    await vi.waitFor(() => expect(service.getJob(user.id, started.id).status).toBe('optimizing'));

    expect(service.cancel(user.id, started.id).status).toBe('cancelled');
    finishOptimization?.({ optimized: true, alreadyPresent: false, manifestBytes: 850, reason: null });
    await vi.waitFor(() => expect(storage.cleanup).toHaveBeenCalledWith('/tmp/acquired-piranesi.epub'));

    expect(service.getJob(user.id, started.id).status).toBe('cancelled');
    expect(upload.upload).not.toHaveBeenCalled();
  });

  it('does not report an in-flight import as cancelled when upload cannot be rolled back', async () => {
    await writeFile('/tmp/acquired-piranesi.epub', 'test epub');
    const { service, upload } = makeService();
    let finishUpload: ((value: { bookId: number; filename: string; format: string; sizeBytes: number }) => void) | undefined;
    upload.upload.mockImplementation(async (_libraryId, _folderId, _filename, stream: AsyncIterable<Buffer>) => {
      for await (const chunk of stream) void chunk;
      return new Promise((resolve) => {
        finishUpload = resolve;
      });
    });

    const started = await service.start(user, {
      libraryId: 3,
      title: 'Piranesi',
      authors: ['Susanna Clarke'],
      source: 'libgen',
    });
    await vi.waitFor(() => {
      expect(service.getJob(user.id, started.id).status).toBe('importing');
      expect(finishUpload).toBeDefined();
    });

    expect(service.cancel(user.id, started.id).status).toBe('importing');
    finishUpload?.({ bookId: 55, filename: 'Piranesi.epub', format: 'epub', sizeBytes: 13000 });
    await vi.waitFor(() => expect(service.getJob(user.id, started.id).status).toBe('completed'));
  });

  it('limits concurrent acquisitions per user', async () => {
    const { service, downloader } = makeService();
    downloader.download.mockImplementation(
      (_request: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason instanceof Error ? signal.reason : new Error('Acquisition cancelled')), {
            once: true,
          });
        }),
    );
    const request = {
      libraryId: 3,
      title: 'Piranesi',
      authors: ['Susanna Clarke'],
      source: 'libgen' as const,
    };
    const jobs = [await service.start(user, request), await service.start(user, request)];
    const thirdStart = service.start(user, request);

    try {
      await expect(thirdStart).rejects.toThrow('Too many active book acquisitions');
    } finally {
      const third = await thirdStart.catch(() => null);
      if (third) jobs.push(third);
      for (const job of jobs) service.cancel(user.id, job.id);
      await vi.waitFor(() => expect(service.listJobs(user.id).every((job) => job.status === 'cancelled')).toBe(true));
    }
  });

  it('limits concurrent acquisitions across users', async () => {
    const { service, downloader } = makeService();
    downloader.download.mockImplementation(
      (_request: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason instanceof Error ? signal.reason : new Error('Acquisition cancelled')), {
            once: true,
          });
        }),
    );
    const request = {
      libraryId: 3,
      title: 'Piranesi',
      authors: ['Susanna Clarke'],
      source: 'libgen' as const,
    };
    const users = Array.from({ length: 9 }, (_, index) => makeRequestUser({ id: index + 1, permissions: ['library_upload'] as never }));
    const jobs = await Promise.all(users.slice(0, 8).map((requestUser) => service.start(requestUser, request)));
    const ninthStart = service.start(users[8]!, request);

    try {
      await expect(ninthStart).rejects.toThrow('Book acquisition capacity is temporarily full');
    } finally {
      const ninth = await ninthStart.catch(() => null);
      if (ninth) jobs.push(ninth);
      jobs.forEach((job, index) => service.cancel(users[index]!.id, job.id));
      await vi.waitFor(() =>
        expect(users.slice(0, jobs.length).every((requestUser) => service.listJobs(requestUser.id)[0]?.status === 'cancelled')).toBe(true),
      );
    }
  });

  it('runs verified downloads through the existing upload lifecycle', async () => {
    await writeFile('/tmp/acquired-piranesi.epub', 'test epub');
    const { service, library, downloader, optimizer, upload, storage } = makeService();
    const request = {
      libraryId: 3,
      folderId: 9,
      title: 'Piranesi',
      authors: ['Susanna Clarke'],
      isbn13: '9781635575637',
      source: 'libgen' as const,
    };

    const started = await service.start(user, request);

    await vi.waitFor(() => {
      expect(service.getJob(user.id, started.id).status).toBe('completed');
    });
    const completed = service.getJob(user.id, started.id);
    expect(completed).toMatchObject({
      title: 'Piranesi',
      author: 'Susanna Clarke',
      status: 'completed',
      source: 'libgen',
      libraryId: 3,
      bookId: 55,
      bytesDownloaded: 12345,
      x3Optimized: true,
      error: null,
    });
    expect(library.verifyUserAccess).toHaveBeenCalledWith(42, 3, false);
    expect(downloader.download).toHaveBeenCalledWith(expect.objectContaining(request), expect.any(AbortSignal));
    expect(optimizer.optimize).toHaveBeenCalledWith('/tmp/acquired-piranesi.epub');
    expect(upload.upload).toHaveBeenCalledWith(3, 9, 'Piranesi.epub', expect.anything(), user);
    expect(storage.cleanup).toHaveBeenCalledWith('/tmp/acquired-piranesi.epub');
  });
});
