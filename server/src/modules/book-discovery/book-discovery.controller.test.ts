import { describe, expect, it, vi } from 'vitest';

import { BookDiscoveryController } from './book-discovery.controller';

const mockService = {
  search: vi.fn(),
};
const mockBrowse = {
  getBrowseHome: vi.fn(),
  browse: vi.fn(),
};

const user = {
  id: 12,
  username: 'reader',
  isSuperuser: false,
  permissions: [],
  contentFilters: [],
};

describe('BookDiscoveryController', () => {
  it('searches with the authenticated user id and validated query', async () => {
    const response = { results: [], sources: [] };
    mockService.search.mockResolvedValue(response);
    const controller = new BookDiscoveryController(mockService as never, {} as never, mockBrowse as never);
    const dto = { query: 'Piranesi', sources: ['hardcover', 'storygraph'] as const };

    await expect(controller.search(dto, user as never)).resolves.toBe(response);
    expect(mockService.search).toHaveBeenCalledWith(12, dto);
  });

  it('loads browse home and paginated browse for the authenticated user', async () => {
    const home = { generatedAt: 'now', trending: {}, genreShelves: [], genres: [] };
    const page = { kind: 'genre', items: [] };
    mockBrowse.getBrowseHome.mockResolvedValue(home);
    mockBrowse.browse.mockResolvedValue(page);
    const controller = new BookDiscoveryController(mockService as never, {} as never, mockBrowse as never);
    const dto = { kind: 'genre' as const, value: 'fantasy', page: 2, pageSize: 20, hideRead: true };

    await expect(controller.browseHome({ hideRead: true }, user as never)).resolves.toBe(home);
    await expect(controller.browse(dto, user as never)).resolves.toBe(page);
    expect(mockBrowse.getBrowseHome).toHaveBeenCalledWith(12, true);
    expect(mockBrowse.browse).toHaveBeenCalledWith(12, dto);
  });
});
