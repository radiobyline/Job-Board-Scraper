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

function extractNeogovId(url: string): string | undefined {
  const match = url.match(/\/jobs\/(\d+)\/?/i);
  return match?.[1];
}

export async function scrapeNeogov(
  jobsUrl: string,
  httpClient: HttpClient,
  browser?: Browser,
): Promise<Posting[]> {
  const loaded = await fetchHtmlWithBrowserFallback(jobsUrl, httpClient, browser);
  if (!loaded) {
    return [];
  }

  const $ = cheerio.load(loaded.html);
  const postings: Posting[] = [];

  $('a[href]').each((_, anchor) => {
    const href = normalizeWhitespace($(anchor).attr('href') ?? '');
    const title = normalizeWhitespace($(anchor).text());
    if (!href) {
      return;
    }

    const absolute = cleanUrl(toAbsoluteUrl(href, loaded.url));
    if (!/\/jobs\/\d+/i.test(absolute)) {
      return;
    }
    if (!title || title.length < 3) {
      return;
    }

    const rowText = normalizeWhitespace($(anchor).closest('tr,li,article,div').text());
    const postedDate = parseMaybeDate(rowText.match(/(posted|publish(?:ed)?):?\s*([A-Za-z0-9,\/ -]+)/i)?.[2]);
    const closingDate = parseMaybeDate(rowText.match(/(close|closing):?\s*([A-Za-z0-9,\/ -]+)/i)?.[2]);

    postings.push({
      posting_id: stablePostingId(extractNeogovId(absolute), absolute),
      title,
      url: absolute,
      posted_date: postedDate,
      closing_date: closingDate,
      snippet: rowText.slice(0, 500),
      attribution_text: `${title} ${rowText}`.trim(),
    });
  });

  return dedupePostings(postings);
}
