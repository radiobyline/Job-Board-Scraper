# Job Board Scraper - Phase 1

Phase 1 implements only:
- jobs URL discovery for Ontario municipalities and Ontario First Nations
- ATS/source classification
- CSV + log outputs

Out of scope in this phase:
- scraping postings
- weekly new-posting detection
- email delivery
- monitoring bot

## Stack

- Node.js + TypeScript
- Playwright (JS-heavy pages + First Nation Profiles search)
- Fetch + Cheerio (HTML parsing)

## Inputs

- `data/first_nations_input.txt` (plain list, one name per line)

Seed sources used by the pipeline:
- AMO Ontario municipalities list
- First Nation Profiles search (`fnp-ppn.aadnc-aandc.gc.ca`)

## Run Discovery

Install dependencies:

```bash
npm ci
npx playwright install
```

Run Phase 1 discovery:

```bash
npm run discovery -- --first-nations-file data/first_nations_input.txt
```

Reuse already-generated municipality rows and process only First Nations:

```bash
npm run discovery -- --first-nations-file data/first_nations_input.txt --skip-municipalities
```

## Outputs

Generated files:
- `data/municipalities_seed.json`
- `data/first_nations_seed.json`
- `data/orgs.csv`
- `data/manual_review.csv`
- `logs/discovery_run_YYYY-MM-DD.log`

CSV schema (`data/orgs.csv` and `data/manual_review.csv`):

```text
org_id,org_name,org_type,homepage_url,jobs_url,jobs_source_type,adapter,confidence,discovered_via,last_verified,notes
```

`data/manual_review.csv` is a strict subset of `data/orgs.csv` and includes rows where:
- `confidence < 0.5`, or
- `jobs_source_type == unknown`, or
- `jobs_source_type == manual_review`

## NPM Scripts

- `npm run build` - TypeScript compile check
- `npm run discovery -- --first-nations-file <path>` - full Phase 1 run

## GitHub Actions

Workflow file: `.github/workflows/discovery.yml`

Features:
- manual trigger via `workflow_dispatch`
- optional monthly schedule
- installs dependencies + Playwright
- runs discovery
- uploads CSV/log artifacts
- commits updated `data/` and `logs/` outputs back to repo

## Reliability Rules Implemented

- max `1 request/second` per domain (rate-limited HTTP client)
- exponential backoff retries for transient failures
- per-organization fault isolation: one org failure logs and continues
