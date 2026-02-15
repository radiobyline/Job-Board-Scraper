import * as cheerio from 'cheerio';
import { HttpClient } from '../utils/http.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { cleanUrl, toAbsoluteUrl } from '../utils/url.js';
import { normalizeWhitespace, stripStatusSuffix } from '../utils/text.js';
import type { MunicipalitySeed } from '../types.js';
import { RunLogger } from '../utils/logger.js';

const AMO_MUNICIPALITIES_URL = 'https://www.amo.on.ca/about-us/municipal-101/ontario-municipalities';

const EXCLUDED_HOSTS = new Set([
  'www.amo.on.ca',
  'amo.on.ca',
  'www.roma.on.ca',
  'roma.on.ca',
  'data.ontario.ca',
]);

function looksGenericText(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.length < 3 ||
    normalized === 'click here' ||
    normalized === 'external list of alphabetical list of municipalities' ||
    normalized.includes('municipal 101') ||
    normalized.includes('interactive map')
  );
}

function looksMunicipalityName(text: string): boolean {
  const normalized = text.toLowerCase();
  if (
    /\b(city|town|township|village|municipality|county|region|district|regional|united counties|county of|district of)\b/.test(
      normalized,
    )
  ) {
    return true;
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  return tokens.length >= 1 && tokens.length <= 7;
}

function uniqueByNameAndUrl(items: MunicipalitySeed[]): MunicipalitySeed[] {
  const seen = new Set<string>();
  const out: MunicipalitySeed[] = [];

  for (const item of items) {
    const key = `${item.orgName.toLowerCase()}|${item.homepageUrl.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }

  return out;
}

export async function buildMunicipalitySeed(
  httpClient: HttpClient,
  logger: RunLogger,
): Promise<MunicipalitySeed[]> {
  await logger.info(`Fetching municipalities seed page: ${AMO_MUNICIPALITIES_URL}`);
  const response = await httpClient.request(AMO_MUNICIPALITIES_URL, { retries: 2, maxBytes: 4_000_000 });
  const $ = cheerio.load(response.body);

  const article = $('article').first();
  const root = article.length > 0 ? article : $('main');

  const candidates: MunicipalitySeed[] = [];

  root.find('a[href]').each((_, anchor) => {
    const href = ($(anchor).attr('href') ?? '').trim();
    const text = normalizeWhitespace($(anchor).text());

    if (!href || !text || looksGenericText(text)) {
      return;
    }

    const absolute = cleanUrl(toAbsoluteUrl(href, AMO_MUNICIPALITIES_URL));
    if (!absolute.startsWith('http://') && !absolute.startsWith('https://')) {
      return;
    }

    let host = '';
    try {
      host = new URL(absolute).hostname.toLowerCase();
    } catch {
      return;
    }

    if (EXCLUDED_HOSTS.has(host)) {
      return;
    }

    if (!looksMunicipalityName(text)) {
      return;
    }

    const name = stripStatusSuffix(text);
    if (!name) {
      return;
    }

    candidates.push({
      orgName: name,
      orgType: 'municipality',
      homepageUrl: absolute,
      sourcePage: AMO_MUNICIPALITIES_URL,
    });
  });

  const unique = uniqueByNameAndUrl(candidates);
  await logger.info(`Municipality candidates extracted: ${unique.length}`);

  const normalized = await mapWithConcurrency(unique, 10, async (item) => {
    const canonical = await httpClient.resolveCanonicalUrl(item.homepageUrl);
    return {
      ...item,
      homepageUrl: canonical || item.homepageUrl,
    };
  });

  const final = uniqueByNameAndUrl(normalized).sort((a, b) => a.orgName.localeCompare(b.orgName));
  await logger.info(`Municipality seed finalized: ${final.length}`);

  return final;
}
