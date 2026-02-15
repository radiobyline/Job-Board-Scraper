import { URL } from 'node:url';

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
]);

export function toAbsoluteUrl(value: string, base: string): string {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

export function cleanUrl(rawUrl: string): string {
  if (!rawUrl) {
    return '';
  }

  let candidate = rawUrl.trim();
  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`;
  }
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  try {
    const url = new URL(candidate);
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();

    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}

export function sameHost(urlA: string, urlB: string): boolean {
  try {
    return new URL(urlA).hostname === new URL(urlB).hostname;
  } catch {
    return false;
  }
}
