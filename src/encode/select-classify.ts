/**
 * Select-stage fit classification over the full recall pool.
 * SKOS-aligned labels (exact|broad|narrow|related|none), judged afresh —
 * one comparative pass that ranks candidates and supplies residual fit.
 */

import { Catalogue, DEFAULT_HIERARCHY, EXPO_ROOT } from "../catalogue.js";
import { chatJson, defaultModel } from "../llm.js";
import { parseClassifications, pickAllowedCode } from "./answers.js";
import {
  LADDER_LABELS,
  TERM_FIELDS_GIVEN,
  TERM_NOTE_GIVEN,
  classifySystemPrompt,
  itemGiven,
} from "./classify-ladder.js";
import { entailedProperties } from "./entailed-properties.js";
import type {
  AuditEntry,
  BaseTermCandidate,
  CandidateFit,
  DescriptionKind,
} from "./types.js";

/** Shared classify ladder (classify-ladder.ts), asked over the whole recall pool. */
function systemSelectClassify(withCountry: boolean): string {
  return classifySystemPrompt({
    answerKey: "fit",
    withCountry,
  });
}

function candidatePayload(candidate: BaseTermCandidate) {
  return {
    code: candidate.code,
    name: candidate.name,
  };
}

/** Parent and siblings for a term whose name contains "other". Absent otherwise. */
export function otherSiblingFields(
  cat: Catalogue,
  code: string,
  name: string
): { parent: string; siblings: string[] } | undefined {
  if (!/\bother\b/i.test(name) && !/not separately listed/i.test(name)) return undefined;
  const parentCode = cat.parent(code, DEFAULT_HIERARCHY);
  if (parentCode === null) return undefined;
  const parent = parentCode === EXPO_ROOT ? "Food" : cat.term(parentCode)?.name;
  if (parent == null || parent.trim() === "") return undefined;
  const siblings = cat
    .children(parentCode, DEFAULT_HIERARCHY)
    .filter((child) => child !== code && !cat.isDeprecated(child))
    .map((child) => cat.term(child)?.name)
    .filter((sibling): sibling is string => sibling != null && sibling.trim() !== "");
  return { parent, siblings };
}

function classifyCandidatePayload(candidate: BaseTermCandidate) {
  const cat = Catalogue.load();
  const other = otherSiblingFields(cat, candidate.code, candidate.name);
  const note = cat.term(candidate.code)?.scopeNote?.trim();
  const properties = entailedProperties(cat, candidate.code);
  return {
    ...candidatePayload(candidate),
    ...(note ? { note } : {}),
    ...(properties.length > 0 ? { properties } : {}),
    ...(other !== undefined ? other : {}),
  };
}

export interface AssessSelectClassifyResult {
  byCode: Map<string, CandidateFit>;
  audit: AuditEntry[];
}

export async function assessSelectClassify(
  food: string,
  pool: BaseTermCandidate[],
  options: {
    model?: string;
    descriptionKind?: DescriptionKind | null;
    country?: string | null;
    treatments?: readonly string[];
    parts?: readonly string[];
  } = {}
): Promise<AssessSelectClassifyResult> {
  const audit: AuditEntry[] = [];

  if (pool.length === 0) {
    return { byCode: new Map(), audit };
  }

  const descriptionKind = options.descriptionKind ?? null;
  const country = options.country ?? null;
  const treatments = options.treatments ?? [];
  const parts = options.parts ?? [];
  const payload = {
    item: food,
    ...(treatments.length > 0 ? { treatments } : {}),
    ...(parts.length > 0 ? { parts } : {}),
    ...(country !== null ? { country } : {}),
    ...(descriptionKind !== null ? { descriptionKind } : {}),
    terms: pool.map((c) => classifyCandidatePayload(c)),
  };

  const { content, model } = await chatJson({
    model: options.model?.trim() || defaultModel(),
    system: systemSelectClassify(country !== null),
    user: JSON.stringify(payload, null, 2),
  });

  const allowed = new Set(pool.map((c) => c.code));
  const byCode: Map<string, CandidateFit> =
    parseClassifications(content, allowed, "fit", LADDER_LABELS) ?? new Map();

  audit.push({
    step: "select_classify",
    detail: {
      model,
      food,
      ...(descriptionKind !== null ? { descriptionKind } : {}),
      candidateCount: pool.length,
      classifications: pool.map((c) => ({
        code: c.code,
        name: c.name,
        fit: byCode.get(c.code) ?? "none",
      })),
    },
  });

  return { byCode, audit };
}

export function systemProductKind(withCountry: boolean): string {
  return `You are an expert in food classification.

Task: the food belongs to each of these catalogue terms, and none of them contains another. Choose the term for the kind of product the food is primarily eaten as.

Given:
${itemGiven(withCountry)}
- \`terms\`: the catalogue terms to choose from. ${TERM_FIELDS_GIVEN} ${TERM_NOTE_GIVEN}

Use your own knowledge of how the food is eaten.

Reply with JSON only:
{"code":"<code>"}
`;
}

export interface PickProductKindResult {
  code: string | null;
  audit: AuditEntry[];
}

/** Among broad terms that each contain the food and none of which contains another, pick one. */
export async function pickProductKind(
  food: string,
  terms: BaseTermCandidate[],
  options: { model?: string; country?: string | null } = {}
): Promise<PickProductKindResult> {
  const audit: AuditEntry[] = [];
  if (terms.length === 0) {
    return { code: null, audit };
  }
  if (terms.length === 1) {
    return { code: terms[0]!.code, audit };
  }

  const allowed = new Set(terms.map((c) => c.code));
  const cat = Catalogue.load();
  const country = options.country ?? null;
  const payload = {
    item: food,
    ...(country !== null ? { country } : {}),
    terms: terms.map((c) => {
      const note = cat.term(c.code)?.scopeNote?.trim();
      return { ...candidatePayload(c), ...(note ? { note } : {}) };
    }),
  };

  const { content, model } = await chatJson({
    model: options.model?.trim() || defaultModel(),
    system: systemProductKind(country !== null),
    user: JSON.stringify(payload, null, 2),
  });

  const code = pickAllowedCode(content, allowed);

  audit.push({
    step: "select_product_kind",
    detail: {
      model,
      food,
      terms: terms.map((c) => ({ code: c.code, name: c.name })),
      pick: code,
    },
  });

  return { code, audit };
}
