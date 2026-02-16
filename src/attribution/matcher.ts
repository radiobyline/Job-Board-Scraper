import type { OrgRecord } from '../types.js';

interface FirstNationAlias {
  orgId: string;
  alias: string;
  isPrimary: boolean;
}

function normalizeValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripCommonTokens(value: string): string {
  return normalizeValue(value)
    .replace(/\b(first|nation|nations|council|band|independent|reserve|community)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class FirstNationMatcher {
  private readonly aliases: FirstNationAlias[];

  constructor(orgs: OrgRecord[]) {
    const items: FirstNationAlias[] = [];
    for (const org of orgs) {
      if (org.org_type !== 'first_nation') {
        continue;
      }

      const primary = normalizeValue(org.org_name);
      const stripped = stripCommonTokens(org.org_name);
      if (primary.length >= 4) {
        items.push({ orgId: org.org_id, alias: primary, isPrimary: true });
      }
      if (stripped.length >= 4 && stripped !== primary) {
        items.push({ orgId: org.org_id, alias: stripped, isPrimary: false });
      }
    }

    this.aliases = items.sort((a, b) => b.alias.length - a.alias.length);
  }

  match(text: string): string[] {
    const normalizedText = ` ${normalizeValue(text)} `;
    if (!normalizedText.trim()) {
      return [];
    }

    const matches = new Map<string, number>();
    for (const alias of this.aliases) {
      if (alias.alias.length < 4) {
        continue;
      }
      const needle = ` ${alias.alias} `;
      if (!normalizedText.includes(needle)) {
        continue;
      }
      const score = alias.isPrimary ? 2 : 1;
      matches.set(alias.orgId, Math.max(matches.get(alias.orgId) ?? 0, score));
    }

    return [...matches.entries()]
      .filter(([, score]) => score >= 1)
      .map(([orgId]) => orgId);
  }
}
