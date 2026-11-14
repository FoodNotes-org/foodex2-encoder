/**
 * Eval helpers for `scripts/reference-eval.ts`: encode a reference-set food
 * and compare the full code, base term and every facet, with the set's code.
 */

import { encodeBaseTerm } from "../encode/base-term.js";
import { formatFreeText } from "../encode/free-text.js";
import { isProviderInfraReason, withUsageScope, type LlmUsage } from "../llm.js";
import type { ReferenceFood } from "./reference-set.js";

export interface ParsedCode {
  base: string;
  /** Facet keys `Fxx.CODE`; a code's facets have no order. */
  facets: Set<string>;
}

export function parseFullCode(code: string): ParsedCode {
  const [base = "", facets = ""] = code.trim().toUpperCase().split("#", 2);
  return { base, facets: new Set(facets === "" ? [] : facets.split("$")) };
}

export interface CodeComparison {
  base: boolean;
  full: boolean;
  /** Expected facets the prediction lacks. */
  missing: string[];
  /** Predicted facets the expected code lacks. */
  extra: string[];
}

export function compareCodes(predicted: string, expected: string): CodeComparison {
  const p = parseFullCode(predicted);
  const e = parseFullCode(expected);
  const missing = [...e.facets].filter((f) => !p.facets.has(f)).sort();
  const extra = [...p.facets].filter((f) => !e.facets.has(f)).sort();
  const base = p.base === e.base;
  return { base, full: base && missing.length === 0 && extra.length === 0, missing, extra };
}

export interface ReferenceCaseResult {
  food: ReferenceFood;
  status: string;
  code: string | null;
  baseName: string | null;
  freeText: string | null;
  /** Against the set's code; null when the encoder gave no code. */
  vsCode: CodeComparison | null;
  /** Against the source's own code, when it published one and the encoder gave a code. */
  vsPublished: CodeComparison | null;
  infra: boolean;
  reason?: string;
  elapsedMs: number;
  usage: LlmUsage;
}

export async function evaluateReferenceFood(food: ReferenceFood): Promise<ReferenceCaseResult> {
  const started = performance.now();
  const { result, usage } = await withUsageScope(() =>
    encodeBaseTerm(food.description, { country: food.country })
  );
  const elapsedMs = Math.round(performance.now() - started);
  const ok = result.status === "ok";
  const code = ok ? (result.code ?? null) : null;
  const reason = !ok && "reason" in result ? result.reason : undefined;
  return {
    food,
    status: result.status,
    code,
    baseName: ok ? (result.baseTerm?.name ?? null) : null,
    freeText: ok ? formatFreeText(result.freeText ?? null) : null,
    vsCode: code === null ? null : compareCodes(code, food.code),
    vsPublished: code === null || food.publishedCode === null ? null : compareCodes(code, food.publishedCode),
    infra: reason !== undefined && isProviderInfraReason(reason),
    ...(reason !== undefined ? { reason } : {}),
    elapsedMs,
    usage,
  };
}
