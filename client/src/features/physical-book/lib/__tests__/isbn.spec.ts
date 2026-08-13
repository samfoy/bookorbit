import { describe, expect, it } from 'vitest'

import { formatIsbn, isValidIsbn, isValidIsbn10, isValidIsbn13, normalizeIsbn, toIsbn13 } from '../isbn'

/**
 * Expectations here are DERIVED from the checksum algorithms, not hand-written.
 * An earlier pass at this used invented ISBNs whose check digits happened to be
 * wrong, which made correct code look broken -- so the fixtures compute their own
 * check digits and the test asserts against those.
 */
function isbn10CheckDigit(firstNine: string): string {
  let sum = 0
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(firstNine[i])
  const remainder = (11 - (sum % 11)) % 11
  return remainder === 10 ? 'X' : String(remainder)
}

function isbn13CheckDigit(firstTwelve: string): string {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(firstTwelve[i])
  return String((10 - (sum % 10)) % 10)
}

const DUNE_9 = '044101359'
const DUNE_10 = DUNE_9 + isbn10CheckDigit(DUNE_9)
const DUNE_13 = '978' + DUNE_9 + isbn13CheckDigit('978' + DUNE_9)

describe('normalizeIsbn', () => {
  it('strips hyphens and spaces', () => {
    expect(normalizeIsbn('978-0-441-01359-3')).toBe('9780441013593')
    expect(normalizeIsbn(' 978 0441 01359 3 ')).toBe('9780441013593')
  })

  it('uppercases a lowercase x check digit', () => {
    expect(normalizeIsbn('080442957x')).toBe('080442957X')
  })

  it('rejects wrong-length and non-numeric input', () => {
    expect(normalizeIsbn('12345')).toBeNull()
    expect(normalizeIsbn('abcdefghij')).toBeNull()
    expect(normalizeIsbn('')).toBeNull()
    // An 'X' is only legal as the ISBN-10 check digit, never mid-string.
    expect(normalizeIsbn('04410X3593')).toBeNull()
  })
})

describe('isValidIsbn10', () => {
  it('accepts a correct check digit', () => {
    expect(isValidIsbn10(DUNE_10)).toBe(true)
  })

  it('accepts X as the value-10 check digit', () => {
    const nine = '080442957'
    expect(isbn10CheckDigit(nine)).toBe('X')
    expect(isValidIsbn10(nine + 'X')).toBe(true)
  })

  it('rejects every wrong check digit for a known prefix', () => {
    const correct = isbn10CheckDigit(DUNE_9)
    for (const d of [...'0123456789X']) {
      if (d === correct) continue
      expect(isValidIsbn10(DUNE_9 + d)).toBe(false)
    }
  })
})

describe('isValidIsbn13', () => {
  it('accepts a correct check digit', () => {
    expect(isValidIsbn13(DUNE_13)).toBe(true)
  })

  it('rejects every wrong check digit for a known prefix', () => {
    const twelve = DUNE_13.slice(0, 12)
    const correct = isbn13CheckDigit(twelve)
    for (const d of [...'0123456789']) {
      if (d === correct) continue
      expect(isValidIsbn13(twelve + d)).toBe(false)
    }
  })
})

describe('isValidIsbn', () => {
  it('accepts both widths and hyphenated input', () => {
    expect(isValidIsbn(DUNE_10)).toBe(true)
    expect(isValidIsbn(DUNE_13)).toBe(true)
    const h = `${DUNE_10[0]}-${DUNE_10.slice(1, 4)}-${DUNE_10.slice(4, 9)}-${DUNE_10[9]}`
    expect(isValidIsbn(h)).toBe(true)
  })

  it('rejects malformed input rather than throwing', () => {
    expect(isValidIsbn('')).toBe(false)
    expect(isValidIsbn('nope')).toBe(false)
    expect(isValidIsbn('9780441013590')).toBe(false)
  })
})

describe('toIsbn13', () => {
  it('converts a valid ISBN-10 to its 13 form', () => {
    expect(toIsbn13(DUNE_10)).toBe(DUNE_13)
  })

  it('passes a valid 13 through unchanged', () => {
    expect(toIsbn13(DUNE_13)).toBe(DUNE_13)
  })

  it('returns null for an invalid checksum instead of a bogus conversion', () => {
    const wrong = DUNE_9 + (isbn10CheckDigit(DUNE_9) === '0' ? '1' : '0')
    expect(toIsbn13(wrong)).toBeNull()
    expect(toIsbn13('12345')).toBeNull()
  })
})

describe('formatIsbn', () => {
  it('groups an ISBN-13 for display', () => {
    expect(formatIsbn(DUNE_13)).toBe('978-0-4410-1359-3')
  })

  it('returns the input unchanged when it cannot be parsed', () => {
    expect(formatIsbn('nope')).toBe('nope')
  })
})
