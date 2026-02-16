import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import type { Browser } from 'playwright';
import type { Posting } from '../monitor/types.js';
import { HttpClient } from '../utils/http.js';
import { cleanUrl, toAbsoluteUrl } from '../utils/url.js';
import { normalizeWhitespace } from '../utils/text.js';

const TRACKING_PARAMS = [/^utm_/i, /^fbclid$/i, /^gclid$/i];

function sanitizeUrl(url: string): string {
  const cleaned = cleanUrl(url);
  try {
    const parsed = new URL(cleaned);
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.some((pattern) => pattern.test(key))) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = '';
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return cleaned;
  }
}

export function stablePostingId(explicitId: string | undefined, postingUrl: string): string {
  if (explicitId && explicitId.trim().length > 0) {
    return explicitId.trim().toLowerCase();
  }
  const normalizedUrl = sanitizeUrl(postingUrl);
  const digest = createHash('sha256').update(normalizedUrl).digest('hex');
  return `url-${digest}`;
}

export function parseMaybeDate(rawValue: string | undefined): string | undefined {
  if (!rawValue) {
    return undefined;
  }
  const normalized = normalizeWhitespace(rawValue);
  if (!normalized) {
    return undefined;
  }

  const parsed = Date.parse(normalized);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }

  const mdY = normalized.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (mdY) {
    const [_, month, day, year] = mdY;
    const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    if (!Number.isNaN(Date.parse(iso))) {
      return iso;
    }
  }

  return undefined;
}

export function dedupePostings(postings: Posting[]): Posting[] {
  const seen = new Set<string>();
  const out: Posting[] = [];
  for (const posting of postings) {
    const key = `${posting.posting_id}::${sanitizeUrl(posting.url)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(posting);
  }
  return out;
}

export async function fetchHtmlWithBrowserFallback(
  url: string,
  httpClient: HttpClient,
  browser?: Browser,
): Promise<{ url: string; html: string } | null> {
  const response = await httpClient.requestMaybe(url, {
    maxBytes: 2_000_000,
    retries: 2,
    timeoutMs: 20000,
  });
  if (response && response.status < 400 && response.body) {
    return {
      url: cleanUrl(response.url),
      html: response.body,
    };
  }

  if (!browser) {
    return null;
  }

  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 });
    } catch {
      // Continue with the available DOM.
    }
    return {
      url: cleanUrl(page.url()),
      html: await page.content(),
    };
  } finally {
    await page.close();
  }
}

export function collectAnchorCandidates(
  html: string,
  baseUrl: string,
  predicate: (text: string, href: string) => boolean,
  maxCount = 250,
): Array<{ title: string; url: string; snippet: string }> {
  const $ = cheerio.load(html);
  const out: Array<{ title: string; url: string; snippet: string }> = [];

  $('a[href]').each((_, anchor) => {
    if (out.length >= maxCount) {
      return;
    }

    const text = normalizeWhitespace($(anchor).text());
    const href = normalizeWhitespace($(anchor).attr('href') ?? '');
    if (!href) {
      return;
    }

    const absolute = sanitizeUrl(toAbsoluteUrl(href, baseUrl));
    if (!absolute.startsWith('http')) {
      return;
    }

    if (!predicate(text, absolute)) {
      return;
    }

    const title = text || absolute;
    const parentText = normalizeWhitespace($(anchor).closest('li,article,tr,div').text());
    out.push({
      title: title.slice(0, 240),
      url: absolute,
      snippet: parentText.slice(0, 500),
    });
  });

  return out;
}
