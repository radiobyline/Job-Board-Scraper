import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import type { Browser } from 'playwright';
import { HttpClient } from '../utils/http.js';
import { RunLogger } from '../utils/logger.js';
import type { FirstNationSeed } from '../types.js';
import { cleanUrl, toAbsoluteUrl } from '../utils/url.js';
import { diceSimilarity, normalizeForMatch, normalizeWhitespace } from '../utils/text.js';
import { resolveHomepageViaSearch } from './research.js';

const SEARCH_URL = 'https://fnp-ppn.aadnc-aandc.gc.ca/fnp/main/Search/SearchFN.aspx?lang=eng';

interface SearchCandidate {
  name: string;
  profileUrl: string;
  address: string;
  score: number;
}

function parseInputLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

async function loadInputNames(inputFilePath: string, logger: RunLogger): Promise<string[]> {
  try {
    const content = await readFile(inputFilePath, 'utf8');
    const names = parseInputLines(content);
    await logger.info(`Loaded First Nations input names: ${names.length}`);
    return names;
  } catch (error) {
    await logger.warn(`Could not read ${inputFilePath}: ${String(error)}`);
    return [];
  }
}

async function selectOntarioIfAvailable(page: import('playwright').Page): Promise<void> {
  const options = await page.$$eval('#plcMain_ddlProvince option', (items) =>
    items.map((item) => ({ value: item.getAttribute('value') ?? '', label: item.textContent?.trim() ?? '' })),
  );

  const ontario = options.find((option) => /ontario/i.test(option.label));
  if (ontario) {
    await page.selectOption('#plcMain_ddlProvince', ontario.value);
  }
}

function candidateScore(inputName: string, candidateName: string, address: string): number {
  const base = diceSimilarity(inputName, candidateName);
  const exactBonus = normalizeForMatch(inputName) === normalizeForMatch(candidateName) ? 0.2 : 0;
  const ontarioBonus = /,\s*ON\b|\bOntario\b/i.test(address) ? 0.1 : 0;
  return Math.min(1, base + exactBonus + ontarioBonus);
}

async function loadOntarioDirectory(page: import('playwright').Page): Promise<SearchCandidate[]> {
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#plcMain_ddlProvince', { timeout: 10000 });
  await selectOntarioIfAvailable(page);

  await Promise.allSettled([
    page.waitForURL(
      (url) => {
        const href = url.toString();
        return href.includes('FNListGrid.aspx') || href.includes('SearchFN.aspx');
      },
      { timeout: 30000 },
    ),
    page.click('#plcMain_btnSearch'),
  ]);

  await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await page.waitForSelector('#tblFNlist tbody', { timeout: 10000 });
  const responseUrl = page.url();

  const rows = await page.$$eval('#tblFNlist tbody tr', (entries) =>
    entries.map((entry) => {
      const cells = entry.querySelectorAll('td');
      const nameAnchor = cells[1]?.querySelector('a');
      const name = nameAnchor?.textContent?.trim() ?? '';
      const href = nameAnchor?.getAttribute('href') ?? '';
      const address = cells[2]?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return { name, href, address };
    }),
  );

  return rows
    .map((row) => ({
      name: normalizeWhitespace(row.name),
      profileUrl: cleanUrl(toAbsoluteUrl(row.href, responseUrl)),
      address: normalizeWhitespace(row.address),
      score: 0,
    }))
    .filter((row) => row.name && row.profileUrl.startsWith('http'));
}

async function extractProfileData(
  page: import('playwright').Page,
  profileUrl: string,
): Promise<{ canonicalName: string; websiteUrl: string }> {
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const canonicalName = normalizeWhitespace(
    (await page.textContent('#plcMain_txtBandName').catch(() => '')) ||
      (await page.textContent('.control-label').catch(() => '')) ||
      '',
  );

  const websiteUrl = await page
    .$eval('#plcMain_anchor1', (anchor) => anchor.getAttribute('href') ?? '')
    .catch(async () => {
      const candidates = await page.$$eval('a[href]', (anchors) =>
        anchors.map((anchor) => {
          const href = anchor.getAttribute('href') ?? '';
          const rowText = anchor.closest('.row')?.textContent ?? '';
          return {
            href,
            rowText,
          };
        }),
      );

      const match = candidates.find(
        (candidate) => /web\s*site/i.test(candidate.rowText) && /^https?:\/\//i.test(candidate.href),
      );
      return match?.href ?? '';
    });

  return {
    canonicalName,
    websiteUrl: cleanUrl(websiteUrl),
  };
}

function pickBest(candidates: SearchCandidate[]): SearchCandidate | null {
  if (candidates.length === 0) {
    return null;
  }
  const best = candidates[0];
  if (best.score < 0.25) {
    return null;
  }
  return best;
}

function mergeNotes(...values: Array<string | undefined>): string {
  return values
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .map((value) => value.trim())
    .join(' | ');
}

function selectBestCandidate(inputName: string, directory: SearchCandidate[]): SearchCandidate | null {
  const inputNorm = normalizeForMatch(inputName);
  const exact = directory.find((candidate) => normalizeForMatch(candidate.name) === inputNorm);
  if (exact) {
    return { ...exact, score: 1 };
  }

  const scored = directory
    .map((candidate) => ({
      ...candidate,
      score: candidateScore(inputName, candidate.name, candidate.address),
    }))
    .sort((a, b) => b.score - a.score);

  return pickBest(scored);
}

export async function buildFirstNationsSeed(
  inputFilePath: string,
  browser: Browser,
  httpClient: HttpClient,
  logger: RunLogger,
): Promise<FirstNationSeed[]> {
  const names = await loadInputNames(inputFilePath, logger);
  if (names.length === 0) {
    return [];
  }

  const page = await browser.newPage();
  const seeds: FirstNationSeed[] = [];

  try {
    const ontarioDirectory = await loadOntarioDirectory(page);
    await logger.info(`Ontario First Nations directory entries loaded: ${ontarioDirectory.length}`);

    for (const inputName of names) {
      try {
        await logger.info(`Resolving First Nation: ${inputName}`);
        let notes = '';
        const chosenCandidate = selectBestCandidate(inputName, ontarioDirectory);

        if (!chosenCandidate) {
          notes = 'Unable to resolve profile from exact/fuzzy search.';
          const researchedHomepage = await resolveHomepageViaSearch(
            inputName,
            'first_nation',
            httpClient,
            logger,
          );
          const fallbackHomepage = researchedHomepage;
          if (fallbackHomepage) {
            notes = mergeNotes(notes, fallbackHomepage.notes);
          }
          seeds.push({
            inputName,
            canonicalName: inputName,
            orgName: inputName,
            orgType: 'first_nation',
            profileUrl: '',
            homepageUrl: fallbackHomepage?.url ?? '',
            notes,
          });
          await logger.warn(`First Nation unresolved: ${inputName}`);
          continue;
        }

        try {
          const profileData = await extractProfileData(page, chosenCandidate.profileUrl);
          const canonicalName = profileData.canonicalName || chosenCandidate.name || inputName;
          let homepageUrl = profileData.websiteUrl;

          if (homepageUrl) {
            homepageUrl = cleanUrl(homepageUrl);
          } else {
            notes = 'Profile resolved but Web Site URL not provided in profile.';
            const researchedHomepage = await resolveHomepageViaSearch(
              canonicalName,
              'first_nation',
              httpClient,
              logger,
            );
            let fallbackHomepage = researchedHomepage;
            if (!fallbackHomepage && normalizeForMatch(canonicalName) !== normalizeForMatch(inputName)) {
              fallbackHomepage = await resolveHomepageViaSearch(
                inputName,
                'first_nation',
                httpClient,
                logger,
              );
            }
            if (fallbackHomepage) {
              homepageUrl = fallbackHomepage.url;
              notes = mergeNotes(notes, fallbackHomepage.notes);
            }
          }

          seeds.push({
            inputName,
            canonicalName,
            orgName: canonicalName,
            orgType: 'first_nation',
            profileUrl: chosenCandidate.profileUrl,
            homepageUrl,
            notes,
          });
        } catch (error) {
          notes = `Profile extraction failed: ${String(error)}`;
          seeds.push({
            inputName,
            canonicalName: chosenCandidate.name || inputName,
            orgName: chosenCandidate.name || inputName,
            orgType: 'first_nation',
            profileUrl: chosenCandidate.profileUrl,
            homepageUrl: '',
            notes,
          });
        }
      } catch (error) {
        const notes = `First Nation resolution failed: ${String(error)}`;
        await logger.warn(`${notes} (${inputName})`);
        seeds.push({
          inputName,
          canonicalName: inputName,
          orgName: inputName,
          orgType: 'first_nation',
          profileUrl: '',
          homepageUrl: '',
          notes,
        });
      }
    }
  } finally {
    await page.close();
  }

  await logger.info(`First Nations seed finalized: ${seeds.length}`);
  return seeds;
}

export function profileUrlToAbsolute(profileUrl: string): string {
  if (!profileUrl) {
    return '';
  }
  try {
    return new URL(profileUrl).toString();
  } catch {
    return toAbsoluteUrl(profileUrl, SEARCH_URL);
  }
}
