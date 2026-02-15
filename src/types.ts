export type OrgType = 'municipality' | 'first_nation';

export type JobsSourceType =
  | 'ats_workday'
  | 'ats_taleo'
  | 'ats_icims'
  | 'ats_neogov'
  | 'ats_dayforce'
  | 'ats_bamboohr'
  | 'ats_paycom'
  | 'html_list'
  | 'pdf'
  | 'unknown'
  | 'manual_review';

export type Adapter =
  | 'workday'
  | 'taleo'
  | 'icims'
  | 'neogov'
  | 'dayforce'
  | 'bamboohr'
  | 'paycom'
  | 'html_list'
  | 'pdf'
  | 'generic_dom'
  | 'manual';

export type DiscoveredVia = 'path_guess' | 'link_text' | 'sitemap' | 'pdf' | 'manual';

export interface SeedOrg {
  orgName: string;
  orgType: OrgType;
  homepageUrl: string;
  notes?: string;
}

export interface MunicipalitySeed extends SeedOrg {
  sourcePage: string;
}

export interface FirstNationSeed extends SeedOrg {
  inputName: string;
  canonicalName: string;
  profileUrl: string;
}

export interface JobsDiscoveryResult {
  jobsUrl: string;
  discoveredVia: DiscoveredVia;
  notes?: string;
}

export interface ClassificationResult {
  jobsSourceType: JobsSourceType;
  adapter: Adapter;
  confidence: number;
  notes?: string;
}

export interface OrgRecord {
  org_id: string;
  org_name: string;
  org_type: OrgType;
  homepage_url: string;
  jobs_url: string;
  jobs_source_type: JobsSourceType;
  adapter: Adapter;
  confidence: number;
  discovered_via: DiscoveredVia;
  last_verified: string;
  notes: string;
}

export interface FetchResult {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: string;
  contentType: string;
}
