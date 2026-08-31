import { describe, expect, it, vi } from 'vitest';

import { BookDiscoveryController } from './book-discovery.controller';

const mockService = {
  search: vi.fn(),
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
    const controller = new BookDiscoveryController(mockService as never, {} as never);
    const dto = { query: 'Piranesi', sources: ['hardcover', 'storygraph'] as const };

    await expect(controller.search(dto, user as never)).resolves.toBe(response);
    expect(mockService.search).toHaveBeenCalledWith(12, dto);
  });
});
