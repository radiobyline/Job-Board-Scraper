import * as cheerio from 'cheerio';
import type { Browser } from 'playwright';
import type { ClassificationResult } from '../types.js';
import { looksLikePdf } from '../utils/text.js';
import { HttpClient } from '../utils/http.js';

interface AtsPattern {
  test: (value: string) => boolean;
  jobsSourceType: ClassificationResult['jobsSourceType'];
  adapter: ClassificationResult['adapter'];
}

const ATS_PATTERNS: AtsPattern[] = [
  {
    test: (value) => /myworkdayjobs\.com|\/wday\/cxs\//i.test(value),
    jobsSourceType: 'ats_workday',
    adapter: 'workday',
  },
  {
    test: (value) => /taleo\.net|\/careersection\//i.test(value),
    jobsSourceType: 'ats_taleo',
    adapter: 'taleo',
  },
  {
    test: (value) => /icims\.com/i.test(value),
    jobsSourceType: 'ats_icims',
    adapter: 'icims',
  },
  {
    test: (value) => /governmentjobs\.com|neogov\.com/i.test(value),
    jobsSourceType: 'ats_neogov',
    adapter: 'neogov',
  },
  {
    test: (value) => /dayforcehcm\.com/i.test(value),
    jobsSourceType: 'ats_dayforce',
    adapter: 'dayforce',
  },
  {
    test: (value) => /bamboohr\.com\/jobs\//i.test(value),
    jobsSourceType: 'ats_bamboohr',
    adapter: 'bamboohr',
  },
  {
    test: (value) => /paycomonline\.net/i.test(value),
    jobsSourceType: 'ats_paycom',
    adapter: 'paycom',
  },
];

const CONTENT_MARKERS: Array<{ marker: RegExp; jobsSourceType: ClassificationResult['jobsSourceType']; adapter: ClassificationResult['adapter'] }> = [
  { marker: /workday/i, jobsSourceType: 'ats_workday', adapter: 'workday' },
  { marker: /icims/i, jobsSourceType: 'ats_icims', adapter: 'icims' },
  { marker: /taleo/i, jobsSourceType: 'ats_taleo', adapter: 'taleo' },
  { marker: /neogov|governmentjobs/i, jobsSourceType: 'ats_neogov', adapter: 'neogov' },
  { marker: /dayforce/i, jobsSourceType: 'ats_dayforce', adapter: 'dayforce' },
  { marker: /bamboohr/i, jobsSourceType: 'ats_bamboohr', adapter: 'bamboohr' },
  { marker: /paycom/i, jobsSourceType: 'ats_paycom', adapter: 'paycom' },
];

function classifyFromString(value: string): ClassificationResult | null {
  for (const pattern of ATS_PATTERNS) {
    if (pattern.test(value)) {
      return {
        jobsSourceType: pattern.jobsSourceType,
        adapter: pattern.adapter,
        confidence: 1,
      };
    }
  }
  return null;
}

function classifyFromContentMarkers(value: string): ClassificationResult | null {
  for (const marker of CONTENT_MARKERS) {
    if (marker.marker.test(value)) {
      return {
        jobsSourceType: marker.jobsSourceType,
        adapter: marker.adapter,
        confidence: 1,
      };
    }
  }
  return null;
}

function looksLikeHtmlList(html: string): boolean {
  const $ = cheerio.load(html);
  const links = $('a[href]');
  if (links.length === 0) {
    return false;
  }

  let relevantLinks = 0;
  links.each((_, anchor) => {
    const text = $(anchor).text().trim().toLowerCase();
    const href = ($(anchor).attr('href') ?? '').toLowerCase();
    if (
      /job|career|position|apply|opportunit|posting|vacanc|requisition/.test(text) ||
      /job|career|posting|apply|requisition/.test(href)
    ) {
      relevantLinks += 1;
    }
  });

  const pageText = $('body').text().toLowerCase();
  const keywordHits = ['job', 'career', 'position', 'vacancy', 'posting', 'apply', 'requisition'].filter(
    (keyword) => pageText.includes(keyword),
  ).length;
  const postingMarkers = (pageText.match(/\b(closing date|apply now|job posting|vacancy|position title)\b/g) ?? []).length;

  return relevantLinks >= 3 || (relevantLinks >= 2 && keywordHits >= 3) || postingMarkers >= 3;
}

function looksGenericCareersPage(html: string): boolean {
  const lower = html.toLowerCase();
  let keywordCount = 0;
  for (const keyword of ['career', 'careers', 'jobs', 'employment', 'opportunities', 'apply']) {
    if (lower.includes(keyword)) {
      keywordCount += 1;
    }
  }
  return keywordCount >= 2;
}

export async function classifyJobsSource(
  jobsUrl: string,
  httpClient: HttpClient,
  browser?: Browser,
): Promise<ClassificationResult> {
  const direct = classifyFromString(jobsUrl);
  if (direct) {
    return direct;
  }

  const response = await httpClient.requestMaybe(jobsUrl, { maxBytes: 1_000_000, retries: 2 });
  if (response) {
    const byFinalUrl = classifyFromString(response.url);
    if (byFinalUrl) {
      return byFinalUrl;
    }

    const markerCandidate = classifyFromContentMarkers(`${response.url}\n${response.body}`);
    if (markerCandidate) {
      return markerCandidate;
    }

    if (looksLikePdf(response.url) || response.contentType.includes('pdf')) {
      return {
        jobsSourceType: 'pdf',
        adapter: 'pdf',
        confidence: 0.5,
      };
    }

    if (looksLikeHtmlList(response.body)) {
      return {
        jobsSourceType: 'html_list',
        adapter: 'html_list',
        confidence: 0.8,
      };
    }

    if (looksGenericCareersPage(response.body)) {
      return {
        jobsSourceType: 'unknown',
        adapter: 'generic_dom',
        confidence: 0.5,
      };
    }
  }

  if (browser) {
    const page = await browser.newPage();
    const requestUrls: string[] = [];
    page.on('request', (request) => {
      requestUrls.push(request.url());
    });

    try {
      await page.goto(jobsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try {
        await page.waitForLoadState('networkidle', { timeout: 5000 });
      } catch {
        // Some pages never settle; ignore.
      }

      const finalUrl = page.url();
      const byFinal = classifyFromString(finalUrl);
      if (byFinal) {
        return byFinal;
      }

      const html = await page.content();
      const byContent = classifyFromContentMarkers(`${finalUrl}\n${html}\n${requestUrls.join('\n')}`);
      if (byContent) {
        return byContent;
      }

      const networkHints = requestUrls.filter((requestUrl) =>
        /jobs|posting|requisition|career|employment/i.test(requestUrl),
      );
      if (networkHints.length >= 3 || looksLikeHtmlList(html)) {
        return {
          jobsSourceType: 'html_list',
          adapter: 'html_list',
          confidence: 0.8,
        };
      }

      if (looksGenericCareersPage(html)) {
        return {
          jobsSourceType: 'unknown',
          adapter: 'generic_dom',
          confidence: 0.5,
        };
      }
    } catch {
      // Fall through to unknown.
    } finally {
      await page.close();
    }
  }

  return {
    jobsSourceType: 'unknown',
    adapter: 'generic_dom',
    confidence: 0.5,
  };
}

export function isKnownAtsUrl(url: string): boolean {
  return ATS_PATTERNS.some((pattern) => pattern.test(url));
}
