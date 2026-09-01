import { describe, expect, it } from 'vitest';

import { isBundleTitle, titleMatchesRequestedBook } from './book-match.util';

describe('book acquisition matching', () => {
  it('rejects a different numbered volume that only mentions the requested series', () => {
    expect(titleMatchesRequestedBook('Red Rising', 'Morning Star: Book III of the Red Rising Trilogy')).toBe(false);
    expect(titleMatchesRequestedBook('Dungeon Crawler Carl', 'Dungeon Crawler Carl - 07 - This Inevitable Ruin')).toBe(false);
  });

  it('rejects a distinct sequel that only extends a short requested title', () => {
    expect(titleMatchesRequestedBook('Dune', 'Dune Messiah')).toBe(false);
    expect(titleMatchesRequestedBook('The Shining', 'Doctor Sleep')).toBe(false);
  });

  it('rejects a parenthesized later volume when the request has no volume', () => {
    expect(titleMatchesRequestedBook('The Shining', 'The Shining (Book 2)')).toBe(false);
  });

  it('accepts the requested numbered book with a series subtitle', () => {
    expect(titleMatchesRequestedBook('Morning Star', 'Morning Star: Book III of the Red Rising Trilogy')).toBe(true);
  });

  it('recognizes omnibus and multi-book bundle titles', () => {
    expect(isBundleTitle('The Hunger Games 4-Book Digital Collection')).toBe(true);
    expect(isBundleTitle('The Complete Trilogy Box Set')).toBe(true);
    expect(isBundleTitle('The Hunger Games')).toBe(false);
  });
});
