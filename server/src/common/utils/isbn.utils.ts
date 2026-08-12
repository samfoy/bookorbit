const ISBN10_PATTERN = /^\d{9}[\dX]$/;
const ISBN13_PATTERN = /^\d{13}$/;

// Scanners and pasted catalog data separate groups with whitespace or any Unicode dash
// (\p{Pd} covers the ASCII hyphen plus U+2010..U+2015), so strip both before validating.
const SEPARATORS = /[\s\p{Pd}]/gu;

export function normalizeIsbn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.replace(SEPARATORS, '').toUpperCase();
  if (ISBN13_PATTERN.test(stripped)) return stripped;
  if (ISBN10_PATTERN.test(stripped)) return stripped;
  return null;
}

export function isValidIsbn10(value: string | null | undefined): boolean {
  const normalized = normalizeIsbn(value);
  if (!normalized || !ISBN10_PATTERN.test(normalized)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const char = normalized[i]!;
    const digit = char === 'X' ? 10 : Number(char);
    sum += digit * (10 - i);
  }
  return sum % 11 === 0;
}

export function isValidIsbn13(value: string | null | undefined): boolean {
  const normalized = normalizeIsbn(value);
  if (!normalized || !ISBN13_PATTERN.test(normalized)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    sum += Number(normalized[i]!) * (i % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

export function isValidIsbn(value: string | null | undefined): boolean {
  return isValidIsbn10(value) || isValidIsbn13(value);
}

export function toIsbn13(value: string | null | undefined): string | null {
  const normalized = normalizeIsbn(value);
  if (!normalized) return null;
  if (ISBN13_PATTERN.test(normalized)) return isValidIsbn13(normalized) ? normalized : null;
  if (!isValidIsbn10(normalized)) return null;
  const body = `978${normalized.slice(0, 9)}`;
  return `${body}${isbn13CheckDigit(body)}`;
}

export function toIsbn10(value: string | null | undefined): string | null {
  const normalized = normalizeIsbn(value);
  if (!normalized) return null;
  if (ISBN10_PATTERN.test(normalized)) return isValidIsbn10(normalized) ? normalized : null;
  if (!isValidIsbn13(normalized) || !normalized.startsWith('978')) return null;
  const body = normalized.slice(3, 12);
  return `${body}${isbn10CheckDigit(body)}`;
}

export function parseIsbn(raw: string | null | undefined): { isbn13: string; isbn10: string | null } | null {
  const isbn13 = toIsbn13(raw);
  if (!isbn13) return null;
  return { isbn13, isbn10: toIsbn10(isbn13) };
}

function isbn13CheckDigit(body12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(body12[i]!) * (i % 2 === 0 ? 1 : 3);
  }
  return String((10 - (sum % 10)) % 10);
}

function isbn10CheckDigit(body9: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(body9[i]!) * (10 - i);
  }
  const check = (11 - (sum % 11)) % 11;
  return check === 10 ? 'X' : String(check);
}
