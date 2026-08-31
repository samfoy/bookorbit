import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HardcoverReadBooksService } from './hardcover-read-books.service';

const client = { query: vi.fn() };
const settings = { getTokenForUser: vi.fn() };

function makeService() {
  return new HardcoverReadBooksService(client as never, settings as never);
}

describe('HardcoverReadBooksService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.getTokenForUser.mockResolvedValue('stored-token');
  });

  it('pages through every read book and caches the user-scoped id set', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({ book_id: index + 1 }));
    client.query.mockResolvedValueOnce({ me: [{ user_books: firstPage }] }).mockResolvedValueOnce({ me: [{ user_books: [{ book_id: 201 }] }] });
    const service = makeService();

    const first = await service.getReadBookIds(7);
    const second = await service.getReadBookIds(7);

    expect(first.size).toBe(201);
    expect(first.has(201)).toBe(true);
    expect(second).toBe(first);
    expect(client.query).toHaveBeenNthCalledWith(1, 7, 'stored-token', expect.stringContaining('status_id'), { limit: 200, offset: 0 });
    expect(client.query).toHaveBeenNthCalledWith(2, 7, 'stored-token', expect.stringContaining('status_id'), { limit: 200, offset: 200 });
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('returns an empty set when Hardcover is not configured', async () => {
    settings.getTokenForUser.mockResolvedValue(null);

    await expect(makeService().getReadBookIds(7)).resolves.toEqual(new Set());
    expect(client.query).not.toHaveBeenCalled();
  });
});
