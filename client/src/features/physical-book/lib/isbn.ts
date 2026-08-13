/**
 * Client-side ISBN validation, mirroring `server/src/common/utils/isbn.utils.ts`.
 *
 * This is deliberately duplicated rather than imported from `@bookorbit/types`:
 * the shared package holds types, not runtime helpers, and the scanner needs to
 * reject a misread barcode WITHOUT a round trip. A barcode scanner regularly
 * emits a wrong digit under poor lighting, and the checksum catches nearly all of
 * those locally. The server re-validates regardless -- this is a fast pre-filter,
 * never the security boundary.
 */

/** Strip separators and uppercase the ISBN-10 'X' check digit. */
export function normalizeIsbn(raw: string): string | null {
  if (!raw) return null
  const cleaned = raw.replace(/[\s-]/g, '').toUpperCase()
  if (!/^[0-9]{9}[0-9X]$|^[0-9]{13}$/.test(cleaned)) return null
  return cleaned
}

/** ISBN-10: weighted mod-11, where a remainder of 10 is written as 'X'. */
export function isValidIsbn10(isbn: string): boolean {
  if (!/^[0-9]{9}[0-9X]$/.test(isbn)) return false
  let sum = 0
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(isbn[i])
  const remainder = (11 - (sum % 11)) % 11
  const expected = remainder === 10 ? 'X' : String(remainder)
  return isbn[9] === expected
}

/** ISBN-13 / EAN-13: alternating 1,3 weights mod 10. */
export function isValidIsbn13(isbn: string): boolean {
  if (!/^[0-9]{13}$/.test(isbn)) return false
  let sum = 0
  for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(isbn[i])
  return Number(isbn[12]) === (10 - (sum % 10)) % 10
}

export function isValidIsbn(raw: string): boolean {
  const normalized = normalizeIsbn(raw)
  if (!normalized) return false
  return normalized.length === 10 ? isValidIsbn10(normalized) : isValidIsbn13(normalized)
}

/** Convert a valid ISBN-10 to its ISBN-13 form; pass a valid 13 through. */
export function toIsbn13(raw: string): string | null {
  const normalized = normalizeIsbn(raw)
  if (!normalized) return null
  if (normalized.length === 13) return isValidIsbn13(normalized) ? normalized : null
  if (!isValidIsbn10(normalized)) return null
  const core = `978${normalized.slice(0, 9)}`
  let sum = 0
  for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(core[i])
  return `${core}${(10 - (sum % 10)) % 10}`
}

/** Format an ISBN-13 for display: 978-0-441-01359-3 style grouping. */
export function formatIsbn(raw: string): string {
  const normalized = normalizeIsbn(raw)
  if (!normalized) return raw
  if (normalized.length !== 13) return normalized
  return `${normalized.slice(0, 3)}-${normalized.slice(3, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12)}`
}
