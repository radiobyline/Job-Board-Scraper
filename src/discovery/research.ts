import { URL } from 'node:url';
import type { DiscoveredVia, OrgType } from '../types.js';
import { HttpClient } from '../utils/http.js';
import { cleanUrl, sameHost } from '../utils/url.js';
import { diceSimilarity, looksLikePdf, normalizeForMatch, normalizeWhitespace } from '../utils/text.js';
import { isKnownAtsUrl } from './classify.js';
import type { RunLogger } from '../utils/logger.js';

interface UrlResolutionResult {
  url: string;
  notes: string;
  discoveredVia: DiscoveredVia;
}

interface CandidateScore {
  url: string;
  score: number;
  discoveredVia: DiscoveredVia;
}

interface WikidataSearchItem {
  id?: string;
  label?: string;
  description?: string;
}

interface WikidataClaim {
  rank?: string;
  mainsnak?: {
    datavalue?: {
      value?: unknown;
    };
  };
}

const SEARCH_CACHE = new Map<string, string[]>();
let braveSearchUnavailable = false;

const NAME_STOP_WORDS = new Set([
  'and',
  'band',
  'city',
  'county',
  'de',
  'first',
  'for',
  'from',
  'indian',
  'la',
  'lake',
  'les',
  'nation',
  'nations',
  'of',
  'on',
  'ontario',
  'reserve',
  'the',
  'to',
  'town',
  'township',
  'village',
]);

const BLOCKED_HOST_PATTERNS = [
  /(^|\.)aadnc-aandc\.gc\.ca$/i,
  /(^|\.)rcaanc-cirnac\.gc\.ca$/i,
  /(^|\.)canada\.ca$/i,
  /(^|\.)wikipedia\.org$/i,
  /(^|\.)wikidata\.org$/i,
  /(^|\.)youtube\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)reddit\.com$/i,
  /(^|\.)msn\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)search\.brave\.com$/i,
  /(^|\.)bing\.com$/i,
  /(^|\.)duckduckgo\.com$/i,
];

const CAREER_TERMS = [
  'career',
  'careers',
  'jobs',
  'employment',
  'opportunities',
  'opportunity',
  'recruitment',
  'apply',
];

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return normalizeWhitespace(match?.[1] ?? '');
}

function decodeEscapedValue(value: string): string {
  return value
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .trim();
}

function getNameTokens(name: string): string[] {
  const normalized = normalizeForMatch(name);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part.length >= 3 && !NAME_STOP_WORDS.has(part));
}

function countTokenHits(text: string, tokens: string[]): number {
  let hits = 0;
  for (const token of tokens) {
    if (text.includes(token)) {
      hits += 1;
    }
  }
  return hits;
}

function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

function parseHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function hostPathValue(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.toLowerCase()}`;
  } catch {
    return rawUrl.toLowerCase();
  }
}

function keywordHitsInValue(value: string, keywords: string[]): number {
  let hits = 0;
  const lower = value.toLowerCase();
  for (const keyword of keywords) {
    if (lower.includes(keyword)) {
      hits += 1;
    }
  }
  return hits;
}

function normalizeHomeCandidate(rawUrl: string): string {
  const cleaned = cleanUrl(decodeEscapedValue(rawUrl));
  try {
    const parsed = new URL(cleaned);
    return cleanUrl(parsed.origin);
  } catch {
    return cleaned;
  }
}

function extractCandidatesFromSearchHtml(html: string): string[] {
  const candidates = new Set<string>();

  const websitePattern = /website_url:"(https?:\/\/[^"]+)"/g;
  for (const match of html.matchAll(websitePattern)) {
    const url = cleanUrl(decodeEscapedValue(match[1]));
    if (url.startsWith('http')) {
      candidates.add(url);
    }
  }

  const titleUrlPattern = /title:"[^"]{1,260}",url:"(https?:\/\/[^"]+)"/g;
  for (const match of html.matchAll(titleUrlPattern)) {
    const url = cleanUrl(decodeEscapedValue(match[1]));
    if (url.startsWith('http')) {
      candidates.add(url);
    }
  }

  return [...candidates];
}

function looksLikeSearchCaptcha(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes('pow captcha') ||
    lower.includes('our systems have detected unusual traffic') ||
    lower.includes('unfortunately, bots use duckduckgo too') ||
    lower.includes('please complete the following challenge')
  );
}

async function fetchJson(
  url: string,
  httpClient: HttpClient,
  timeoutMs = 20000,
): Promise<Record<string, unknown> | null> {
  const response = await httpClient.requestMaybe(url, {
    maxBytes: 1_500_000,
    retries: 1,
    timeoutMs,
    headers: {
      accept: 'application/json,text/javascript,*/*',
    },
  });

  if (!response || response.status >= 400 || !response.body) {
    return null;
  }

  try {
    return JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isLikelyFirstNationEntity(label: string, description: string): boolean {
  const combined = `${label} ${description}`.toLowerCase();
  return /first nation|indian reserve|indigenous|band|reserve|tribal/i.test(combined);
}

function isLikelyCanadianEntity(description: string): boolean {
  return /\b(canada|ontario|manitoba|quebec|saskatchewan|alberta|british columbia)\b/i.test(
    description.toLowerCase(),
  );
}

function wikidataOfficialWebsiteUrls(entity: Record<string, unknown>): string[] {
  const claims = (entity?.claims as Record<string, unknown> | undefined)?.P856 as
    | WikidataClaim[]
    | undefined;
  if (!claims || claims.length === 0) {
    return [];
  }

  const preferred: string[] = [];
  const normal: string[] = [];

  for (const claim of claims) {
    const rawValue = claim?.mainsnak?.datavalue?.value;
    if (typeof rawValue !== 'string' || !/^https?:\/\//i.test(rawValue)) {
      continue;
    }
    if (claim.rank === 'deprecated') {
      continue;
    }

    if (claim.rank === 'preferred') {
      preferred.push(rawValue);
    } else {
      normal.push(rawValue);
    }
  }

  return [...preferred, ...normal];
}

async function resolveHomepageViaWikidata(
  orgName: string,
  orgType: OrgType,
  tokens: string[],
  httpClient: HttpClient,
  logger?: RunLogger,
): Promise<CandidateScore | null> {
  if (orgType !== 'first_nation') {
    return null;
  }

  const queries = [`${orgName} First Nation`, orgName];
  let best: CandidateScore | null = null;

  for (const query of queries) {
    const searchPayload = await fetchJson(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=8&search=${encodeURIComponent(
        query,
      )}`,
      httpClient,
      15000,
    );

    const items = (searchPayload?.search as WikidataSearchItem[] | undefined) ?? [];
    for (const item of items.slice(0, 6)) {
      const id = (item.id ?? '').trim();
      if (!id) {
        continue;
      }

      const label = normalizeWhitespace(item.label ?? '');
      const description = normalizeWhitespace(item.description ?? '');
      const similarity = diceSimilarity(orgName, label);
      if (similarity < 0.45) {
        continue;
      }

      if (!isLikelyFirstNationEntity(label, description)) {
        continue;
      }

      const entityPayload = await fetchJson(
        `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(id)}.json`,
        httpClient,
        15000,
      );
      if (!entityPayload) {
        continue;
      }

      const entities = (entityPayload.entities as Record<string, Record<string, unknown>> | undefined) ?? {};
      const entity = entities[id];
      if (!entity) {
        continue;
      }

      const websiteUrls = wikidataOfficialWebsiteUrls(entity);
      for (const websiteUrl of websiteUrls.slice(0, 3)) {
        const scored = await scoreHomepageCandidate(websiteUrl, orgName, orgType, tokens, httpClient);
        if (!scored) {
          continue;
        }

        let scoreBoost = similarity * 3;
        if (isLikelyCanadianEntity(description)) {
          scoreBoost += 1;
        }

        const candidate: CandidateScore = {
          ...scored,
          score: scored.score + scoreBoost,
        };

        if (!best || candidate.score > best.score) {
          best = candidate;
        }
      }
    }
  }

  if (logger && best) {
    await logger.info(`Wikidata fallback matched "${orgName}" => ${best.url}`);
  }

  return best;
}

async function searchBraveCandidates(
  query: string,
  httpClient: HttpClient,
  logger?: RunLogger,
): Promise<string[]> {
  if (braveSearchUnavailable) {
    return [];
  }

  const cleanedQuery = normalizeWhitespace(query);
  if (!cleanedQuery) {
    return [];
  }

  const cacheKey = cleanedQuery.toLowerCase();
  if (SEARCH_CACHE.has(cacheKey)) {
    return SEARCH_CACHE.get(cacheKey) ?? [];
  }

  const url = `https://search.brave.com/search?q=${encodeURIComponent(cleanedQuery)}&source=web`;
  const response = await httpClient.requestMaybe(url, {
    maxBytes: 2_500_000,
    retries: 1,
    timeoutMs: 20000,
  });

  if (!response || response.status >= 400 || !response.body) {
    SEARCH_CACHE.set(cacheKey, []);
    return [];
  }

  if (looksLikeSearchCaptcha(response.body)) {
    SEARCH_CACHE.set(cacheKey, []);
    braveSearchUnavailable = true;
    if (logger) {
      await logger.warn('Brave search fallback disabled due anti-bot challenge response.');
    }
    return [];
  }

  const candidates = extractCandidatesFromSearchHtml(response.body)
    .filter((candidate) => !candidate.includes('imgs.search.brave.com'))
    .filter((candidate) => !candidate.includes('cdn.search.brave.com'));

  SEARCH_CACHE.set(cacheKey, candidates);
  if (logger && candidates.length > 0) {
    await logger.info(`Search fallback query "${cleanedQuery}" yielded ${candidates.length} candidates.`);
  }
  return candidates;
}

async function scoreHomepageCandidate(
  candidateUrl: string,
  orgName: string,
  orgType: OrgType,
  tokens: string[],
  httpClient: HttpClient,
): Promise<CandidateScore | null> {
  const candidate = normalizeHomeCandidate(candidateUrl);
  const host = parseHostname(candidate);
  if (!host || isBlockedHost(host)) {
    return null;
  }

  let response = await httpClient.requestMaybe(candidate, {
    maxBytes: 900_000,
    retries: 1,
    timeoutMs: 15000,
  });
  if ((!response || response.status >= 400) && candidate.startsWith('https://')) {
    const httpCandidate = cleanUrl(`http://${host}`);
    response = await httpClient.requestMaybe(httpCandidate, {
      maxBytes: 900_000,
      retries: 1,
      timeoutMs: 15000,
    });
  }

  if (!response || response.status >= 400) {
    return null;
  }

  const textSource = `${extractTitle(response.body)} ${response.body}`.toLowerCase();
  const hostPath = hostPathValue(candidate);
  const tokenHitsOnPage = countTokenHits(textSource, tokens);
  const tokenHitsOnHost = countTokenHits(hostPath, tokens);

  let score = tokenHitsOnPage * 2 + tokenHitsOnHost * 3;
  if (/official website|welcome/i.test(textSource)) {
    score += 1;
  }

  if (orgType === 'first_nation') {
    if (/first nation|band council|chief and council|anishinaab|indigenous|cree|mohawk|haudenosaunee/i.test(textSource)) {
      score += 2;
    }
  } else if (/city|town|township|municipality|county|village|city hall|town hall/i.test(textSource)) {
    score += 2;
  }

  if (/wikipedia|news|obituary|tripadvisor|booking|casino/i.test(hostPath)) {
    score -= 4;
  }

  if (tokenHitsOnPage === 0 && tokenHitsOnHost === 0) {
    return null;
  }

  return {
    url: cleanUrl(response.url),
    score,
    discoveredVia: 'manual',
  };
}

async function scoreJobsCandidate(
  candidateUrl: string,
  orgName: string,
  homepageUrl: string,
  tokens: string[],
  httpClient: HttpClient,
): Promise<CandidateScore | null> {
  const cleanedCandidate = cleanUrl(candidateUrl);
  const host = parseHostname(cleanedCandidate);
  if (!host || isBlockedHost(host)) {
    return null;
  }

  let score = 0;
  let discoveredVia: DiscoveredVia = 'manual';
  if (isKnownAtsUrl(cleanedCandidate)) {
    score += 10;
  }
  if (homepageUrl && sameHost(cleanedCandidate, homepageUrl)) {
    score += 3;
  } else if (homepageUrl && !isKnownAtsUrl(cleanedCandidate)) {
    score -= 1;
  }

  const hostPath = hostPathValue(cleanedCandidate);
  score += keywordHitsInValue(hostPath, CAREER_TERMS) * 2;
  score += countTokenHits(hostPath, tokens);

  const response = await httpClient.requestMaybe(cleanedCandidate, {
    maxBytes: 900_000,
    retries: 1,
    timeoutMs: 15000,
  });
  let resolvedResponse = response;
  if ((!resolvedResponse || resolvedResponse.status >= 400) && cleanedCandidate.startsWith('https://')) {
    const hostOnly = parseHostname(cleanedCandidate);
    if (hostOnly) {
      const httpCandidate = cleanUrl(cleanedCandidate.replace(/^https:\/\//i, 'http://'));
      resolvedResponse = await httpClient.requestMaybe(httpCandidate, {
        maxBytes: 900_000,
        retries: 1,
        timeoutMs: 15000,
      });
    }
  }

  if (resolvedResponse && resolvedResponse.status < 400) {
    const finalUrl = cleanUrl(resolvedResponse.url);
    if (isKnownAtsUrl(finalUrl)) {
      return {
        url: finalUrl,
        score: 100,
        discoveredVia: 'manual',
      };
    }

    const body = resolvedResponse.body.toLowerCase();
    const textSource = `${extractTitle(resolvedResponse.body)} ${body}`;
    score += keywordHitsInValue(textSource, CAREER_TERMS);
    score += countTokenHits(textSource, tokens);

    if (looksLikePdf(finalUrl) || resolvedResponse.contentType.includes('pdf')) {
      score += 4;
      discoveredVia = 'pdf';
    }

    return {
      url: finalUrl,
      score,
      discoveredVia,
    };
  }

  if (looksLikePdf(cleanedCandidate)) {
    score += 4;
    discoveredVia = 'pdf';
  }

  if (score <= 0) {
    return null;
  }

  return {
    url: cleanedCandidate,
    score,
    discoveredVia,
  };
}

function uniqueCandidates(candidates: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of candidates) {
    const cleaned = cleanUrl(candidate);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    unique.push(cleaned);
  }
  return unique;
}

function buildHomepageQueries(orgName: string, orgType: OrgType): string[] {
  if (orgType === 'first_nation') {
    return [
      `${orgName} first nation ontario official website`,
      `"${orgName}" first nation website`,
      `${orgName} ontario band council`,
    ];
  }

  return [
    `${orgName} ontario municipality official website`,
    `${orgName} ontario city hall`,
  ];
}

function buildJobsQueries(orgName: string, orgType: OrgType, homepageUrl: string): string[] {
  const queries: string[] = [];
  if (homepageUrl) {
    const host = parseHostname(homepageUrl);
    if (host) {
      queries.push(`site:${host} careers`);
      queries.push(`site:${host} jobs`);
      queries.push(`site:${host} employment opportunities`);
    }
  }

  if (orgType === 'first_nation') {
    queries.push(`${orgName} first nation jobs`);
    queries.push(`${orgName} first nation employment opportunities`);
  } else {
    queries.push(`${orgName} ontario municipality jobs`);
    queries.push(`${orgName} ontario careers`);
  }

  return queries;
}

export async function resolveHomepageViaSearch(
  orgName: string,
  orgType: OrgType,
  httpClient: HttpClient,
  logger?: RunLogger,
): Promise<UrlResolutionResult | null> {
  const tokens = getNameTokens(orgName);
  if (tokens.length === 0) {
    return null;
  }

  const wikidataCandidate = await resolveHomepageViaWikidata(
    orgName,
    orgType,
    tokens,
    httpClient,
    logger,
  );
  if (wikidataCandidate && wikidataCandidate.score >= 5) {
    return {
      url: cleanUrl(wikidataCandidate.url),
      discoveredVia: wikidataCandidate.discoveredVia,
      notes: 'Homepage discovered via Wikidata fallback.',
    };
  }

  let best: CandidateScore | null = null;
  for (const query of buildHomepageQueries(orgName, orgType)) {
    const candidates = uniqueCandidates(await searchBraveCandidates(query, httpClient, logger))
      .map((candidate) => normalizeHomeCandidate(candidate))
      .filter((candidate) => candidate.startsWith('http'));

    const prioritized = uniqueCandidates(candidates).slice(0, 12);
    for (const candidate of prioritized) {
      const scored = await scoreHomepageCandidate(candidate, orgName, orgType, tokens, httpClient);
      if (!scored) {
        continue;
      }
      if (!best || scored.score > best.score) {
        best = scored;
      }
      if (best.score >= 9) {
        break;
      }
    }
    if (best && best.score >= 9) {
      break;
    }
  }

  if (!best || best.score < 4) {
    return null;
  }

  return {
    url: cleanUrl(best.url),
    discoveredVia: best.discoveredVia,
    notes: 'Homepage discovered via web research fallback.',
  };
}

export async function resolveJobsViaSearch(
  orgName: string,
  orgType: OrgType,
  homepageUrl: string,
  httpClient: HttpClient,
  logger?: RunLogger,
): Promise<UrlResolutionResult | null> {
  const tokens = getNameTokens(orgName);
  if (tokens.length === 0) {
    return null;
  }

  let best: CandidateScore | null = null;
  for (const query of buildJobsQueries(orgName, orgType, homepageUrl)) {
    const candidates = uniqueCandidates(await searchBraveCandidates(query, httpClient, logger)).slice(0, 14);
    for (const candidate of candidates) {
      const scored = await scoreJobsCandidate(candidate, orgName, homepageUrl, tokens, httpClient);
      if (!scored) {
        continue;
      }
      if (!best || scored.score > best.score) {
        best = scored;
      }
      if (best.score >= 12) {
        break;
      }
    }
    if (best && best.score >= 12) {
      break;
    }
  }

  if (!best || best.score < 4) {
    return null;
  }

  return {
    url: cleanUrl(best.url),
    discoveredVia: best.discoveredVia,
    notes: 'Jobs URL discovered via web research fallback.',
  };
}
