import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { buildMunicipalitySeed } from './discovery/municipalities.js';
import { buildFirstNationsSeed } from './discovery/firstNations.js';
import { discoverJobsUrl } from './discovery/jobsDiscovery.js';
import { classifyJobsSource } from './discovery/classify.js';
import type { ClassificationResult, OrgRecord, SeedOrg } from './types.js';
import { HttpClient } from './utils/http.js';
import { RunLogger } from './utils/logger.js';
import { readOrgsCsv, writeOrgsCsv, selectManualReview } from './utils/csv.js';
import { mapWithConcurrency } from './utils/concurrency.js';
import { cleanUrl } from './utils/url.js';
import { slugify } from './utils/text.js';

interface CliArgs {
  firstNationsFile: string;
  skipMunicipalities: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    firstNationsFile: 'data/first_nations_input.txt',
    skipMunicipalities: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--first-nations-file' && argv[i + 1]) {
      args.firstNationsFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--skip-municipalities') {
      args.skipMunicipalities = true;
    }
  }

  return args;
}

function dateStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function buildOrgId(orgType: OrgRecord['org_type'], orgName: string, index: number): string {
  const prefix = orgType === 'municipality' ? 'mun' : 'fn';
  const slug = slugify(orgName) || 'org';
  return `${prefix}-${String(index + 1).padStart(4, '0')}-${slug}`;
}

function mergeNotes(...values: Array<string | undefined>): string {
  return values
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .map((value) => value.trim())
    .join(' | ');
}

function manualClassification(): ClassificationResult {
  return {
    jobsSourceType: 'manual_review',
    adapter: 'manual',
    confidence: 0,
  };
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function roundConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 10) / 10));
}

interface ProcessOptions {
  fastDiscovery?: boolean;
  classifyWithBrowser?: boolean;
}

async function processOrg(
  seed: SeedOrg,
  index: number,
  runDate: string,
  httpClient: HttpClient,
  browser: Browser,
  logger: RunLogger,
  options: ProcessOptions = {},
): Promise<OrgRecord> {
  const homepageUrl = cleanUrl(seed.homepageUrl || '');

  try {
    let jobsUrl = '';
    let discoveredVia: OrgRecord['discovered_via'] = 'manual';
    let notes = seed.notes ?? '';
    let classification: ClassificationResult = manualClassification();

    if (homepageUrl) {
      const discovered = await discoverJobsUrl(homepageUrl, httpClient, {
        fast: options.fastDiscovery ?? false,
      });
      jobsUrl = cleanUrl(discovered.jobsUrl || '');
      discoveredVia = discovered.discoveredVia;
      notes = mergeNotes(notes, discovered.notes);

      if (jobsUrl) {
        classification = await classifyJobsSource(
          jobsUrl,
          httpClient,
          options.classifyWithBrowser === false ? undefined : browser,
        );
      } else {
        classification = manualClassification();
      }
    } else {
      classification = manualClassification();
      discoveredVia = 'manual';
      notes = mergeNotes(notes, 'Homepage URL unavailable.');
    }

    const orgRecord: OrgRecord = {
      org_id: buildOrgId(seed.orgType, seed.orgName, index),
      org_name: seed.orgName,
      org_type: seed.orgType,
      homepage_url: homepageUrl,
      jobs_url: jobsUrl,
      jobs_source_type: classification.jobsSourceType,
      adapter: classification.adapter,
      confidence: roundConfidence(classification.confidence),
      discovered_via: discoveredVia,
      last_verified: runDate,
      notes,
    };

    if (orgRecord.jobs_source_type === 'manual_review') {
      orgRecord.adapter = 'manual';
      orgRecord.confidence = 0;
      orgRecord.discovered_via = 'manual';
    }

    return orgRecord;
  } catch (error) {
    await logger.error(`Org processing failed for ${seed.orgName}: ${String(error)}`);
    return {
      org_id: buildOrgId(seed.orgType, seed.orgName, index),
      org_name: seed.orgName,
      org_type: seed.orgType,
      homepage_url: homepageUrl,
      jobs_url: '',
      jobs_source_type: 'manual_review',
      adapter: 'manual',
      confidence: 0,
      discovered_via: 'manual',
      last_verified: runDate,
      notes: mergeNotes(seed.notes, `Processing failure: ${String(error)}`),
    };
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runDate = dateStamp();
  const logger = new RunLogger(`logs/discovery_run_${runDate}.log`);
  const httpClient = new HttpClient(20000);
  const fastHttpClient = new HttpClient(8000);

  await logger.init();
  await logger.info(`Discovery run date: ${runDate}`);
  await logger.info(`Using First Nations input file: ${args.firstNationsFile}`);
  await logger.info(`skip_municipalities=${String(args.skipMunicipalities)}`);

  const browser = await chromium.launch({ headless: true });

  try {
    let municipalityRecords: OrgRecord[] = [];
    let firstNationStartIndex = 0;

    if (args.skipMunicipalities) {
      const existingOrgs = await readOrgsCsv('data/orgs.csv');
      municipalityRecords = existingOrgs.filter((record) => record.org_type === 'municipality');
      if (municipalityRecords.length === 0) {
        throw new Error(
          'No municipality rows found in data/orgs.csv. Run without --skip-municipalities first.',
        );
      }
      firstNationStartIndex = municipalityRecords.length;
      await logger.info(`Reusing municipality rows from existing data/orgs.csv: ${municipalityRecords.length}`);
    } else {
      const municipalities = await buildMunicipalitySeed(httpClient, logger);
      await writeJson('data/municipalities_seed.json', municipalities);
      await logger.info(`Processing municipality seeds: ${municipalities.length}`);

      municipalityRecords = await mapWithConcurrency(municipalities, 6, async (seed, index) => {
        const record = await processOrg(seed, index, runDate, httpClient, browser, logger);
        await logger.info(
          `${record.org_type}:${record.org_name} => jobs_source_type=${record.jobs_source_type}, confidence=${record.confidence.toFixed(
            1,
          )}`,
        );
        return record;
      });
      firstNationStartIndex = municipalityRecords.length;
    }

    const firstNations = await buildFirstNationsSeed(args.firstNationsFile, browser, httpClient, logger);
    await writeJson('data/first_nations_seed.json', firstNations);
    await logger.info(`Processing first nation seeds: ${firstNations.length}`);
    if (args.skipMunicipalities) {
      await logger.info('First Nation processing mode: fast (short timeouts, no browser classification)');
    }

    const firstNationRecords = await mapWithConcurrency(firstNations, 6, async (seed, index) => {
      const record = await processOrg(
        seed as SeedOrg,
        firstNationStartIndex + index,
        runDate,
        args.skipMunicipalities ? fastHttpClient : httpClient,
        browser,
        logger,
        {
          fastDiscovery: args.skipMunicipalities,
          classifyWithBrowser: !args.skipMunicipalities,
        },
      );
      await logger.info(
        `${record.org_type}:${record.org_name} => jobs_source_type=${record.jobs_source_type}, confidence=${record.confidence.toFixed(
          1,
        )}`,
      );
      return record;
    });

    const sortedRecords = [...municipalityRecords, ...firstNationRecords].sort((a, b) => {
      if (a.org_type !== b.org_type) {
        return a.org_type.localeCompare(b.org_type);
      }
      return a.org_name.localeCompare(b.org_name);
    });

    await writeOrgsCsv('data/orgs.csv', sortedRecords);

    const manualReviewRows = selectManualReview(sortedRecords);
    await writeOrgsCsv('data/manual_review.csv', manualReviewRows);

    const withJobsUrl = sortedRecords.filter((record) => record.jobs_url).length;
    const manualReviewTotal = sortedRecords.filter(
      (record) => record.jobs_source_type === 'manual_review',
    ).length;
    const unknownTotal = sortedRecords.filter((record) => record.jobs_source_type === 'unknown').length;
    const manualReviewFlagTotal = manualReviewRows.length;

    await logger.info(`total_orgs=${sortedRecords.length}`);
    await logger.info(`with_jobs_url=${withJobsUrl}`);
    await logger.info(`manual_review_total=${manualReviewTotal}`);
    await logger.info(`unknown_total=${unknownTotal}`);
    await logger.info(`manual_review_flag_total=${manualReviewFlagTotal}`);
  } finally {
    await browser.close();
    await logger.close();
  }
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
