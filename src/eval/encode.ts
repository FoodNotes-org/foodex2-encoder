/**
 * Eval helpers for `scripts/encode-eval.ts` — end-to-end encode.
 */

import { Catalogue } from "../catalogue.js";
import { encodeBaseTerm } from "../encode/base-term.js";
import { formatFreeText } from "../encode/free-text.js";
import { isProviderInfraReason } from "../llm.js";

const INGRED_HIERARCHY = "ingred";

export interface EncodeEvalCase {
  id: string;
  input: string;
  expected: string;
  method?: "lexical" | "traversal";
  forbid_pick?: string[];
  /** Facet keys Fxx.CODE that must not appear. */
  forbid_facets?: string[];
  /** Facet keys Fxx.CODE that must all appear. */
  require_facets?: string[];
  /** At least one added F04 must be under each of these F04.CODE ancestors. */
  require_f04_under?: string[];
  /** Substring that freeText must contain (case-insensitive). */
  free_text_includes?: string;
  tags?: string[];
  note?: string;
}

export interface EncodeCaseResult {
  id: string;
  input: string;
  expected: string;
  pick: string | null;
  pickName: string | null;
  method: string | null;
  status: string;
  methodPass: boolean;
  pickPass: boolean;
  forbidHit: boolean;
  facetsPass: boolean;
  freeTextPass: boolean;
  pass: boolean;
  /** Provider credits / rate limit / unavailable — not a quality miss. */
  infra: boolean;
  /** Wall-clock time for encodeBaseTerm + scoring, in milliseconds. */
  elapsedMs: number;
  facets: string[];
  freeText: string | null;
  code: string | null;
  tags: string[];
  note?: string;
  reason?: string;
  facetDetail?: string;
}

function facetKey(header: string, code: string): string {
  return `${header}.${code}`.toUpperCase();
}

export async function evaluateEncodeCase(c: EncodeEvalCase): Promise<EncodeCaseResult> {
  const started = performance.now();
  const result = await encodeBaseTerm(c.input);
  const elapsedMs = Math.round(performance.now() - started);
  const pick = result.status === "ok" ? (result.baseTerm?.code ?? null) : null;
  const pickName = result.status === "ok" ? (result.baseTerm?.name ?? null) : null;
  const method = result.status === "ok" ? (result.method ?? null) : null;
  const facets =
    result.status === "ok"
      ? (result.facets ?? []).map((f) => facetKey(f.header, f.code))
      : [];
  const freeText =
    result.status === "ok" ? formatFreeText(result.freeText ?? null) : null;
  const code = result.status === "ok" ? (result.code ?? null) : null;
  const reason =
    result.status !== "ok" && "reason" in result ? result.reason : undefined;
  const infra = reason !== undefined && isProviderInfraReason(reason);

  const forbid = new Set((c.forbid_pick ?? []).map((x) => x.toUpperCase()));
  const forbidHit = pick !== null && forbid.has(pick);

  const methodPass = c.method === undefined || method === c.method;
  const pickPass = pick === c.expected && !forbidHit;

  let facetsPass = true;
  let facetDetail: string | undefined;

  if (result.status === "ok") {
    const forbidFacets = new Set((c.forbid_facets ?? []).map((x) => x.toUpperCase()));
    const forbiddenHit = facets.find((f) => forbidFacets.has(f));
    if (forbiddenHit !== undefined) {
      facetsPass = false;
      facetDetail = `forbid_facets hit ${forbiddenHit}`;
    }

    if (facetsPass && c.require_facets && c.require_facets.length > 0) {
      const have = new Set(facets);
      const missing = c.require_facets
        .map((x) => x.toUpperCase())
        .filter((f) => !have.has(f));
      if (missing.length > 0) {
        facetsPass = false;
        facetDetail = `require_facets missing ${missing.join(", ")} (got ${facets.join(", ") || "none"})`;
      }
    }

    if (facetsPass && c.require_f04_under && c.require_f04_under.length > 0) {
      const cat = Catalogue.load();
      for (const underRaw of c.require_f04_under) {
        const under = underRaw.toUpperCase();
        const impliedCode = under.startsWith("F04.") ? under.slice(4) : under;
        const ok = facets.some((key) => {
          if (!key.startsWith("F04.")) return false;
          const code = key.slice(4);
          return cat.isAncestor(impliedCode, code, INGRED_HIERARCHY);
        });
        if (!ok) {
          facetsPass = false;
          facetDetail = `require_f04_under ${under} not satisfied (facets: ${facets.join(", ") || "none"})`;
          break;
        }
      }
    }
  }

  let freeTextPass = true;
  if (c.free_text_includes) {
    const needle = c.free_text_includes.toLowerCase();
    freeTextPass = (freeText ?? "").toLowerCase().includes(needle);
  }

  return {
    id: c.id,
    input: c.input,
    expected: c.expected,
    pick,
    pickName,
    method,
    status: result.status,
    methodPass,
    pickPass,
    forbidHit,
    facetsPass,
    freeTextPass,
    // Infra rejects are not quality fails for pass scoring.
    pass:
      !infra &&
      result.status === "ok" &&
      pickPass &&
      methodPass &&
      facetsPass &&
      freeTextPass,
    infra,
    elapsedMs,
    facets,
    freeText,
    code,
    tags: c.tags ?? [],
    note: c.note,
    reason,
    facetDetail,
  };
}
