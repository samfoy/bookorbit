import { BadGatewayException, BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { fetchWithSafeRedirects } from './safe-remote-fetch.util';

const ANNAS_ARCHIVE_MIRRORS = ['https://annas-archive.gl', 'https://annas-archive.pk', 'https://annas-archive.gd'] as const;
const USER_AGENT = 'BookOrbit Book Discovery (https://bookorbit.app)';

interface FastDownloadResponse {
  download_url?: string | null;
  error?: string | null;
}

@Injectable()
export class AnnasArchiveService {
  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.secretKey());
  }

  async download(md5: string, signal?: AbortSignal): Promise<Response> {
    if (!/^[a-f0-9]{32}$/i.test(md5)) throw new BadRequestException('Invalid acquisition identifier');
    const key = this.secretKey();
    if (!key) throw new ServiceUnavailableException("Anna's Archive member key is not configured");

    for (const mirror of ANNAS_ARCHIVE_MIRRORS) {
      const apiUrl = `${mirror}/dyn/api/fast_download.json?${new URLSearchParams({ md5: md5.toLowerCase(), key }).toString()}`;
      let response: Response;
      try {
        response = await fetchWithSafeRedirects(apiUrl, {
          headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
          signal,
        });
      } catch {
        continue;
      }
      if (!response.ok) continue;

      const payload = (await response.json().catch(() => null)) as FastDownloadResponse | null;
      if (!payload?.download_url) continue;
      const download = await fetchWithSafeRedirects(payload.download_url, {
        headers: { 'User-Agent': USER_AGENT },
        signal,
      });
      if (!download.ok) throw new BadGatewayException("Anna's Archive download failed");
      return download;
    }

    throw new BadGatewayException("Anna's Archive could not resolve this file");
  }

  private secretKey(): string | null {
    return this.config.get<string>('bookAcquisition.annasArchiveSecretKey')?.trim() || null;
  }
}
