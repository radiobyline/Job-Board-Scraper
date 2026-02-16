import type { Browser } from 'playwright';
import type { Posting } from '../monitor/types.js';
import type { Adapter, JobsSourceType, OrgRecord } from '../types.js';
import { HttpClient } from '../utils/http.js';
import { scrapeAdp } from './adp.js';
import { scrapeGenericDom } from './genericDom.js';
import { scrapeHtmlList } from './htmlList.js';
import { scrapeIcims } from './icims.js';
import { scrapeNeogov } from './neogov.js';
import { scrapePdf } from './pdf.js';
import { scrapeUtipro } from './utipro.js';
import { scrapeWorkday } from './workday.js';

type ScraperFn = (jobsUrl: string, httpClient: HttpClient, browser?: Browser) => Promise<Posting[]>;

const SCRAPER_BY_ADAPTER: Record<string, ScraperFn> = {
  workday: scrapeWorkday,
  neogov: scrapeNeogov,
  icims: scrapeIcims,
  utipro: scrapeUtipro,
  adp: scrapeAdp,
  html_list: scrapeHtmlList,
  generic_dom: scrapeGenericDom,
  bamboohr: scrapeGenericDom,
  taleo: scrapeGenericDom,
  dayforce: scrapeGenericDom,
  paycom: scrapeGenericDom,
  manual: async () => [],
  pdf: async (jobsUrl) => scrapePdf(jobsUrl),
};

function inferAdapterFromUrl(jobsUrl: string): Adapter | null {
  const value = jobsUrl.toLowerCase();
  if (/ultipro|ukg/i.test(value)) {
    return 'utipro';
  }
  if (/adp\.com|workforcenow\.adp\.com|recruiting(?:2)?\.adp\.com/i.test(value)) {
    return 'adp';
  }
  return null;
}

function adapterFromJobsSourceType(jobsSourceType: JobsSourceType): Adapter {
  switch (jobsSourceType) {
    case 'ats_workday':
      return 'workday';
    case 'ats_taleo':
      return 'taleo';
    case 'ats_icims':
      return 'icims';
    case 'ats_neogov':
      return 'neogov';
    case 'ats_dayforce':
      return 'dayforce';
    case 'ats_bamboohr':
      return 'bamboohr';
    case 'ats_paycom':
      return 'paycom';
    case 'html_list':
      return 'html_list';
    case 'pdf':
      return 'pdf';
    case 'unknown':
      return 'generic_dom';
    case 'manual_review':
      return 'manual';
    default:
      return 'generic_dom';
  }
}

function sourceTypeFromAdapter(adapter: Adapter, fallback: JobsSourceType): JobsSourceType {
  switch (adapter) {
    case 'workday':
      return 'ats_workday';
    case 'taleo':
      return 'ats_taleo';
    case 'icims':
      return 'ats_icims';
    case 'neogov':
      return 'ats_neogov';
    case 'dayforce':
      return 'ats_dayforce';
    case 'bamboohr':
      return 'ats_bamboohr';
    case 'paycom':
      return 'ats_paycom';
    case 'utipro':
    case 'adp':
      return fallback === 'manual_review' ? 'unknown' : fallback;
    case 'html_list':
      return 'html_list';
    case 'pdf':
      return 'pdf';
    case 'manual':
      return 'manual_review';
    case 'generic_dom':
      return fallback === 'manual_review' ? 'unknown' : fallback;
    default:
      return fallback;
  }
}

export function chooseGroupAdapter(orgs: OrgRecord[]): { adapter: Adapter; jobsSourceType: JobsSourceType } {
  const ranked = [...orgs].sort((a, b) => b.confidence - a.confidence);
  const preferred = ranked.find((org) => org.adapter !== 'manual') ?? ranked[0];
  const adapter = preferred?.adapter ?? 'generic_dom';
  const finalAdapter = adapter === 'manual' ? adapterFromJobsSourceType(preferred.jobs_source_type) : adapter;
  const inferredAdapter = inferAdapterFromUrl(preferred.jobs_url);
  const selectedAdapter = finalAdapter === 'generic_dom' && inferredAdapter ? inferredAdapter : finalAdapter;
  return {
    adapter: selectedAdapter,
    jobsSourceType: sourceTypeFromAdapter(selectedAdapter, preferred.jobs_source_type),
  };
}

export async function runAdapter(
  adapter: Adapter,
  jobsUrl: string,
  httpClient: HttpClient,
  browser?: Browser,
): Promise<Posting[]> {
  if (adapter === 'manual') {
    return [];
  }

  const scraper = SCRAPER_BY_ADAPTER[adapter] ?? SCRAPER_BY_ADAPTER.generic_dom;
  return scraper(jobsUrl, httpClient, browser);
}
