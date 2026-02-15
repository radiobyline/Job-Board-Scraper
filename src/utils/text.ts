export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function stripStatusSuffix(value: string): string {
  return normalizeWhitespace(value.replace(/\(\s*status\s*:[^)]+\)/gi, '').replace(/\(formerly[^)]+\)/gi, ''));
}

export function slugify(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function normalizeForMatch(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/\b(first nation|first nations|indian band|nation|band)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(value: string): Set<string> {
  const cleaned = ` ${normalizeForMatch(value)} `;
  const grams = new Set<string>();
  for (let i = 0; i < cleaned.length - 1; i += 1) {
    grams.add(cleaned.slice(i, i + 2));
  }
  return grams;
}

export function diceSimilarity(a: string, b: string): number {
  const aNorm = normalizeForMatch(a);
  const bNorm = normalizeForMatch(b);
  if (!aNorm || !bNorm) {
    return 0;
  }
  if (aNorm === bNorm) {
    return 1;
  }

  const aBigrams = bigrams(aNorm);
  const bBigrams = bigrams(bNorm);

  let overlap = 0;
  for (const gram of aBigrams) {
    if (bBigrams.has(gram)) {
      overlap += 1;
    }
  }

  return (2 * overlap) / (aBigrams.size + bBigrams.size);
}

export function looksLikePdf(url: string): boolean {
  return /\.pdf($|[?#])/i.test(url);
}
