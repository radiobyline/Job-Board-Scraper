import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import nodemailer from 'nodemailer';
import type { NewPostingRow, WeeklyTotals } from '../monitor/types.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function groupByOrg(rows: NewPostingRow[]): Map<string, NewPostingRow[]> {
  const map = new Map<string, NewPostingRow[]>();
  for (const row of rows) {
    const key = row.orgName;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

export function renderWeeklyEmailHtml(
  runDate: string,
  totals: WeeklyTotals,
  newRows: NewPostingRow[],
): string {
  const grouped = groupByOrg(newRows);
  const sections: string[] = [];

  for (const [orgName, rows] of grouped.entries()) {
    const items = rows
      .map((row) => {
        const location = row.location ? ` | ${escapeHtml(row.location)}` : '';
        const dates = [
          row.postedDate ? `Posted: ${escapeHtml(row.postedDate)}` : '',
          row.closingDate ? `Closing: ${escapeHtml(row.closingDate)}` : '',
        ]
          .filter(Boolean)
          .join(' | ');

        return `<li><a href="${escapeHtml(row.url)}">${escapeHtml(row.title)}</a>${location}${
          dates ? ` <small>(${dates})</small>` : ''
        }</li>`;
      })
      .join('\n');

    sections.push(`<h3>${escapeHtml(orgName)} (${rows.length})</h3>\n<ul>${items}</ul>`);
  }

  const totalsList = `
    <ul>
      <li>Total orgs in CSV: ${totals.total_orgs_in_csv}</li>
      <li>Eligible orgs: ${totals.eligible_orgs_count}</li>
      <li>Unique jobs URL groups: ${totals.unique_jobs_url_groups_count}</li>
      <li>Groups scraped: ${totals.groups_scraped_count}</li>
      <li>Groups skipped unreachable: ${totals.groups_skipped_unreachable_count}</li>
      <li>URL repairs attempted: ${totals.url_repair_attempted_count}</li>
      <li>URL repairs succeeded: ${totals.url_repair_success_count}</li>
      <li>Extra attribution associations: ${totals.extra_attribution_associations_count}</li>
      <li>New postings: ${totals.new_postings_count}</li>
    </ul>
  `;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Weekly Jobs Digest ${escapeHtml(runDate)}</title>
  </head>
  <body>
    <h1>Weekly Jobs Digest - ${escapeHtml(runDate)}</h1>
    ${totalsList}
    <h2>New Postings</h2>
    ${sections.length > 0 ? sections.join('\n') : '<p>No new postings this run.</p>'}
  </body>
</html>`;
}

export function renderWeeklyEmailText(runDate: string, totals: WeeklyTotals, newRows: NewPostingRow[]): string {
  const grouped = groupByOrg(newRows);
  const lines: string[] = [
    `Weekly Jobs Digest - ${runDate}`,
    '',
    `Total orgs in CSV: ${totals.total_orgs_in_csv}`,
    `Eligible orgs: ${totals.eligible_orgs_count}`,
    `Unique jobs URL groups: ${totals.unique_jobs_url_groups_count}`,
    `Groups scraped: ${totals.groups_scraped_count}`,
    `Groups skipped unreachable: ${totals.groups_skipped_unreachable_count}`,
    `URL repairs attempted: ${totals.url_repair_attempted_count}`,
    `URL repairs succeeded: ${totals.url_repair_success_count}`,
    `Extra attribution associations: ${totals.extra_attribution_associations_count}`,
    `New postings: ${totals.new_postings_count}`,
    '',
    'New Postings:',
  ];

  if (grouped.size === 0) {
    lines.push('No new postings this run.');
  } else {
    for (const [orgName, rows] of grouped.entries()) {
      lines.push('', `${orgName} (${rows.length})`);
      for (const row of rows) {
        const dateText = [row.postedDate ? `posted ${row.postedDate}` : '', row.closingDate ? `closing ${row.closingDate}` : '']
          .filter(Boolean)
          .join(', ');
        lines.push(`- ${row.title}${row.location ? ` | ${row.location}` : ''}${dateText ? ` | ${dateText}` : ''}`);
        lines.push(`  ${row.url}`);
      }
    }
  }

  return lines.join('\n');
}

export async function writeWeeklyEmailReport(filePath: string, html: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${html}\n`, 'utf8');
}

export async function sendWeeklyEmail(params: {
  host?: string;
  port?: string;
  user?: string;
  pass?: string;
  from?: string;
  to?: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const { host, port, user, pass, from, to, subject, html, text } = params;
  if (!host || !port || !user || !pass || !from || !to) {
    return { sent: false, reason: 'Missing SMTP environment variables.' };
  }

  const parsedPort = Number(port);
  if (!Number.isFinite(parsedPort)) {
    return { sent: false, reason: `Invalid SMTP port: ${port}` };
  }

  const transporter = nodemailer.createTransport({
    host,
    port: parsedPort,
    secure: parsedPort === 465,
    auth: {
      user,
      pass,
    },
  });

  await transporter.sendMail({
    from,
    to,
    subject,
    html,
    text,
  });

  return { sent: true };
}
