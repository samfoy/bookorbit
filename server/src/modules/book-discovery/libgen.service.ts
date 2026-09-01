import { BadGatewayException, Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';

import { isBundleTitle, normalizeBookText, titleMatchesRequestedBook } from './book-match.util';
import { fetchWithSafeRedirects } from './safe-remote-fetch.util';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const LIBGEN_MIRRORS = ['https://libgen.li', 'https://libgen.vg'] as const;
const LIBGEN_CDNS = ['https://cdn4.booksdl.lc', 'https://cdn3.booksdl.lc', 'https://cdn2.booksdl.lc'] as const;
const MAX_CANDIDATES = 12;

export interface LibgenSearchRequest {
  title: string;
  authors: string[];
  isbn10?: string | null;
  isbn13?: string | null;
}

export interface LibgenCandidate {
  md5: string;
  format: 'epub';
  mirror: string;
  description: string;
}

interface ScoredCandidate extends LibgenCandidate {
  score: number;
}

@Injectable()
export class LibgenService {
  async findCandidates(request: LibgenSearchRequest, signal?: AbortSignal): Promise<LibgenCandidate[]> {
    const isbn = this.normalizeIsbn(request.isbn13) ?? this.normalizeIsbn(request.isbn10);

    for (const mirror of LIBGEN_MIRRORS) {
      if (isbn) {
        const isbnCandidates = await this.searchMirror(mirror, isbn, request, signal);
        if (isbnCandidates.length > 0) return isbnCandidates;
      }

      const titleQuery = [request.title, request.authors[0]].filter(Boolean).join(' ');
      const titleCandidates = await this.searchMirror(mirror, titleQuery, request, signal);
      if (titleCandidates.length > 0) return titleCandidates;
    }

    return [];
  }

  get downloadAttemptCount(): number {
    return LIBGEN_CDNS.length;
  }

  async downloadAttempt(candidate: LibgenCandidate, attempt: number, signal?: AbortSignal): Promise<Response> {
    const cdn = LIBGEN_CDNS[attempt];
    if (!cdn) throw new BadGatewayException('No LibGen download mirror is available for this attempt');

    const referer = `${candidate.mirror}/ads.php?md5=${candidate.md5}`;
    const keyPage = await fetchWithSafeRedirects(referer, {
      headers: { 'User-Agent': USER_AGENT },
      signal,
    });
    if (!keyPage.ok) throw new BadGatewayException('LibGen did not provide a download key');

    const key = new RegExp(`get\\.php\\?md5=${candidate.md5}&key=([A-Z0-9]+)`, 'i').exec(await keyPage.text())?.[1];
    if (!key) throw new BadGatewayException('LibGen did not provide a download key');

    return fetchWithSafeRedirects(`${cdn}/get.php?md5=${candidate.md5}&key=${encodeURIComponent(key)}`, {
      headers: { 'User-Agent': USER_AGENT, Referer: referer },
      signal,
    });
  }

  private async searchMirror(mirror: string, query: string, request: LibgenSearchRequest, signal?: AbortSignal): Promise<LibgenCandidate[]> {
    const url = `${mirror}/index.php?${new URLSearchParams({ req: query }).toString()}`;
    const response = await fetchWithSafeRedirects(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal,
    });
    if (!response.ok) return [];

    const $ = cheerio.load(await response.text());
    const candidates: ScoredCandidate[] = [];
    $('tr').each((_, row) => {
      const element = $(row);
      const description = element.text().replace(/\s+/g, ' ').trim();
      const href = element.find("a[href*='md5=']").first().attr('href') ?? '';
      const md5 = /[?&]md5=([a-f0-9]{32})/i.exec(href)?.[1]?.toLowerCase();
      const candidateTitle = element.find("a[href*='edition.php?id=']").first().text().trim();
      if (
        !md5 ||
        !/\bepub\b/i.test(description) ||
        isBundleTitle(description) ||
        (candidateTitle.length > 0 && !titleMatchesRequestedBook(request.title, candidateTitle))
      ) {
        return;
      }

      candidates.push({
        md5,
        format: 'epub',
        mirror,
        description,
        score: this.score(description, request),
      });
    });

    return candidates
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_CANDIDATES)
      .map(({ md5, format, mirror, description }) => ({ md5, format, mirror, description }));
  }

  private score(description: string, request: LibgenSearchRequest): number {
    const normalized = normalizeBookText(description);
    const titleWords = normalizeBookText(request.title)
      .split(' ')
      .filter((word) => word.length > 1);
    let score = 100 + titleWords.filter((word) => normalized.includes(word)).length * 3;
    const author = normalizeBookText(request.authors[0] ?? '');
    if (author && normalized.includes(author)) score += 10;
    if (/\benglish\b/i.test(description)) score += 5;
    return score;
  }

  private normalizeIsbn(value: string | null | undefined): string | null {
    const normalized = value?.replace(/[^0-9X]/gi, '') ?? '';
    return normalized.length === 10 || normalized.length === 13 ? normalized : null;
  }
}
