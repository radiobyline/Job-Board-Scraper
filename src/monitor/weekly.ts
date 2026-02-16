import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { chooseGroupAdapter, runAdapter } from '../adapters/index.js';
import { FirstNationMatcher } from '../attribution/matcher.js';
import { PostingsDatabase } from '../db/sqlite.js';
import { renderWeeklyEmailHtml, renderWeeklyEmailText, sendWeeklyEmail, writeWeeklyEmailReport } from '../email/digest.js';
import type {
  EligibleOrg,
  JobsUrlGroup,
  NewPostingRow,
  SheetPostingRow,
  UrlRepairRecord,
  WeeklyTotals,
} from './types.js';
import { resolveWorkingJobsUrl, normalizeJobsUrlKey, toUrlRepairRecord } from '../net/urlRepair.js';
import { syncPostingsToGoogleSheet } from '../sheets/sync.js';
import { writeUrlRepairsReport } from '../storage/reports.js';
import type { OrgRecord } from '../types.js';
import { readOrgsCsv } from '../utils/csv.js';
import { HttpClient } from '../utils/http.js';
import { RunLogger } from '../utils/logger.js';

export interface WeeklyRunOptions {
  maxGroups?: number;
}

function dateStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function asIsoNow(): string {
  return new Date().toISOString();
}

function buildEligibleOrgs(orgs: OrgRecord[]): {
  eligible: EligibleOrg[];
  skippedCount: number;
} {
  const eligible: EligibleOrg[] = [];
  let skippedCount = 0;

  for (const org of orgs) {
    const isEligible =
      org.jobs_url &&
      org.confidence >= 0.5 &&
      org.jobs_source_type !== 'manual_review' &&
      org.adapter !== 'manual';

    if (!isEligible) {
      skippedCount += 1;
      continue;
    }

    eligible.push({
      ...org,
      jobs_url_key: normalizeJobsUrlKey(org.jobs_url),
    });
  }

  return { eligible, skippedCount };
}

function buildJobsUrlGroups(eligible: EligibleOrg[]): JobsUrlGroup[] {
  const map = new Map<string, JobsUrlGroup>();
  for (const org of eligible) {
    const key = org.jobs_url_key;
    const existing = map.get(key);
    if (existing) {
      existing.orgs.push(org);
      continue;
    }
    map.set(key, {
      key,
      originalUrl: org.jobs_url,
      orgs: [org],
    });
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function createInitialTotals(totalOrgs: number, eligibleCount: number, groupCount: number, maxGroupSize: number): WeeklyTotals {
  return {
    total_orgs_in_csv: totalOrgs,
    eligible_orgs_count: eligibleCount,
    unique_jobs_url_groups_count: groupCount,
    jobs_url_group_max_size: maxGroupSize,
    groups_scraped_count: 0,
    groups_skipped_unreachable_count: 0,
    orgs_skipped_low_confidence_count: totalOrgs - eligibleCount,
    url_repair_attempted_count: 0,
    url_repair_success_count: 0,
    extra_attribution_associations_count: 0,
    new_postings_count: 0,
  };
}

interface NewPostingDbRow {
  posting_id: string;
  org_id: string;
  title: string;
  url: string;
  location: string | null;
  posted_date: string | null;
  closing_date: string | null;
  snippet: string | null;
  jobs_source_type: string;
  adapter: string;
}

function makeNewPostingRows(rows: NewPostingDbRow[], orgMap: Map<string, OrgRecord>): NewPostingRow[] {
  return rows.map((row) => {
    const orgId = row.org_id;
    const org = orgMap.get(orgId);
    return {
      postingId: row.posting_id,
      orgId,
      title: row.title,
      url: row.url,
      location: row.location ?? undefined,
      postedDate: row.posted_date ?? undefined,
      closingDate: row.closing_date ?? undefined,
      snippet: row.snippet ?? undefined,
      orgName: org?.org_name ?? orgId,
      orgType: org?.org_type ?? 'municipality',
      jobsSourceType: row.jobs_source_type as NewPostingRow['jobsSourceType'],
      adapter: row.adapter as NewPostingRow['adapter'],
    };
  });
}

async function buildSheetRows(
  db: PostingsDatabase,
  runId: number,
  orgMap: Map<string, OrgRecord>,
): Promise<SheetPostingRow[]> {
  const aggregates = db.getPostingAggregatesSeenInRun(runId);
  const runDateCache = new Map<number, string>();
  const resolveRunDate = (id: number): string => {
    if (!runDateCache.has(id)) {
      runDateCache.set(id, db.getRunStartedAt(id) ?? '');
    }
    return runDateCache.get(id) ?? '';
  };

  return aggregates.map((item) => {
    const orgIds = String(item.org_ids ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    const orgNames = orgIds
      .map((orgId) => orgMap.get(orgId)?.org_name ?? orgId)
      .filter((value, index, arr) => arr.indexOf(value) === index);
    const orgTypes = orgIds
      .map((orgId) => orgMap.get(orgId)?.org_type ?? '')
      .filter((value) => Boolean(value))
      .filter((value, index, arr) => arr.indexOf(value) === index);

    return {
      postingId: item.posting_id,
      firstSeen: resolveRunDate(item.first_seen_run_id),
      lastSeen: resolveRunDate(item.last_seen_run_id),
      orgName: orgNames.join('; '),
      orgType: orgTypes.join('|'),
      title: item.title,
      location: item.location ?? '',
      postedDate: item.posted_date ?? '',
      closingDate: item.closing_date ?? '',
      url: item.url,
      jobsSourceType: item.jobs_source_type,
      adapter: item.adapter,
    };
  });
}

export async function runWeeklyPipeline(options: WeeklyRunOptions = {}): Promise<void> {
  const runDate = dateStamp();
  const logger = new RunLogger(`logs/weekly_run_${runDate}.log`, 'Weekly run');
  const httpClient = new HttpClient(20000);
  const browser = await chromium.launch({ headless: true });

  await logger.init();
  await mkdir('reports', { recursive: true });
  await mkdir('data', { recursive: true });

  const db = new PostingsDatabase('data/postings.sqlite');
  await db.init();

  const startedAt = asIsoNow();
  const runId = db.createRun('weekly', startedAt);

  const urlRepairs: UrlRepairRecord[] = [];
  let totals: WeeklyTotals | null = null;
  let emailSent = false;

  try {
    const orgs = await readOrgsCsv('data/orgs.csv');
    const orgMap = new Map(orgs.map((org) => [org.org_id, org]));

    const { eligible, skippedCount } = buildEligibleOrgs(orgs);
    const groups = buildJobsUrlGroups(eligible);
    const limitedGroups = options.maxGroups ? groups.slice(0, options.maxGroups) : groups;

    const matcher = new FirstNationMatcher(orgs);
    totals = createInitialTotals(
      orgs.length,
      eligible.length,
      limitedGroups.length,
      limitedGroups.reduce((max, group) => Math.max(max, group.orgs.length), 0),
    );
    totals.orgs_skipped_low_confidence_count = skippedCount;

    await logger.info(`run_id=${runId}`);
    await logger.info(`eligible_orgs=${eligible.length}`);
    await logger.info(`unique_jobs_url_groups=${limitedGroups.length}`);

    for (const group of limitedGroups) {
      totals.url_repair_attempted_count += 1;
      const resolved = await resolveWorkingJobsUrl(group.originalUrl, httpClient, logger);
      if (!resolved) {
        totals.groups_skipped_unreachable_count += 1;
        continue;
      }

      if (resolved.repairApplied) {
        totals.url_repair_success_count += 1;
        const record = toUrlRepairRecord(group.originalUrl, resolved);
        if (record) {
          urlRepairs.push(record);
        }
      }

      const choice = chooseGroupAdapter(group.orgs);
      let postings = [];
      try {
        postings = await runAdapter(choice.adapter, resolved.workingUrl, httpClient, browser);
      } catch (error) {
        await logger.warn(
          `Adapter failed for group ${group.key} adapter=${choice.adapter}: ${String(error)}`,
        );
        continue;
      }

      totals.groups_scraped_count += 1;
      if (postings.length === 0) {
        continue;
      }

      const baseOrgIds = new Set(group.orgs.map((org) => org.org_id));
      for (const posting of postings) {
        const associationOrgIds = new Set(baseOrgIds);
        const attributionText = posting.attribution_text ?? `${posting.title} ${posting.snippet ?? ''}`;
        const matchedFnOrgIds = matcher.match(attributionText);
        for (const matchedOrgId of matchedFnOrgIds) {
          if (!associationOrgIds.has(matchedOrgId)) {
            totals.extra_attribution_associations_count += 1;
          }
          associationOrgIds.add(matchedOrgId);
        }

        for (const orgId of associationOrgIds) {
          db.upsertPostingAssociation({
            posting,
            orgId,
            runId,
            jobsSourceType: choice.jobsSourceType,
            adapter: choice.adapter,
          });
        }
      }
    }

    const newRowsRaw = db.getNewPostingsByAssociation(runId);
    const newRows = makeNewPostingRows(newRowsRaw, orgMap);
    totals.new_postings_count = newRows.length;

    const emailHtml = renderWeeklyEmailHtml(runDate, totals, newRows);
    const emailText = renderWeeklyEmailText(runDate, totals, newRows);
    const emailReportPath = `reports/weekly_email_${runDate}.html`;
    await writeWeeklyEmailReport(emailReportPath, emailHtml);

    try {
      const emailResult = await sendWeeklyEmail({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.EMAIL_FROM,
        to: process.env.EMAIL_TO,
        subject: `Weekly Jobs Digest - ${runDate}`,
        html: emailHtml,
        text: emailText,
      });
      emailSent = emailResult.sent;
      if (!emailResult.sent) {
        await logger.warn(`Email not sent: ${emailResult.reason ?? 'unknown reason'}`);
      } else {
        await logger.info('Weekly email sent.');
      }
    } catch (error) {
      await logger.warn(`Email send failed: ${String(error)}`);
    }

    const sheetRows = await buildSheetRows(db, runId, orgMap);
    try {
      const sheetResult = await syncPostingsToGoogleSheet({
        serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        rows: sheetRows,
      });
      if (!sheetResult.synced) {
        await logger.warn(`Google Sheets sync skipped: ${sheetResult.reason ?? 'unknown reason'}`);
      } else {
        await logger.info(
          `Google Sheets sync complete: updated=${sheetResult.updatedRows} inserted=${sheetResult.insertedRows}`,
        );
      }
    } catch (error) {
      await logger.warn(`Google Sheets sync failed: ${String(error)}`);
    }

    await writeUrlRepairsReport(`reports/url_repairs_${runDate}.csv`, urlRepairs);

    const finishedAt = asIsoNow();
    db.finishRun(runId, finishedAt, JSON.stringify(totals));
    await db.save();

    await logger.info(`total_orgs_in_csv=${totals.total_orgs_in_csv}`);
    await logger.info(`eligible_orgs_count=${totals.eligible_orgs_count}`);
    await logger.info(`unique_jobs_url_groups_count=${totals.unique_jobs_url_groups_count}`);
    await logger.info(`jobs_url_group_max_size=${totals.jobs_url_group_max_size}`);
    await logger.info(`groups_scraped_count=${totals.groups_scraped_count}`);
    await logger.info(`groups_skipped_unreachable_count=${totals.groups_skipped_unreachable_count}`);
    await logger.info(`orgs_skipped_low_confidence_count=${totals.orgs_skipped_low_confidence_count}`);
    await logger.info(`url_repair_attempted_count=${totals.url_repair_attempted_count}`);
    await logger.info(`url_repair_success_count=${totals.url_repair_success_count}`);
    await logger.info(`extra_attribution_associations_count=${totals.extra_attribution_associations_count}`);
    await logger.info(`new_postings_count=${totals.new_postings_count}`);
    await logger.info(`email_sent=${String(emailSent)}`);
  } catch (error) {
    await logger.error(`Weekly pipeline failed: ${String(error)}`);
    if (totals) {
      db.finishRun(runId, asIsoNow(), JSON.stringify(totals));
      await db.save();
    }
    throw error;
  } finally {
    await browser.close();
    await logger.close();
  }
}
