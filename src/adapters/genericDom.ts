import type { Browser } from 'playwright';
import type { Posting } from '../monitor/types.js';
import { HttpClient } from '../utils/http.js';
import {
  collectAnchorCandidates,
  dedupePostings,
  fetchHtmlWithBrowserFallback,
  stablePostingId,
} from './common.js';

const JOB_KEYWORD = /job|career|employ|opportunit|recruit|vacanc|position|posting|hiring|apply/i;

export async function scrapeGenericDom(
  jobsUrl: string,
  httpClient: HttpClient,
  browser?: Browser,
): Promise<Posting[]> {
  const loaded = await fetchHtmlWithBrowserFallback(jobsUrl, httpClient, browser);
  if (!loaded) {
    return [];
  }

  const candidates = collectAnchorCandidates(
    loaded.html,
    loaded.url,
    (text, href) => JOB_KEYWORD.test(text) || JOB_KEYWORD.test(href),
    300,
  );

  const postings: Posting[] = candidates.map((candidate) => ({
    posting_id: stablePostingId(undefined, candidate.url),
    title: candidate.title,
    url: candidate.url,
    snippet: candidate.snippet,
    attribution_text: `${candidate.title} ${candidate.snippet}`.trim(),
  }));

  return dedupePostings(postings);
}
