import { Permission } from '@bookorbit/types';
import { describe, expect, it, vi } from 'vitest';

import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { makeRequestUser } from '../upload/test-helpers';
import { BookDiscoveryController } from './book-discovery.controller';

const user = makeRequestUser({ id: 17, permissions: [Permission.LibraryUpload] });

function makeController() {
  const discovery = { search: vi.fn() };
  const acquisitions = {
    start: vi.fn(),
    listJobs: vi.fn(),
    getJob: vi.fn(),
    cancel: vi.fn(),
    getCapabilities: vi.fn(),
  };
  return {
    controller: new BookDiscoveryController(discovery as never, acquisitions as never),
    acquisitions,
  };
}

describe('book acquisition routes', () => {
  it('starts a user-scoped acquisition behind the upload permission', async () => {
    const { controller, acquisitions } = makeController();
    const dto = {
      libraryId: 3,
      folderId: 9,
      title: 'Piranesi',
      authors: ['Susanna Clarke'],
      isbn13: '9781635575637',
      source: 'auto' as const,
    };
    acquisitions.start.mockResolvedValue({ id: 'job-1', status: 'queued' });

    await controller.startAcquisition(dto, user);

    expect(acquisitions.start).toHaveBeenCalledWith(user, dto);
    expect(Reflect.getMetadata(PERMISSION_KEY, BookDiscoveryController.prototype.startAcquisition)).toBe(Permission.LibraryUpload);
  });

  it('lists, reads, and cancels only the current user jobs', () => {
    const { controller, acquisitions } = makeController();

    controller.listAcquisitions(user);
    controller.getAcquisition('job-1', user);
    controller.cancelAcquisition('job-1', user);

    expect(acquisitions.listJobs).toHaveBeenCalledWith(17);
    expect(acquisitions.getJob).toHaveBeenCalledWith(17, 'job-1');
    expect(acquisitions.cancel).toHaveBeenCalledWith(17, 'job-1');
  });

  it('exposes acquisition source capabilities to upload-capable users', () => {
    const { controller, acquisitions } = makeController();
    acquisitions.getCapabilities.mockReturnValue([{ source: 'libgen', available: true }]);

    expect(controller.getAcquisitionSources()).toEqual([{ source: 'libgen', available: true }]);
    expect(Reflect.getMetadata(PERMISSION_KEY, BookDiscoveryController.prototype.getAcquisitionSources)).toBe(Permission.LibraryUpload);
  });
});
