import * as cheerio from 'cheerio';
import { URL } from 'node:url';
import type { Browser } from 'playwright';
import type { JobsDiscoveryResult } from '../types.js';
import { HttpClient } from '../utils/http.js';
import { cleanUrl, sameHost, toAbsoluteUrl } from '../utils/url.js';
import { looksLikePdf, normalizeWhitespace } from '../utils/text.js';
import { isKnownAtsUrl } from './classify.js';

const COMMON_PATHS = [
  '/careers',
  '/career',
  '/jobs',
  '/job',
  '/employment',
  '/work-with-us',
  '/opportunities',
  '/about/careers',
  '/about/jobs',
  '/join-our-team',
  '/join-us',
  '/work-for-us',
  '/employment-opportunities',
  '/careers-and-employment',
  '/career-opportunities',
  '/jobs-opportunities',
  '/human-resources',
  '/hr',
  '/city-hall/careers',
  '/city-hall/jobs',
  '/our-city/careers',
  '/our-city/jobs',
  '/government/careers',
  '/government/jobs',
];

const CAREER_KEYWORDS = ['career', 'careers', 'jobs', 'employment', 'opportunities', 'apply'];

const LINK_KEYWORDS = [
  'careers',
  'jobs',
  'employment',
  'recruitment',
  'opportunities',
  'join our team',
  'work with us',
  'work for us',
  'vacancies',
  'position',
  'hiring',
  'job openings',
  'employment opportunities',
];

interface Candidate {
  url: string;
  score: number;
  via: JobsDiscoveryResult['discoveredVia'];
  isPdf: boolean;
}

interface DiscoverOptions {
  fast?: boolean;
  browser?: Browser;
}

function keywordCount(content: string): number {
  const lower = content.toLowerCase();
  let count = 0;
  for (const keyword of CAREER_KEYWORDS) {
    if (lower.includes(keyword)) {
      count += 1;
    }
  }
  return count;
}

function scoreLinkText(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const keyword of LINK_KEYWORDS) {
    if (lower.includes(keyword)) {
      score += keyword.split(' ').length;
    }
  }
  return score;
}

function pickHighest(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) {
    return null;
  }
  return [...candidates].sort((a, b) => b.score - a.score)[0];
}

async function pathProbe(
  homepageUrl: string,
  httpClient: HttpClient,
  paths: string[] = COMMON_PATHS,
  retries = 1,
  maxBytes = 750_000,
): Promise<Candidate | null> {
  let origin: string;
  try {
    origin = new URL(homepageUrl).origin;
  } catch {
    return null;
  }

  let pdfCandidate: Candidate | null = null;

  for (const path of paths) {
    const probeUrl = cleanUrl(`${origin}${path}`);
    const response = await httpClient.requestMaybe(probeUrl, { maxBytes, retries });
    if (!response) {
      continue;
    }

    const finalUrl = cleanUrl(response.url);

    if (isKnownAtsUrl(finalUrl)) {
      return {
        url: finalUrl,
        score: 100,
        via: 'path_guess',
        isPdf: false,
      };
    }

    const isPdf = looksLikePdf(finalUrl) || response.contentType.includes('pdf');
    if (isPdf && !pdfCandidate) {
      pdfCandidate = {
        url: finalUrl,
        score: 10,
        via: 'pdf',
        isPdf: true,
      };
      continue;
    }

    if (response.status === 200 && keywordCount(response.body) >= 2) {
      return {
        url: finalUrl,
        score: 80,
        via: 'path_guess',
        isPdf,
      };
    }
  }

  return pdfCandidate;
}

function likelyContextPage(text: string): boolean {
  const lower = text.toLowerCase();
  return /about|contact|government|city hall|town hall|administration|human resources|our city|township office/.test(
    lower,
  );
}

async function linkTextCrawl(
  homepageUrl: string,
  httpClient: HttpClient,
  includeLikelyPages = true,
  retries = 1,
  maxBytes = 1_500_000,
): Promise<Candidate | null> {
  const homepage = await httpClient.requestMaybe(homepageUrl, { maxBytes, retries });
  if (!homepage || homepage.status >= 400 || !homepage.body) {
    return null;
  }

  const pagesToFetch = [cleanUrl(homepage.url)];
  if (includeLikelyPages) {
    const $home = cheerio.load(homepage.body);
    const likelyPages: string[] = [];

    $home('a[href]').each((_, anchor) => {
      if (likelyPages.length >= 8) {
        return;
      }
      const text = normalizeWhitespace($home(anchor).text());
      if (!likelyContextPage(text)) {
        return;
      }

      const href = ($home(anchor).attr('href') ?? '').trim();
      if (!href) {
        return;
      }

      const absolute = cleanUrl(toAbsoluteUrl(href, homepage.url));
      if (!sameHost(absolute, homepage.url)) {
        return;
      }

      likelyPages.push(absolute);
    });

    const uniqueLikely = [...new Set(likelyPages)].slice(0, 2);
    pagesToFetch.push(...uniqueLikely);
  }

  const candidates: Candidate[] = [];

  for (const pageUrl of pagesToFetch) {
    const response = await httpClient.requestMaybe(pageUrl, { maxBytes, retries });
    if (!response || response.status >= 400) {
      continue;
    }

    const $ = cheerio.load(response.body);
    $('a[href]').each((_, anchor) => {
      const text = normalizeWhitespace($(anchor).text());
      const href = ($(anchor).attr('href') ?? '').trim();
      if (!href || !text) {
        return;
      }

      const score = scoreLinkText(text);
      if (score <= 0) {
        return;
      }

      const absolute = cleanUrl(toAbsoluteUrl(href, response.url));
      const atsBoost = isKnownAtsUrl(absolute) ? 40 : 0;
      const isPdf = looksLikePdf(absolute);

      candidates.push({
        url: absolute,
        score: score + atsBoost,
        via: isPdf ? 'pdf' : 'link_text',
        isPdf,
      });
    });
  }

  const best = pickHighest(candidates);
  return best;
}

async function browserLinkTextCrawl(homepageUrl: string, browser: Browser): Promise<Candidate | null> {
  const page = await browser.newPage();
  const requestUrls: string[] = [];
  page.on('request', (request) => {
    requestUrls.push(request.url());
  });

  const queue: string[] = [homepageUrl];
  const visited = new Set<string>();
  const candidates: Candidate[] = [];

  try {
    while (queue.length > 0 && visited.size < 3) {
      const targetUrl = queue.shift() ?? '';
      const cleanedTargetUrl = cleanUrl(targetUrl);
      if (!cleanedTargetUrl || visited.has(cleanedTargetUrl)) {
        continue;
      }

      visited.add(cleanedTargetUrl);
      await page.goto(cleanedTargetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try {
        await page.waitForLoadState('networkidle', { timeout: 4000 });
      } catch {
        // Some pages never become network idle; continue with current DOM.
      }

      const currentUrl = cleanUrl(page.url());
      const links = await page.$$eval('a[href]', (anchors) =>
        anchors.map((anchor) => ({
          text: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim(),
          href: anchor.getAttribute('href') ?? '',
        })),
      );

      for (const link of links) {
        const text = normalizeWhitespace(link.text);
        const href = link.href.trim();
        if (!href) {
          continue;
        }

        const absolute = cleanUrl(toAbsoluteUrl(href, currentUrl));
        if (!absolute) {
          continue;
        }

        const score = scoreLinkText(text);
        const pathLower = absolute.toLowerCase();
        const pathKeywordBoost = /career|job|employ|vacanc|recruit|opportunit|hiring/.test(pathLower)
          ? 2
          : 0;

        if (score + pathKeywordBoost > 0) {
          const atsBoost = isKnownAtsUrl(absolute) ? 40 : 0;
          const isPdf = looksLikePdf(absolute);
          candidates.push({
            url: absolute,
            score: score + pathKeywordBoost + atsBoost,
            via: isPdf ? 'pdf' : 'link_text',
            isPdf,
          });
        }

        if (
          queue.length < 2 &&
          sameHost(absolute, homepageUrl) &&
          likelyContextPage(text) &&
          !visited.has(absolute)
        ) {
          queue.push(absolute);
        }
      }
    }

    for (const requestUrl of requestUrls) {
      if (!isKnownAtsUrl(requestUrl)) {
        continue;
      }
      candidates.push({
        url: cleanUrl(requestUrl),
        score: 90,
        via: 'link_text',
        isPdf: false,
      });
    }
  } catch {
    // Fall back to non-browser methods.
  } finally {
    await page.close();
  }

  return pickHighest(candidates);
}

async function sitemapScan(homepageUrl: string, httpClient: HttpClient): Promise<Candidate | null> {
  let origin = '';
  try {
    origin = new URL(homepageUrl).origin;
  } catch {
    return null;
  }

  const sitemapUrl = `${origin}/sitemap.xml`;
  const response = await httpClient.requestMaybe(sitemapUrl, {
    maxBytes: 3_000_000,
    retries: 1,
    headers: {
      accept: 'application/xml,text/xml,text/plain,*/*',
    },
  });

  if (!response || response.status >= 400 || !response.body) {
    return null;
  }

  const urls = [...response.body.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((match) => cleanUrl(match[1]));
  const matched: Candidate[] = [];

  for (const url of urls) {
    const lower = url.toLowerCase();
    if (!/career|job|employ|opportunit|recruit/.test(lower)) {
      continue;
    }

    const isPdf = looksLikePdf(url);
    let score = 20;
    if (/career|jobs/.test(lower)) {
      score += 10;
    }
    if (isKnownAtsUrl(url)) {
      score += 30;
    }

    matched.push({
      url,
      score,
      via: isPdf ? 'pdf' : 'sitemap',
      isPdf,
    });
  }

  return pickHighest(matched);
}

export async function discoverJobsUrl(
  homepageUrl: string,
  httpClient: HttpClient,
  options: DiscoverOptions = {},
): Promise<JobsDiscoveryResult> {
  if (!homepageUrl) {
    return {
      jobsUrl: '',
      discoveredVia: 'manual',
      notes: 'Homepage missing; manual review required.',
    };
  }

  if (options.fast) {
    const fastLinkCandidate = await linkTextCrawl(homepageUrl, httpClient, false, 0, 700_000);
    if (fastLinkCandidate && !fastLinkCandidate.isPdf) {
      return {
        jobsUrl: fastLinkCandidate.url,
        discoveredVia: fastLinkCandidate.via,
      };
    }

    const fastPathCandidate = await pathProbe(
      homepageUrl,
      httpClient,
      ['/careers', '/jobs', '/employment'],
      0,
      400_000,
    );
    if (fastPathCandidate && !fastPathCandidate.isPdf) {
      return {
        jobsUrl: fastPathCandidate.url,
        discoveredVia: fastPathCandidate.via,
      };
    }

    const fastPdf = pickHighest([fastLinkCandidate, fastPathCandidate].filter((candidate): candidate is Candidate => Boolean(candidate?.isPdf)));
    if (fastPdf) {
      return {
        jobsUrl: fastPdf.url,
        discoveredVia: 'pdf',
        notes: 'PDF careers source detected.',
      };
    }

    return {
      jobsUrl: '',
      discoveredVia: 'manual',
      notes: 'No reliable jobs URL discovered automatically.',
    };
  }

  const pathCandidate = await pathProbe(homepageUrl, httpClient);
  if (pathCandidate && (!pathCandidate.isPdf || pathCandidate.via === 'path_guess')) {
    return {
      jobsUrl: pathCandidate.url,
      discoveredVia: pathCandidate.via,
    };
  }

  const linkCandidate = await linkTextCrawl(homepageUrl, httpClient);
  if (linkCandidate && !linkCandidate.isPdf) {
    return {
      jobsUrl: linkCandidate.url,
      discoveredVia: linkCandidate.via,
    };
  }

  const browserCandidate = options.browser
    ? await browserLinkTextCrawl(homepageUrl, options.browser)
    : null;
  if (browserCandidate && !browserCandidate.isPdf) {
    return {
      jobsUrl: browserCandidate.url,
      discoveredVia: browserCandidate.via,
    };
  }

  const sitemapCandidate = await sitemapScan(homepageUrl, httpClient);
  if (sitemapCandidate && !sitemapCandidate.isPdf) {
    return {
      jobsUrl: sitemapCandidate.url,
      discoveredVia: sitemapCandidate.via,
    };
  }

  const pdfCandidate = pickHighest(
    [pathCandidate, linkCandidate, browserCandidate, sitemapCandidate].filter(
      (candidate): candidate is Candidate => Boolean(candidate?.isPdf),
    ),
  );

  if (pdfCandidate) {
    return {
      jobsUrl: pdfCandidate.url,
      discoveredVia: 'pdf',
      notes: 'PDF careers source detected.',
    };
  }

  return {
    jobsUrl: '',
    discoveredVia: 'manual',
    notes: 'No reliable jobs URL discovered automatically.',
  };
}
