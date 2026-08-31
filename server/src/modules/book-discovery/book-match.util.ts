const ROMAN_NUMERALS: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
  xi: 11,
  xii: 12,
  xiii: 13,
  xiv: 14,
  xv: 15,
};

const TITLE_STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'to',
  'in',
  'on',
  'novel',
  'book',
  'vol',
  'volume',
  'part',
  'edition',
  'retail',
]);
const BUNDLE_PATTERN = /\b(?:\d+\s*[- ]?book|collection|box\s*set|complete\s+series|omnibus|trilogy\s+box|books?\s+\d+\s*[-–]\s*\d+)\b/i;

export function normalizeBookText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function extractVolume(value: string): number | null {
  const raw = value.toLowerCase();
  const numeric = /#\s*(\d{1,3})\b|\s-\s*(\d{1,3})\s*-\s|\b(?:book|vol|volume|part|no)\s*(\d{1,3})\b/.exec(raw);
  const numericValue = numeric?.slice(1).find(Boolean);
  if (numericValue) return Number(numericValue);

  const roman = /\b(?:book|vol|volume|part)\s+([ivx]{1,5})\b/.exec(normalizeBookText(value));
  return roman?.[1] ? (ROMAN_NUMERALS[roman[1]] ?? null) : null;
}

export function isBundleTitle(value: string): boolean {
  return BUNDLE_PATTERN.test(value);
}

export function titleMatchesRequestedBook(requested: string, candidate: string): boolean {
  if (!requested.trim() || !candidate.trim() || isBundleTitle(candidate)) return false;

  const requestedVolume = extractVolume(requested);
  const candidateVolume = extractVolume(candidate);
  if (requestedVolume !== null && candidateVolume !== null && requestedVolume !== candidateVolume) return false;

  const requestedWords = coreWords(requested);
  const candidateWords = coreWords(candidate);
  if (requestedWords.size === 0 || candidateWords.size === 0) return false;

  const overlap = [...requestedWords].filter((word) => candidateWords.has(word)).length;
  const requestedCoverage = overlap / requestedWords.size;
  const candidateCoverage = overlap / candidateWords.size;
  if (requestedCoverage < 0.7 || candidateCoverage < 0.7) return false;

  if (requestedVolume === null && candidateVolume !== null && candidateVolume > 1) {
    const separated = /\s-\s*\d{1,3}\s*-\s/.exec(candidate);
    if (separated?.index !== undefined) {
      const suffix = normalizeBookText(candidate.slice(separated.index + separated[0].length));
      if (suffix && !normalizeBookText(requested).includes(suffix)) return false;
    }

    if (candidate.includes(':')) {
      const leadTitle = normalizeBookText(candidate.split(':', 1)[0] ?? '');
      if (leadTitle !== normalizeBookText(requested)) return false;
    }
  }

  return true;
}

function coreWords(value: string): Set<string> {
  const core = value.split(/[:(]/, 1)[0] ?? value;
  return new Set(
    normalizeBookText(core)
      .split(' ')
      .filter((word) => word.length > 1 && !TITLE_STOP_WORDS.has(word)),
  );
}
