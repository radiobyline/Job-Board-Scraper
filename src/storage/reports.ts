import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UrlRepairRecord } from '../monitor/types.js';

function escapeCsvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function writeUrlRepairsReport(
  filePath: string,
  repairs: UrlRepairRecord[],
): Promise<void> {
  const header = ['original_url', 'working_url', 'status_code', 'notes'];
  const rows = repairs.map((repair) => [
    repair.original_url,
    repair.working_url,
    String(repair.status_code),
    repair.notes,
  ]);

  const lines = [header, ...rows].map((row) => row.map((cell) => escapeCsvCell(cell)).join(','));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}
