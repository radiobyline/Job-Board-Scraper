import type { RunLogger } from '../utils/logger.js';
import { HttpClient } from '../utils/http.js';
import { cleanUrl } from '../utils/url.js';
import type { UrlRepairRecord } from '../monitor/types.js';

const TRACKING_PARAM_PATTERN = [/^utm_/i, /^fbclid$/i, /^gclid$/i];

export function normalizeJobsUrlKey(rawUrl: string): string {
  const cleaned = cleanUrl(rawUrl);
  try {
    const parsed = new URL(cleaned);
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAM_PATTERN.some((pattern) => pattern.test(key))) {
        parsed.searchParams.delete(key);
      }
    }
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return cleaned;
  }
}

function withScheme(url: URL, scheme: 'http:' | 'https:'): string {
  const next = new URL(url.toString());
  next.protocol = scheme;
  return normalizeJobsUrlKey(next.toString());
}

function withWwwToggle(url: URL, addWww: boolean): string {
  const next = new URL(url.toString());
  if (addWww && !next.hostname.startsWith('www.')) {
    next.hostname = `www.${next.hostname}`;
  }
  if (!addWww && next.hostname.startsWith('www.')) {
    next.hostname = next.hostname.slice(4);
  }
  return normalizeJobsUrlKey(next.toString());
}

function buildVariants(url: string): string[] {
  const variants: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    const normalized = normalizeJobsUrlKey(candidate);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    variants.push(normalized);
  };

  add(url);
  try {
    const parsed = new URL(url);
    add(withScheme(parsed, parsed.protocol === 'https:' ? 'http:' : 'https:'));

    if (parsed.hostname.startsWith('www.')) {
      add(withWwwToggle(parsed, false));
    } else {
      add(withWwwToggle(parsed, true));
    }

    const toggled = parsed.hostname.startsWith('www.')
      ? new URL(withWwwToggle(parsed, false))
      : new URL(withWwwToggle(parsed, true));
    add(withScheme(toggled, toggled.protocol === 'https:' ? 'http:' : 'https:'));
  } catch {
    // Ignore malformed inputs; as-is variant already added.
  }

  return variants;
}

export interface UrlResolutionResult {
  workingUrl: string;
  statusCode: number;
  repairApplied: boolean;
  notes: string;
}

export async function resolveWorkingJobsUrl(
  originalUrl: string,
  httpClient: HttpClient,
  logger: RunLogger,
): Promise<UrlResolutionResult | null> {
  const normalizedOriginal = normalizeJobsUrlKey(originalUrl);
  const variants = buildVariants(normalizedOriginal);

  for (const variant of variants) {
    const response = await httpClient.requestMaybe(variant, {
      method: 'GET',
      readBody: false,
      maxBytes: 0,
      retries: 2,
      timeoutMs: 15000,
    });

    if (!response) {
      continue;
    }

    if (response.status >= 400) {
      continue;
    }

    const workingUrl = normalizeJobsUrlKey(response.url || variant);
    const repairApplied = workingUrl !== normalizedOriginal;
    const notes = repairApplied ? 'URL variant resolved successfully.' : 'Original URL reachable.';

    if (repairApplied) {
      await logger.warn(`URL repaired: ${normalizedOriginal} -> ${workingUrl}`);
    }

    return {
      workingUrl,
      statusCode: response.status,
      repairApplied,
      notes,
    };
  }

  await logger.warn(`URL unreachable after repair attempts: ${normalizedOriginal}`);
  return null;
}

export function toUrlRepairRecord(
  originalUrl: string,
  result: UrlResolutionResult,
): UrlRepairRecord | null {
  if (!result.repairApplied) {
    return null;
  }

  return {
    original_url: normalizeJobsUrlKey(originalUrl),
    working_url: result.workingUrl,
    status_code: result.statusCode,
    notes: result.notes,
  };
}
