import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OrgRecord } from '../types.js';

const HEADER = [
  'org_id',
  'org_name',
  'org_type',
  'homepage_url',
  'jobs_url',
  'jobs_source_type',
  'adapter',
  'confidence',
  'discovered_via',
  'last_verified',
  'notes',
] as const;

function escapeCell(value: string): string {
  const needsQuote = /[",\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

function toRow(record: OrgRecord): string {
  return [
    record.org_id,
    record.org_name,
    record.org_type,
    record.homepage_url,
    record.jobs_url,
    record.jobs_source_type,
    record.adapter,
    record.confidence.toFixed(1),
    record.discovered_via,
    record.last_verified,
    record.notes,
  ]
    .map((cell) => escapeCell(String(cell ?? '')))
    .join(',');
}

export async function writeOrgsCsv(filePath: string, records: OrgRecord[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const lines = [HEADER.join(','), ...records.map((record) => toRow(record))];
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

export function selectManualReview(records: OrgRecord[]): OrgRecord[] {
  const priority = new Map<string, number>([
    ['manual_review', 0],
    ['unknown', 1],
  ]);

  return records
    .filter(
      (record) =>
        record.confidence < 0.5 ||
        record.jobs_source_type === 'unknown' ||
        record.jobs_source_type === 'manual_review',
    )
    .sort((a, b) => {
      const aP = priority.get(a.jobs_source_type) ?? 2;
      const bP = priority.get(b.jobs_source_type) ?? 2;
      if (aP !== bP) {
        return aP - bP;
      }
      if (a.confidence !== b.confidence) {
        return a.confidence - b.confidence;
      }
      return a.org_name.localeCompare(b.org_name);
    });
}
