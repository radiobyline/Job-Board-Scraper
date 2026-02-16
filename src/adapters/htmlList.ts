import type { Browser } from 'playwright';
import type { Posting } from '../monitor/types.js';
import { HttpClient } from '../utils/http.js';
import { scrapeGenericDom } from './genericDom.js';

export async function scrapeHtmlList(
  jobsUrl: string,
  httpClient: HttpClient,
  browser?: Browser,
): Promise<Posting[]> {
  return scrapeGenericDom(jobsUrl, httpClient, browser);
}
