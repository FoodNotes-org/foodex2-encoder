/**
 * Fat % (F07) and alcohol % v/v (F11): model reports the number; code snaps to
 * the nearest catalogue bucket. No facet-tree walk; no leaf names in the prompt.
 */

import { Catalogue } from "../catalogue.js";
import type { FacetDescriptorRef } from "./types.js";

export const F07 = "F07";
export const F11 = "F11";

export type NumericContentClaim = {
  fatPercent: number | null;
  alcoholPercent: number | null;
};

export type NumericBucket = {
  code: string;
  name: string;
  /** Parsed magnitude from the leaf name (for `< 0.1`, the threshold 0.1). */
  value: number;
  /** True for leaves like `< 0.1 % fat`. */
  lessThan: boolean;
};

/** Parse a catalogue leaf name into a numeric bucket, or null if not a %-leaf. */
export function parseNumericLeafName(name: string): Omit<NumericBucket, "code" | "name"> | null {
  const t = name.trim();
  const less = t.match(/^<\s*([0-9]+(?:\.[0-9]+)?)\s*%/i);
  if (less) {
    const value = Number(less[1]);
    if (!Number.isFinite(value)) return null;
    return { value, lessThan: true };
  }
  const eq = t.match(/^([0-9]+(?:\.[0-9]+)?)\s*%/i);
  if (eq) {
    const value = Number(eq[1]);
    if (!Number.isFinite(value)) return null;
    return { value, lessThan: false };
  }
  return null;
}

function leafBuckets(cat: Catalogue, header: string): NumericBucket[] {
  const hierarchy = cat.facetCategory(header)?.hierarchyCode;
  if (hierarchy === undefined) return [];
  const out: NumericBucket[] = [];
  const walk = (parent: string): void => {
    for (const code of cat.children(parent, hierarchy)) {
      if (cat.isDeprecated(code)) continue;
      const children = cat.children(code, hierarchy).filter((c) => !cat.isDeprecated(c));
      if (children.length === 0) {
        const name = cat.term(code)?.name ?? code;
        const parsed = parseNumericLeafName(name);
        if (parsed !== null) out.push({ code, name, ...parsed });
      } else {
        walk(code);
      }
    }
  };
  walk("root");
  return out;
}

let cachedF07: NumericBucket[] | null = null;
let cachedF11: NumericBucket[] | null = null;

export function fatContentBuckets(cat: Catalogue): NumericBucket[] {
  if (cachedF07 === null) cachedF07 = leafBuckets(cat, F07);
  return cachedF07;
}

export function alcoholContentBuckets(cat: Catalogue): NumericBucket[] {
  if (cachedF11 === null) cachedF11 = leafBuckets(cat, F11);
  return cachedF11;
}

/** Clear bucket caches (tests that swap catalogue fixtures). */
export function clearNumericBucketCache(): void {
  cachedF07 = null;
  cachedF11 = null;
}

/**
 * Nearest catalogue leaf for a stated percentage.
 * Values strictly below a `< x` threshold use that leaf; otherwise nearest
 * ordinary leaf by absolute distance (ties → lower bucket value).
 */
export function nearestNumericBucket(
  buckets: readonly NumericBucket[],
  value: number
): NumericBucket | null {
  if (!Number.isFinite(value) || buckets.length === 0) return null;

  const lessThan = buckets.filter((b) => b.lessThan);
  for (const b of lessThan) {
    if (value < b.value) return b;
  }

  const ordinary = buckets.filter((b) => !b.lessThan);
  if (ordinary.length === 0) return lessThan[0] ?? null;

  let best = ordinary[0]!;
  let bestDist = Math.abs(value - best.value);
  for (const b of ordinary.slice(1)) {
    const dist = Math.abs(value - b.value);
    if (dist < bestDist || (dist === bestDist && b.value < best.value)) {
      best = b;
      bestDist = dist;
    }
  }
  return best;
}

export function nearestFatFacet(
  cat: Catalogue,
  value: number
): FacetDescriptorRef | null {
  const bucket = nearestNumericBucket(fatContentBuckets(cat), value);
  if (bucket === null) return null;
  return { header: F07, code: bucket.code, name: bucket.name };
}

export function nearestAlcoholFacet(
  cat: Catalogue,
  value: number
): FacetDescriptorRef | null {
  const bucket = nearestNumericBucket(alcoholContentBuckets(cat), value);
  if (bucket === null) return null;
  return { header: F11, code: bucket.code, name: bucket.name };
}

function asRecord(content: unknown): Record<string, unknown> | null {
  return content !== null && typeof content === "object"
    ? (content as Record<string, unknown>)
    : null;
}

/** Coerce a JSON number (or numeric string); null/absent/invalid → null. */
export function parsePercentField(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const t = raw.trim().replace(",", ".");
    if (t === "" || t.toLowerCase() === "null") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Parse the numeric-content model reply. */
export function parseNumericContent(content: unknown): NumericContentClaim {
  const body = asRecord(content);
  if (body === null) return { fatPercent: null, alcoholPercent: null };
  return {
    fatPercent: parsePercentField(body.fatPercent),
    alcoholPercent: parsePercentField(body.alcoholPercent),
  };
}

export function numericContentActive(claim: NumericContentClaim): boolean {
  return claim.fatPercent !== null || claim.alcoholPercent !== null;
}

/**
 * True when a leftover phrase restates a fat/alcohol % already placed.
 * Soft claims without a stated amount ("low fat") are not dropped.
 */
export function phraseCoveredByNumeric(
  phrase: string,
  claim: NumericContentClaim
): boolean {
  if (!numericContentActive(claim)) return false;
  const p = phrase.trim().toLowerCase();
  if (p === "") return false;
  const hasAmount = /\d/.test(p) && (/%/.test(p) || /\babv\b/.test(p));
  if (!hasAmount) return false;
  if (claim.fatPercent !== null && /\bfat\b/.test(p)) return true;
  if (
    claim.alcoholPercent !== null &&
    /\b(alcohol|abv|volume)\b/.test(p)
  ) {
    return true;
  }
  return false;
}

export function dropNumericRestatements<T extends { phrase: string }>(
  properties: T[],
  claim: NumericContentClaim
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const property of properties) {
    if (phraseCoveredByNumeric(property.phrase, claim)) dropped.push(property);
    else kept.push(property);
  }
  return { kept, dropped };
}

/** Shape for `covered` so later residual prompts omit these claims. */
export function numericContentCovered(
  claim: NumericContentClaim
): Record<string, unknown> | null {
  if (!numericContentActive(claim)) return null;
  const out: Record<string, unknown> = {};
  if (claim.fatPercent !== null) out.fatPercent = claim.fatPercent;
  if (claim.alcoholPercent !== null) out.alcoholPercent = claim.alcoholPercent;
  return out;
}
