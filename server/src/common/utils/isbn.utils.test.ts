import { describe, expect, it } from 'vitest';

import { isValidIsbn, isValidIsbn10, isValidIsbn13, normalizeIsbn, parseIsbn, toIsbn10, toIsbn13 } from './isbn.utils';

describe('isbn utils', () => {
  describe('normalizeIsbn', () => {
    it('strips separators and uppercases a trailing check letter', () => {
      expect(normalizeIsbn('978-0-306-40615-7')).toBe('9780306406157');
      expect(normalizeIsbn('978 0 306 40615 7')).toBe('9780306406157');
      expect(normalizeIsbn(' 0-8044-2957-x ')).toBe('080442957X');
    });

    it('strips Unicode dashes, which is what pasted catalog data contains', () => {
      expect(normalizeIsbn('978‐0306‑40615–7')).toBe('9780306406157');
    });

    it('returns null for anything that is not 10 or 13 characters of the right alphabet', () => {
      expect(normalizeIsbn('')).toBeNull();
      expect(normalizeIsbn(null)).toBeNull();
      expect(normalizeIsbn(undefined)).toBeNull();
      expect(normalizeIsbn('not-a-book')).toBeNull();
      expect(normalizeIsbn('978030640615')).toBeNull();
      expect(normalizeIsbn('97803064061578')).toBeNull();
      expect(normalizeIsbn('03064061X2')).toBeNull();
      expect(normalizeIsbn('978030640615X')).toBeNull();
    });
  });

  describe('isValidIsbn10', () => {
    it('accepts a valid mod-11 ISBN-10, including an X check digit', () => {
      expect(isValidIsbn10('0306406152')).toBe(true);
      expect(isValidIsbn10('080442957X')).toBe(true);
      expect(isValidIsbn10('0-8044-2957-x')).toBe(true);
    });

    it('rejects a single-digit transposition', () => {
      expect(isValidIsbn10('0306406512')).toBe(false);
    });

    it('rejects wrong length, non-numeric, and 13-digit input', () => {
      expect(isValidIsbn10('030640615')).toBe(false);
      expect(isValidIsbn10('030640615Z')).toBe(false);
      expect(isValidIsbn10('9780306406157')).toBe(false);
      expect(isValidIsbn10(null)).toBe(false);
    });
  });

  describe('isValidIsbn13', () => {
    it('accepts a valid mod-10 EAN-13 under both the 978 and 979 prefixes', () => {
      expect(isValidIsbn13('9780306406157')).toBe(true);
      expect(isValidIsbn13('978-0-306-40615-7')).toBe(true);
      expect(isValidIsbn13('9791234567896')).toBe(true);
    });

    it('rejects a single-digit transposition', () => {
      expect(isValidIsbn13('9780306406175')).toBe(false);
    });

    it('rejects a wrong check digit, wrong length, and ISBN-10 input', () => {
      expect(isValidIsbn13('9780306406158')).toBe(false);
      expect(isValidIsbn13('978030640615')).toBe(false);
      expect(isValidIsbn13('0306406152')).toBe(false);
      expect(isValidIsbn13('')).toBe(false);
    });
  });

  it('isValidIsbn accepts either width', () => {
    expect(isValidIsbn('0306406152')).toBe(true);
    expect(isValidIsbn('9780306406157')).toBe(true);
    expect(isValidIsbn('9780306406158')).toBe(false);
  });

  describe('toIsbn13', () => {
    it('converts a valid ISBN-10 by prefixing 978 and recomputing the check digit', () => {
      expect(toIsbn13('0306406152')).toBe('9780306406157');
      expect(toIsbn13('080442957X')).toBe('9780804429573');
    });

    it('passes a valid 13 straight through and rejects an invalid one', () => {
      expect(toIsbn13('978-0-306-40615-7')).toBe('9780306406157');
      expect(toIsbn13('9780306406158')).toBeNull();
      expect(toIsbn13('0306406512')).toBeNull();
      expect(toIsbn13('garbage')).toBeNull();
    });
  });

  describe('toIsbn10', () => {
    it('converts a 978-prefixed ISBN-13 back, restoring an X check digit', () => {
      expect(toIsbn10('9780306406157')).toBe('0306406152');
      expect(toIsbn10('9780804429573')).toBe('080442957X');
    });

    it('returns null for a 979 prefix, which has no ISBN-10 equivalent', () => {
      expect(toIsbn10('9791234567896')).toBeNull();
    });
  });

  describe('parseIsbn', () => {
    it('round trips 10 to 13 and back', () => {
      expect(parseIsbn('0-306-40615-2')).toEqual({ isbn13: '9780306406157', isbn10: '0306406152' });
      expect(parseIsbn('978 0 804 42957 3')).toEqual({ isbn13: '9780804429573', isbn10: '080442957X' });
    });

    it('reports a 979 ISBN-13 with no ISBN-10 form', () => {
      expect(parseIsbn('9791234567896')).toEqual({ isbn13: '9791234567896', isbn10: null });
    });

    it('returns null on empty and garbage input rather than throwing', () => {
      expect(parseIsbn('')).toBeNull();
      expect(parseIsbn(null)).toBeNull();
      expect(parseIsbn('9780306406158')).toBeNull();
      expect(parseIsbn('hello world')).toBeNull();
    });
  });
});
