import * as cheerio from 'cheerio';
import type { Browser } from 'playwright';
import type { Posting } from '../monitor/types.js';
import { HttpClient } from '../utils/http.js';
import { cleanUrl, toAbsoluteUrl } from '../utils/url.js';
import { normalizeWhitespace } from '../utils/text.js';
import {
  dedupePostings,
  fetchHtmlWithBrowserFallback,
  parseMaybeDate,
  stablePostingId,
} from './common.js';

interface WorkdayPostingPayload {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
  jobReqId?: string;
}

interface WorkdayResponsePayload {
  total?: number;
  jobPostings?: WorkdayPostingPayload[];
}

function extractWorkdayApiEndpoint(html: string, baseUrl: string): string | null {
  const absoluteMatch = html.match(/https?:\/\/[^"']+\/wday\/cxs\/[^"']+\/jobs/gi)?.[0];
  if (absoluteMatch) {
    return cleanUrl(absoluteMatch);
  }

  const relativeMatch = html.match(/\/wday\/cxs\/[^"']+\/jobs/gi)?.[0];
  if (!relativeMatch) {
    return null;
  }
  return cleanUrl(toAbsoluteUrl(relativeMatch, baseUrl));
}

async function fetchWorkdayApiPage(
  endpoint: string,
  offset: number,
  httpClient: HttpClient,
): Promise<WorkdayResponsePayload | null> {
  const payload = JSON.stringify({
    appliedFacets: {},
    limit: 20,
    offset,
    searchText: '',
  });

  const response = await httpClient.requestMaybe(endpoint, {
    method: 'POST',
    body: payload,
    timeoutMs: 20000,
    retries: 2,
    maxBytes: 2_000_000,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json,text/plain,*/*',
    },
  });
  if (!response || response.status >= 400 || !response.body) {
    return null;
  }

  try {
    return JSON.parse(response.body) as WorkdayResponsePayload;
  } catch {
    return null;
  }
}

async function scrapeWorkdayApi(endpoint: string, homepageUrl: string, httpClient: HttpClient): Promise<Posting[]> {
  const postings: Posting[] = [];
  let offset = 0;
  let pageCount = 0;
  let total = Number.MAX_SAFE_INTEGER;

  while (offset < total && pageCount < 8) {
    const payload = await fetchWorkdayApiPage(endpoint, offset, httpClient);
    if (!payload || !Array.isArray(payload.jobPostings)) {
      break;
    }

    total = typeof payload.total === 'number' ? payload.total : payload.jobPostings.length;
    for (const item of payload.jobPostings) {
      const title = normalizeWhitespace(item.title ?? '');
      if (!title) {
        continue;
      }

      const postingUrl = cleanUrl(toAbsoluteUrl(item.externalPath ?? '', homepageUrl));
      const rowSnippet = normalizeWhitespace((item.bulletFields ?? []).join(' '));

      postings.push({
        posting_id: stablePostingId(item.jobReqId, postingUrl),
        title,
        url: postingUrl,
        location: normalizeWhitespace(item.locationsText ?? '') || undefined,
        posted_date: parseMaybeDate(item.postedOn),
        snippet: rowSnippet || undefined,
        attribution_text: `${title} ${rowSnippet}`.trim(),
      });
    }

    offset += payload.jobPostings.length;
    pageCount += 1;
    if (payload.jobPostings.length === 0) {
      break;
    }
  }

  return dedupePostings(postings);
}

function scrapeWorkdayDom(html: string, baseUrl: string): Posting[] {
  const $ = cheerio.load(html);
  const postings: Posting[] = [];

  $('a[href]').each((_, anchor) => {
    const href = normalizeWhitespace($(anchor).attr('href') ?? '');
    const title = normalizeWhitespace($(anchor).text());
    if (!href || !title || title.length < 3) {
      return;
    }

    const absolute = cleanUrl(toAbsoluteUrl(href, baseUrl));
    if (!/job|requisition|career|workday/i.test(absolute)) {
      return;
    }

    const rowText = normalizeWhitespace($(anchor).closest('li,article,div,tr').text());
    postings.push({
      posting_id: stablePostingId(absolute.match(/\/([0-9a-f]{8,}|JR-\d+)/i)?.[1], absolute),
      title,
      url: absolute,
      snippet: rowText.slice(0, 500),
      attribution_text: `${title} ${rowText}`.trim(),
    });
  });

  return dedupePostings(postings);
}

export async function scrapeWorkday(
  jobsUrl: string,
  httpClient: HttpClient,
  browser?: Browser,
): Promise<Posting[]> {
  const loaded = await fetchHtmlWithBrowserFallback(jobsUrl, httpClient, browser);
  if (!loaded) {
    return [];
  }

  const endpoint = extractWorkdayApiEndpoint(loaded.html, loaded.url);
  if (endpoint) {
    const apiPostings = await scrapeWorkdayApi(endpoint, loaded.url, httpClient);
    if (apiPostings.length > 0) {
      return apiPostings;
    }
  }

  return scrapeWorkdayDom(loaded.html, loaded.url);
}
