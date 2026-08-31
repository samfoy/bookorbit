import { BadGatewayException } from '@nestjs/common';

import { ensureSafeUrl } from '../../common/utils/ssrf.utils';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function fetchWithSafeRedirects(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  let current = await ensureSafeUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new BadGatewayException('Remote download redirect is missing a location');
    if (redirectCount === MAX_REDIRECTS) throw new BadGatewayException('Remote download exceeded the redirect limit');

    current = await ensureSafeUrl(new URL(location, current).toString());
  }

  throw new BadGatewayException('Remote download exceeded the redirect limit');
}
