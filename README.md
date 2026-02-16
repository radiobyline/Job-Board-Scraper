# Job Board Scraper

This repo now contains:
- Phase 1: jobs URL discovery + ATS/source classification
- Phase 2: weekly postings monitor + new-posting digest email + Google Sheets tracker sync

## Stack

- Node.js + TypeScript
- Playwright for JS-heavy pages
- Fetch + Cheerio for simple pages
- SQLite (`sql.js`) for postings history
- Google Sheets API (`googleapis`)
- SMTP delivery (`nodemailer`) via Brevo relay

## Phase 1 (Discovery)

Phase 1 reads seed sources and writes:
- `data/municipalities_seed.json`
- `data/first_nations_seed.json`
- `data/orgs.csv`
- `data/manual_review.csv`
- `logs/discovery_run_YYYY-MM-DD.log`

Run:

```bash
npm ci
npx playwright install
npm run discovery -- --first-nations-file data/first_nations_input.txt
```

Workflow: `.github/workflows/discovery.yml`

## Phase 2 (Weekly Monitoring)

Phase 2 does not rediscover URLs. It uses `data/orgs.csv` as the source of truth.

### Weekly pipeline behavior

1. Load `data/orgs.csv`.
2. Skip orgs with low confidence/manual settings (`confidence < 0.5`, `jobs_source_type=manual_review`, `adapter=manual`, empty `jobs_url`).
3. Group orgs by normalized `jobs_url` and scrape each unique URL once.
4. Fan out scraped postings to all orgs in that shared URL group.
5. Attribute postings to additional First Nations when names appear in posting text.
6. Save/update postings state in SQLite.
7. Build weekly digest HTML for postings first seen this run.
8. Send digest via Brevo SMTP (if SMTP secrets are present).
9. Sync postings to Google Sheets `Postings` tab (create tab/header if missing; upsert by `posting_id`; preserve `status/applied_date/notes`).
10. Write logs and reports.

### URL repair behavior

Before scraping a jobs URL group, the monitor tries recoverable variants:
- as-is
- scheme switch (`http`/`https`)
- add/remove `www`
- scheme + `www` combination

Successful repairs are written to:
- `reports/url_repairs_YYYY-MM-DD.csv`

Phase 2 does not auto-edit `data/orgs.csv` with repaired URLs.

### Shared-board behavior

If multiple orgs have the same `jobs_url`, the URL is scraped once and postings are associated to all orgs in that group.

### First Nation attribution behavior

Postings can be associated to both:
- the council/board org that owns the shared jobs URL
- specific First Nation orgs matched from posting text (title/snippet/detail extract when available)

## Phase 2 outputs

- `data/postings.sqlite`
- `reports/weekly_email_YYYY-MM-DD.html`
- `reports/url_repairs_YYYY-MM-DD.csv`
- `logs/weekly_run_YYYY-MM-DD.log`

## Run Phase 2 locally

```bash
npm ci
npx playwright install
npm run weekly
```

Optional smoke run (limit groups):

```bash
npm run weekly -- --max-groups 5
```

## Brevo SMTP setup

1. In Brevo, create/get your SMTP credentials:
1. Use SMTP relay host `smtp-relay.brevo.com`.
1. Use Standard SMTP key (64-character key) as password.
1. Verify sender identity for `viktor.elias@outlook.com` in Brevo sender settings.
1. Use `viktor.elias@outlook.com` as both sender and recipient for this monitor.

GitHub Actions secrets required:
- `SMTP_HOST` (`smtp-relay.brevo.com`)
- `SMTP_PORT` (`587` for STARTTLS, optional `465` for TLS)
- `SMTP_USER` (Brevo SMTP login)
- `SMTP_PASS` (Brevo Standard SMTP key)
- `EMAIL_FROM` (`viktor.elias@outlook.com`)
- `EMAIL_TO` (`viktor.elias@outlook.com`)

If SMTP secrets are missing, the run continues and logs that email was not sent.

## Google Sheets setup

Create a Google Cloud service account with Sheets API access and share the target spreadsheet with that service account email.

GitHub Actions secrets required:
- `GOOGLE_SERVICE_ACCOUNT_JSON` (full JSON key, single secret value)
- `GOOGLE_SHEET_ID` (sheet ID from spreadsheet URL)

The sync ensures tab `Postings` exists and enforces header `A1:O1`:

```text
posting_id,first_seen,last_seen,org_name,org_type,title,location,posted_date,closing_date,url,jobs_source_type,adapter,status,applied_date,notes
```

Upsert behavior:
- key: `posting_id`
- existing row: update columns `A:L` and `last_seen`
- never overwrite user-managed `M:O` (`status`, `applied_date`, `notes`)
- new row: append with blank `M:O`

## NPM scripts

- `npm run build` (TypeScript compile check)
- `npm run discovery -- --first-nations-file <path>`
- `npm run weekly`

## GitHub Actions

- `.github/workflows/discovery.yml` (Phase 1)
- `.github/workflows/weekly.yml` (Phase 2)

Weekly workflow features:
- `workflow_dispatch` + weekly schedule
- `permissions: contents: write`
- runs `npm run weekly`
- uploads reports/logs artifacts
- commits `data/postings.sqlite`, `reports/`, and `logs/` directly to default branch
