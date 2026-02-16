import type { Browser } from 'playwright';
import type { Posting } from '../monitor/types.js';
import { HttpClient } from '../utils/http.js';
import { dedupePostings, stablePostingId } from './common.js';
import { scrapeGenericDom } from './genericDom.js';

function withAdpIds(postings: Posting[]): Posting[] {
  return postings.map((posting) => {
    const id =
      posting.url.match(/[?&](?:jobId|jobID|reqId|requisitionId)=([A-Za-z0-9_-]+)/i)?.[1] ??
      posting.url.match(/\/job\/([A-Za-z0-9_-]+)/i)?.[1];

    return {
      ...posting,
      posting_id: stablePostingId(id, posting.url),
    };
  });
}

export async function scrapeAdp(
  jobsUrl: string,
  httpClient: HttpClient,
  browser?: Browser,
): Promise<Posting[]> {
  const postings = await scrapeGenericDom(jobsUrl, httpClient, browser);
  return dedupePostings(withAdpIds(postings));
}
