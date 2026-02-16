import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';
import type { Posting } from '../monitor/types.js';
import type { Adapter, JobsSourceType } from '../types.js';

export interface PostingAssociationInput {
  posting: Posting;
  orgId: string;
  runId: number;
  jobsSourceType: JobsSourceType;
  adapter: Adapter;
}

export interface PostingDbRow {
  posting_id: string;
  org_id: string;
  title: string;
  url: string;
  location: string | null;
  posted_date: string | null;
  closing_date: string | null;
  snippet: string | null;
  jobs_source_type: JobsSourceType;
  adapter: Adapter;
}

export interface AggregateDbRow {
  posting_id: string;
  first_seen_run_id: number;
  last_seen_run_id: number;
  title: string;
  url: string;
  location: string | null;
  posted_date: string | null;
  closing_date: string | null;
  jobs_source_type: string;
  adapter: string;
  org_ids: string;
}

export class PostingsDatabase {
  private sql!: SqlJsStatic;
  private db!: Database;

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    const wasmPath = join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    this.sql = await initSqlJs({
      locateFile: () => wasmPath,
    });

    let existing: Uint8Array | undefined;
    try {
      const buffer = await readFile(this.filePath);
      existing = new Uint8Array(buffer);
    } catch {
      existing = undefined;
    }

    this.db = existing ? new this.sql.Database(existing) : new this.sql.Database();
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.run(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS runs (
        run_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_type TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        totals_json TEXT
      );

      CREATE TABLE IF NOT EXISTS postings (
        posting_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        location TEXT,
        posted_date TEXT,
        closing_date TEXT,
        snippet TEXT,
        jobs_source_type TEXT NOT NULL,
        adapter TEXT NOT NULL,
        first_seen_run_id INTEGER NOT NULL,
        last_seen_run_id INTEGER NOT NULL,
        PRIMARY KEY (posting_id, org_id)
      );

      CREATE INDEX IF NOT EXISTS idx_postings_last_seen ON postings(last_seen_run_id);
      CREATE INDEX IF NOT EXISTS idx_postings_first_seen ON postings(first_seen_run_id);
    `);
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const bytes = this.db.export();
    await writeFile(this.filePath, Buffer.from(bytes));
  }

  createRun(runType: 'weekly', startedAt: string): number {
    this.db.run(
      `
      INSERT INTO runs (run_type, started_at)
      VALUES (?, ?)
      `,
      [runType, startedAt],
    );

    return this.scalarNumber('SELECT last_insert_rowid() AS id');
  }

  finishRun(runId: number, finishedAt: string, totalsJson: string): void {
    this.db.run(
      `
      UPDATE runs
      SET finished_at = ?, totals_json = ?
      WHERE run_id = ?
      `,
      [finishedAt, totalsJson, runId],
    );
  }

  upsertPostingAssociation(input: PostingAssociationInput): void {
    const { posting, orgId, runId, jobsSourceType, adapter } = input;
    const existing = this.scalarNumberOrNull(
      `
      SELECT first_seen_run_id
      FROM postings
      WHERE posting_id = ? AND org_id = ?
      `,
      [posting.posting_id, orgId],
    );

    if (existing === null) {
      this.db.run(
        `
        INSERT INTO postings (
          posting_id,
          org_id,
          title,
          url,
          location,
          posted_date,
          closing_date,
          snippet,
          jobs_source_type,
          adapter,
          first_seen_run_id,
          last_seen_run_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          posting.posting_id,
          orgId,
          posting.title,
          posting.url,
          posting.location ?? null,
          posting.posted_date ?? null,
          posting.closing_date ?? null,
          posting.snippet ?? null,
          jobsSourceType,
          adapter,
          runId,
          runId,
        ],
      );
      return;
    }

    this.db.run(
      `
      UPDATE postings
      SET
        title = ?,
        url = ?,
        location = ?,
        posted_date = ?,
        closing_date = ?,
        snippet = ?,
        jobs_source_type = ?,
        adapter = ?,
        last_seen_run_id = ?
      WHERE posting_id = ? AND org_id = ?
      `,
      [
        posting.title,
        posting.url,
        posting.location ?? null,
        posting.posted_date ?? null,
        posting.closing_date ?? null,
        posting.snippet ?? null,
        jobsSourceType,
        adapter,
        runId,
        posting.posting_id,
        orgId,
      ],
    );
  }

  getNewPostingsByAssociation(runId: number): PostingDbRow[] {
    return this.queryRows<PostingDbRow>(
      `
      SELECT
        posting_id,
        org_id,
        title,
        url,
        location,
        posted_date,
        closing_date,
        snippet,
        jobs_source_type,
        adapter
      FROM postings
      WHERE first_seen_run_id = ?
      ORDER BY org_id, title
      `,
      [runId],
    );
  }

  getPostingAggregatesSeenInRun(runId: number): AggregateDbRow[] {
    return this.queryRows<AggregateDbRow>(
      `
      SELECT
        posting_id,
        MIN(first_seen_run_id) AS first_seen_run_id,
        MAX(last_seen_run_id) AS last_seen_run_id,
        MAX(title) AS title,
        MAX(url) AS url,
        MAX(location) AS location,
        MAX(posted_date) AS posted_date,
        MAX(closing_date) AS closing_date,
        MAX(jobs_source_type) AS jobs_source_type,
        MAX(adapter) AS adapter,
        GROUP_CONCAT(DISTINCT org_id) AS org_ids
      FROM postings
      WHERE last_seen_run_id = ?
      GROUP BY posting_id
      ORDER BY posting_id
      `,
      [runId],
    );
  }

  getRunStartedAt(runId: number): string | null {
    return this.scalarStringOrNull('SELECT started_at FROM runs WHERE run_id = ?', [runId]);
  }

  getRunFinishedAt(runId: number): string | null {
    return this.scalarStringOrNull('SELECT finished_at FROM runs WHERE run_id = ?', [runId]);
  }

  private queryRows<T>(sql: string, params: (string | number | null)[] = []): T[] {
    const stmt = this.db.prepare(sql, params);
    const rows: T[] = [];
    try {
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  private scalarNumber(sql: string, params: (string | number | null)[] = []): number {
    const value = this.scalarNumberOrNull(sql, params);
    if (value === null) {
      throw new Error(`Expected numeric scalar for query: ${sql}`);
    }
    return value;
  }

  private scalarNumberOrNull(sql: string, params: (string | number | null)[] = []): number | null {
    const stmt = this.db.prepare(sql, params);
    try {
      if (!stmt.step()) {
        return null;
      }
      const row = stmt.getAsObject() as Record<string, unknown>;
      const first = Object.values(row)[0];
      if (typeof first === 'number') {
        return first;
      }
      if (typeof first === 'bigint') {
        return Number(first);
      }
      if (typeof first === 'string' && first.trim() !== '') {
        const parsed = Number(first);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  private scalarStringOrNull(sql: string, params: (string | number | null)[] = []): string | null {
    const stmt = this.db.prepare(sql, params);
    try {
      if (!stmt.step()) {
        return null;
      }
      const row = stmt.getAsObject() as Record<string, unknown>;
      const first = Object.values(row)[0];
      if (typeof first === 'string') {
        return first;
      }
      if (first === null || first === undefined) {
        return null;
      }
      return String(first);
    } finally {
      stmt.free();
    }
  }
}
