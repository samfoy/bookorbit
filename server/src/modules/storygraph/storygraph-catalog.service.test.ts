import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StorygraphCatalogService } from './storygraph-catalog.service';

const mockClient = {
  get: vi.fn(),
};

const mockSettings = {
  getCookiesForUser: vi.fn(),
};

function makeService() {
  return new StorygraphCatalogService(mockClient as never, mockSettings as never);
}

describe('StorygraphCatalogService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.getCookiesForUser.mockResolvedValue({ sessionCookie: 'session', rememberToken: 'remember' });
  });

  it('reports an expired authenticated session as unavailable', async () => {
    mockClient.get.mockResolvedValue({ status: 200, redirectedToSignIn: true, html: '' });

    await expect(makeService().search(9, 'Piranesi')).rejects.toThrow('StoryGraph session has expired');
  });

  it('maps authenticated StoryGraph browse results', async () => {
    mockClient.get.mockResolvedValue({
      status: 200,
      redirectedToSignIn: false,
      html: `
        <div class="book-pane">
          <img src="/covers/piranesi.jpg" alt="Cover of Piranesi" />
          <div class="book-title-author-and-series">
            <h3><a href="/books/7d3e-piranesi">Piranesi</a></h3>
            <p>by <a href="/authors/susanna-clarke">Susanna Clarke</a></p>
          </div>
        </div>
      `,
    });

    const result = await makeService().search(9, 'Piranesi');

    expect(mockClient.get).toHaveBeenCalledWith(9, { sessionCookie: 'session', rememberToken: 'remember' }, '/browse?search_term=Piranesi');
    expect(result).toEqual([
      {
        id: 'storygraph:7d3e-piranesi',
        title: 'Piranesi',
        authors: ['Susanna Clarke'],
        coverUrl: 'https://app.thestorygraph.com/covers/piranesi.jpg',
        description: null,
        publishedYear: null,
        rating: null,
        ratingsCount: null,
        isbn10: null,
        isbn13: null,
        pageCount: null,
        seriesName: null,
        seriesPosition: null,
        hasEbook: null,
        sources: [
          {
            source: 'storygraph',
            externalId: '7d3e-piranesi',
            url: 'https://app.thestorygraph.com/books/7d3e-piranesi',
          },
        ],
      },
    ]);
  });
});
