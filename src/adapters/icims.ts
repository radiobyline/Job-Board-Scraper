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

function extractIcimsId(url: string): string | undefined {
  return (
    url.match(/[?&]mode=job&iis=(\d+)/i)?.[1] ??
    url.match(/\/jobs\/(\d+)\/?/i)?.[1] ??
    url.match(/\/job\/([^/?#]+)/i)?.[1]
  );
}

export async function scrapeIcims(
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
    if (!/icims\.com/i.test(absolute) && !/\/jobs\/|\/job\/|career/i.test(absolute)) {
      return;
    }

    if (!title || title.length < 3) {
      return;
    }

    const rowText = normalizeWhitespace($(anchor).closest('li,tr,article,div').text());
    const postedDate = parseMaybeDate(rowText.match(/(posted|date):?\s*([A-Za-z0-9,\/ -]+)/i)?.[2]);
    const location = normalizeWhitespace(
      rowText.match(/(location|city|office):?\s*([A-Za-z0-9, .'-]{2,80})/i)?.[2] ?? '',
    );

    postings.push({
      posting_id: stablePostingId(extractIcimsId(absolute), absolute),
      title,
      url: absolute,
      location: location || undefined,
      posted_date: postedDate,
      snippet: rowText.slice(0, 500),
      attribution_text: `${title} ${rowText}`.trim(),
    });
  });

  return dedupePostings(postings);
}
