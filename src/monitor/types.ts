import type { Adapter, JobsSourceType, OrgRecord, OrgType } from '../types.js';

export interface Posting {
  posting_id: string;
  title: string;
  url: string;
  location?: string;
  posted_date?: string;
  closing_date?: string;
  snippet?: string;
  attribution_text?: string;
}

export interface EligibleOrg extends OrgRecord {
  jobs_url_key: string;
}

export interface JobsUrlGroup {
  key: string;
  originalUrl: string;
  orgs: EligibleOrg[];
}

export interface UrlRepairRecord {
  original_url: string;
  working_url: string;
  status_code: number;
  notes: string;
}

export interface GroupAdapterChoice {
  adapter: Adapter;
  jobsSourceType: JobsSourceType;
}

export interface WeeklyTotals {
  total_orgs_in_csv: number;
  eligible_orgs_count: number;
  unique_jobs_url_groups_count: number;
  jobs_url_group_max_size: number;
  groups_scraped_count: number;
  groups_skipped_unreachable_count: number;
  orgs_skipped_low_confidence_count: number;
  url_repair_attempted_count: number;
  url_repair_success_count: number;
  extra_attribution_associations_count: number;
  new_postings_count: number;
}

export interface NewPostingRow {
  postingId: string;
  orgId: string;
  title: string;
  url: string;
  location?: string;
  postedDate?: string;
  closingDate?: string;
  snippet?: string;
  orgName: string;
  orgType: OrgType;
  jobsSourceType: JobsSourceType;
  adapter: Adapter;
}

export interface SheetPostingRow {
  postingId: string;
  firstSeen: string;
  lastSeen: string;
  orgName: string;
  orgType: string;
  title: string;
  location: string;
  postedDate: string;
  closingDate: string;
  url: string;
  jobsSourceType: string;
  adapter: string;
}
