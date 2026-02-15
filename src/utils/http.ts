import { URL } from 'node:url';
import { sleep } from './concurrency.js';
import { cleanUrl } from './url.js';
import type { FetchResult } from '../types.js';

interface RequestOptions {
  method?: 'GET' | 'HEAD';
  timeoutMs?: number;
  maxBytes?: number;
  readBody?: boolean;
  retries?: number;
  headers?: Record<string, string>;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function mergeHeaders(...headersList: Array<Record<string, string> | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const headers of headersList) {
    if (!headers) {
      continue;
    }
    for (const [key, value] of Object.entries(headers)) {
      merged[key] = value;
    }
  }
  return merged;
}

class DomainRateLimiter {
  private readonly intervalMs: number;
  private readonly queueByDomain = new Map<string, Promise<void>>();
  private readonly nextAllowedByDomain = new Map<string, number>();

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  async schedule<T>(domain: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queueByDomain.get(domain) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.queueByDomain.set(
      domain,
      previous.then(async () => {
        await gate;
      }),
    );

    await previous;

    const waitMs = Math.max(0, (this.nextAllowedByDomain.get(domain) ?? 0) - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    this.nextAllowedByDomain.set(domain, Date.now() + this.intervalMs);

    try {
      return await task();
    } finally {
      release();
    }
  }
}

export class HttpClient {
  private readonly limiter = new DomainRateLimiter(1000);
  private readonly defaultTimeoutMs: number;

  constructor(defaultTimeoutMs = 20000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async request(rawUrl: string, options: RequestOptions = {}): Promise<FetchResult> {
    const retries = options.retries ?? 3;
    const cleaned = cleanUrl(rawUrl);

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const result = await this.requestWithRedirects(cleaned, options);
        if (isRetryableStatus(result.status) && attempt < retries) {
          const delayMs = 500 * 2 ** attempt + Math.floor(Math.random() * 200);
          await sleep(delayMs);
          continue;
        }
        return result;
      } catch (error) {
        lastError = error;
        if (attempt >= retries) {
          break;
        }
        const delayMs = 500 * 2 ** attempt + Math.floor(Math.random() * 200);
        await sleep(delayMs);
      }
    }

    throw new Error(`Request failed for ${cleaned}: ${String(lastError)}`);
  }

  async requestMaybe(rawUrl: string, options: RequestOptions = {}): Promise<FetchResult | null> {
    try {
      return await this.request(rawUrl, options);
    } catch {
      return null;
    }
  }

  async resolveCanonicalUrl(rawUrl: string): Promise<string> {
    const cleaned = cleanUrl(rawUrl);
    if (!cleaned) {
      return '';
    }

    let primary = cleaned;
    let fallback = cleaned;
    try {
      const parsed = new URL(cleaned);
      if (parsed.protocol === 'http:') {
        const httpsCandidate = new URL(cleaned);
        httpsCandidate.protocol = 'https:';
        primary = httpsCandidate.toString();
        fallback = cleaned;
      }
    } catch {
      return cleaned;
    }

    const preferred = await this.requestMaybe(primary, {
      method: 'GET',
      readBody: false,
      maxBytes: 0,
      retries: 1,
      timeoutMs: 12000,
    });
    if (preferred && preferred.status < 400) {
      return cleanUrl(preferred.url);
    }

    const secondary = await this.requestMaybe(fallback, {
      method: 'GET',
      readBody: false,
      maxBytes: 0,
      retries: 1,
      timeoutMs: 12000,
    });
    if (secondary) {
      return cleanUrl(secondary.url);
    }

    return cleaned;
  }

  private async requestWithRedirects(rawUrl: string, options: RequestOptions): Promise<FetchResult> {
    const maxRedirects = 8;
    let currentUrl = rawUrl;
    let method: 'GET' | 'HEAD' = options.method ?? 'GET';

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const parsed = new URL(currentUrl);
      const domain = parsed.hostname.toLowerCase();

      const response = await this.limiter.schedule(domain, async () =>
        this.performFetch(currentUrl, method, options),
      );

      const location = response.headers.location;
      if (location && response.status >= 300 && response.status < 400) {
        currentUrl = cleanUrl(new URL(location, currentUrl).toString());
        if (response.status === 303) {
          method = 'GET';
        }
        continue;
      }

      return response;
    }

    throw new Error(`Too many redirects for ${rawUrl}`);
  }

  private async performFetch(
    url: string,
    method: 'GET' | 'HEAD',
    options: RequestOptions,
  ): Promise<FetchResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: mergeHeaders(
          {
            'user-agent':
              'Mozilla/5.0 (compatible; JobBoardDiscoveryBot/1.0; +https://github.com/radiobyline/Job-Board-Scraper)',
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          options.headers,
        ),
      });

      const headers = normalizeHeaders(response.headers);
      const contentType = headers['content-type'] ?? '';

      let body = '';
      if ((options.readBody ?? true) && method !== 'HEAD') {
        const shouldReadAsText =
          contentType.includes('text/') ||
          contentType.includes('json') ||
          contentType.includes('xml') ||
          contentType.includes('javascript') ||
          contentType === '';

        if (shouldReadAsText) {
          const text = await response.text();
          const maxBytes = options.maxBytes ?? 1_000_000;
          body = text.length > maxBytes ? text.slice(0, maxBytes) : text;
        }
      }

      return {
        status: response.status,
        url: response.url || url,
        headers,
        body,
        contentType,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
