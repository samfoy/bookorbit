import { Permission } from '@bookorbit/types';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { makeRequestUser } from '../upload/test-helpers';
import { KoreaderStoreService } from './koreader-store.service';

const uploadUser = makeRequestUser({ id: 17, permissions: [Permission.LibraryUpload] });
const deniedUser = makeRequestUser({ id: 18, permissions: [] });
const superuser = makeRequestUser({ id: 19, isSuperuser: true, permissions: [] });

function makeService() {
  const discovery = { search: vi.fn() };
  const browse = { getBrowseHome: vi.fn(), browse: vi.fn() };
  const acquisitions = {
    start: vi.fn(),
    listJobs: vi.fn(),
    getJob: vi.fn(),
    cancel: vi.fn(),
    getCapabilities: vi.fn(),
  };
  const libraries = { findAll: vi.fn() };
  return {
    service: new KoreaderStoreService(discovery as never, browse as never, acquisitions as never, libraries as never),
    discovery,
    browse,
    acquisitions,
    libraries,
  };
}

describe('KoreaderStoreService', () => {
  it('delegates home, browse, and search with the authenticated user id', async () => {
    const { service, discovery, browse } = makeService();
    browse.getBrowseHome.mockResolvedValue({ generatedAt: 'now' });
    browse.browse.mockResolvedValue({ id: 'genre-fantasy' });
    discovery.search.mockResolvedValue({ results: [], sources: [] });

    await expect(service.getHome(uploadUser, { hideRead: false })).resolves.toEqual({ generatedAt: 'now' });
    await expect(service.browse(uploadUser, { kind: 'genre', value: 'fantasy', page: 2, pageSize: 12, hideRead: true })).resolves.toEqual({
      id: 'genre-fantasy',
    });
    await expect(service.search(uploadUser, { query: 'Piranesi', sources: ['hardcover'] })).resolves.toEqual({ results: [], sources: [] });

    expect(browse.getBrowseHome).toHaveBeenCalledWith(17, false);
    expect(browse.browse).toHaveBeenCalledWith(17, { kind: 'genre', value: 'fantasy', page: 2, pageSize: 12, hideRead: true });
    expect(discovery.search).toHaveBeenCalledWith(17, { query: 'Piranesi', sources: ['hardcover'] });
  });

  it('maps only safe acquisition capabilities and accessible library fields', async () => {
    const { service, acquisitions, libraries } = makeService();
    acquisitions.getCapabilities.mockReturnValue([{ source: 'libgen', available: true, label: 'LibGen', message: null, secret: 'must-not-leak' }]);
    libraries.findAll.mockResolvedValue([
      {
        id: 3,
        name: 'Books',
        icon: 'book',
        fileNamingPattern: '{title}',
        folders: [{ id: 9, path: '/books', createdAt: new Date(), credential: 'must-not-leak' }],
      },
    ]);

    await expect(service.getConfig(uploadUser)).resolves.toEqual({
      sources: [{ source: 'libgen', available: true, label: 'LibGen', message: null }],
      libraries: [{ id: 3, name: 'Books', folders: [{ id: 9, path: '/books' }] }],
    });
    expect(libraries.findAll).toHaveBeenCalledWith(uploadUser);
  });

  it('delegates every acquisition lifecycle method with user scoping', async () => {
    const { service, acquisitions } = makeService();
    const request = { libraryId: 3, title: 'Piranesi', authors: ['Susanna Clarke'], source: 'auto' as const };

    await service.startAcquisition(uploadUser, request);
    service.listAcquisitions(uploadUser);
    service.getAcquisition(uploadUser, '379ad1d5-8115-4b61-90ff-9318e8a3ce9c');
    service.cancelAcquisition(uploadUser, '379ad1d5-8115-4b61-90ff-9318e8a3ce9c');

    expect(acquisitions.start).toHaveBeenCalledWith(uploadUser, request);
    expect(acquisitions.listJobs).toHaveBeenCalledWith(17);
    expect(acquisitions.getJob).toHaveBeenCalledWith(17, '379ad1d5-8115-4b61-90ff-9318e8a3ce9c');
    expect(acquisitions.cancel).toHaveBeenCalledWith(17, '379ad1d5-8115-4b61-90ff-9318e8a3ce9c');
  });

  it.each([
    [
      'start',
      (service: KoreaderStoreService) =>
        service.startAcquisition(deniedUser, { libraryId: 3, title: 'Dune', authors: ['Frank Herbert'], source: 'auto' }),
    ],
    ['list', (service: KoreaderStoreService) => service.listAcquisitions(deniedUser)],
    ['get', (service: KoreaderStoreService) => service.getAcquisition(deniedUser, '379ad1d5-8115-4b61-90ff-9318e8a3ce9c')],
    ['cancel', (service: KoreaderStoreService) => service.cancelAcquisition(deniedUser, '379ad1d5-8115-4b61-90ff-9318e8a3ce9c')],
  ])('denies acquisition %s without LibraryUpload before delegation', (_name, invoke) => {
    const { service, acquisitions } = makeService();

    expect(() => invoke(service)).toThrow(ForbiddenException);
    expect(acquisitions.start).not.toHaveBeenCalled();
    expect(acquisitions.listJobs).not.toHaveBeenCalled();
    expect(acquisitions.getJob).not.toHaveBeenCalled();
    expect(acquisitions.cancel).not.toHaveBeenCalled();
  });

  it('allows a superuser to access acquisition lifecycle methods without the explicit permission', () => {
    const { service, acquisitions } = makeService();

    service.listAcquisitions(superuser);

    expect(acquisitions.listJobs).toHaveBeenCalledWith(19);
  });
});
