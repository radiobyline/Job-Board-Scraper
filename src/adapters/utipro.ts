import type { Browser } from 'playwright';
import type { Posting } from '../monitor/types.js';
import { HttpClient } from '../utils/http.js';
import { scrapeGenericDom } from './genericDom.js';
import { stablePostingId, dedupePostings } from './common.js';

function withUtiproIds(postings: Posting[]): Posting[] {
  return postings.map((posting) => {
    const id =
      posting.url.match(/[?&](?:jobid|requisition(?:id)?|id)=([A-Za-z0-9_-]+)/i)?.[1] ??
      posting.url.match(/\/jobdetails\/([A-Za-z0-9_-]+)/i)?.[1];
    return {
      ...posting,
      posting_id: stablePostingId(id, posting.url),
    };
  });
}

export async function scrapeUtipro(
  jobsUrl: string,
  httpClient: HttpClient,
  browser?: Browser,
): Promise<Posting[]> {
  const postings = await scrapeGenericDom(jobsUrl, httpClient, browser);
  return dedupePostings(withUtiproIds(postings));
}
