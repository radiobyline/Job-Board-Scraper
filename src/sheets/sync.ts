import { google } from 'googleapis';
import type { SheetPostingRow } from '../monitor/types.js';

const TAB_NAME = 'Postings';
const HEADER = [
  'posting_id',
  'first_seen',
  'last_seen',
  'org_name',
  'org_type',
  'title',
  'location',
  'posted_date',
  'closing_date',
  'url',
  'jobs_source_type',
  'adapter',
  'status',
  'applied_date',
  'notes',
] as const;

interface SheetSyncResult {
  synced: boolean;
  updatedRows: number;
  insertedRows: number;
  reason?: string;
}

function asString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function rowToValues(row: SheetPostingRow): string[] {
  return [
    row.postingId,
    row.firstSeen,
    row.lastSeen,
    row.orgName,
    row.orgType,
    row.title,
    row.location,
    row.postedDate,
    row.closingDate,
    row.url,
    row.jobsSourceType,
    row.adapter,
    '',
    '',
    '',
  ];
}

async function getSheetsClient(serviceAccountJson: string) {
  const credentials = JSON.parse(serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({
    version: 'v4',
    auth,
  });
}

async function ensurePostingsTab(sheets: ReturnType<typeof google.sheets>, spreadsheetId: string): Promise<void> {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = metadata.data.sheets?.find((entry) => entry.properties?.title === TAB_NAME);
  if (sheet) {
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: TAB_NAME,
            },
          },
        },
      ],
    },
  });
}

async function ensureHeaderRow(sheets: ReturnType<typeof google.sheets>, spreadsheetId: string): Promise<void> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${TAB_NAME}!A1:O1`,
  });

  const current = response.data.values?.[0]?.map((value) => asString(value)) ?? [];
  const expected = [...HEADER];
  const matches =
    current.length === expected.length && current.every((value, index) => value === expected[index]);

  if (matches) {
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${TAB_NAME}!A1:O1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [expected as unknown as string[]],
    },
  });
}

export async function syncPostingsToGoogleSheet(params: {
  serviceAccountJson?: string;
  spreadsheetId?: string;
  rows: SheetPostingRow[];
}): Promise<SheetSyncResult> {
  const { serviceAccountJson, spreadsheetId, rows } = params;
  if (!serviceAccountJson || !spreadsheetId) {
    return {
      synced: false,
      updatedRows: 0,
      insertedRows: 0,
      reason: 'Google Sheets secrets missing.',
    };
  }

  if (rows.length === 0) {
    return {
      synced: true,
      updatedRows: 0,
      insertedRows: 0,
    };
  }

  const sheets = await getSheetsClient(serviceAccountJson);
  await ensurePostingsTab(sheets, spreadsheetId);
  await ensureHeaderRow(sheets, spreadsheetId);

  const existingResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${TAB_NAME}!A2:O`,
  });

  const existing = existingResponse.data.values ?? [];
  const rowByPostingId = new Map<string, number>();
  for (let i = 0; i < existing.length; i += 1) {
    const postingId = asString(existing[i]?.[0]).trim();
    if (!postingId) {
      continue;
    }
    rowByPostingId.set(postingId, i + 2);
  }

  const updateData: Array<{ range: string; values: string[][] }> = [];
  const appendRows: string[][] = [];

  for (const row of rows) {
    const values = rowToValues(row);
    const rowIndex = rowByPostingId.get(row.postingId);
    if (rowIndex) {
      updateData.push({
        range: `${TAB_NAME}!A${rowIndex}:L${rowIndex}`,
        values: [values.slice(0, 12)],
      });
      continue;
    }
    appendRows.push(values);
  }

  if (updateData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updateData,
      },
    });
  }

  if (appendRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${TAB_NAME}!A:O`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: appendRows,
      },
    });
  }

  return {
    synced: true,
    updatedRows: updateData.length,
    insertedRows: appendRows.length,
  };
}
