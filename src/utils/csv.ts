import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OrgRecord } from '../types.js';

export const ORGS_CSV_HEADER = [
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
  const lines = [ORGS_CSV_HEADER.join(','), ...records.map((record) => toRow(record))];
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function parseCsvContent(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }

    if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    if (char === '\r') {
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

export async function readOrgsCsv(filePath: string): Promise<OrgRecord[]> {
  const content = await readFile(filePath, 'utf8');
  const rows = parseCsvContent(content).filter((row) => row.some((cell) => cell.length > 0));
  if (rows.length === 0) {
    return [];
  }

  const expectedHeader = ORGS_CSV_HEADER.join(',');
  if (rows[0].join(',') !== expectedHeader) {
    throw new Error(`Unexpected header in ${filePath}`);
  }

  const records: OrgRecord[] = [];
  for (const cells of rows.slice(1)) {
    if (cells.length < ORGS_CSV_HEADER.length) {
      continue;
    }

    records.push({
      org_id: cells[0],
      org_name: cells[1],
      org_type: cells[2] as OrgRecord['org_type'],
      homepage_url: cells[3],
      jobs_url: cells[4],
      jobs_source_type: cells[5] as OrgRecord['jobs_source_type'],
      adapter: cells[6] as OrgRecord['adapter'],
      confidence: Number(cells[7]),
      discovered_via: cells[8] as OrgRecord['discovered_via'],
      last_verified: cells[9],
      notes: cells[10] ?? '',
    });
  }

  return records;
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
