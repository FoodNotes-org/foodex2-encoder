/**
 * Select-stage fit classification over the full recall pool.
 * SKOS-aligned labels (exact|broad|narrow|related|none), judged afresh —
 * one comparative pass that ranks candidates and supplies residual fit.
 */

import { Catalogue, DEFAULT_HIERARCHY, EXPO_ROOT } from "../catalogue.js";
import { countryContextLine } from "../country.js";
import { chatJson, defaultModel } from "../llm.js";
import { parseClassifications, pickAllowedCode } from "./answers.js";
import {
  LADDER_LABELS,
  classifyQuestions,
  classifySystemPrompt,
  descriptionKindNoun,
  quote,
} from "./classify-ladder.js";
import type {
  AuditEntry,
  BaseTermCandidate,
  CandidateFit,
  DescriptionKind,
} from "./types.js";

/** Shared classify ladder (classify-ladder.ts), asked over the whole recall pool. */
function systemSelectClassify(descriptionKind: DescriptionKind | null, withCountry: boolean): string {
  const noun = descriptionKindNoun(descriptionKind);
  return classifySystemPrompt({
    framing: `You are matching one ${noun} against terms in a food catalogue. The item text is that ${noun}.`,
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
  if (!/\bother\b/i.test(name)) return undefined;
  const parentCode = cat.parent(code, DEFAULT_HIERARCHY);
  if (parentCode === null) return undefined;
  const parent = parentCode === EXPO_ROOT ? "Food" : cat.term(parentCode)?.name;
  if (parent === undefined || parent.trim() === "") return undefined;
  const siblings = cat
    .children(parentCode, DEFAULT_HIERARCHY)
    .filter((child) => child !== code && !cat.isDeprecated(child))
    .map((child) => cat.term(child)?.name)
    .filter((sibling): sibling is string => sibling !== undefined && sibling.trim() !== "");
  return { parent, siblings };
}

function classifyCandidatePayload(food: string, candidate: BaseTermCandidate) {
  const other = otherSiblingFields(Catalogue.load(), candidate.code, candidate.name);
  return {
    ...candidatePayload(candidate),
    ...(other !== undefined ? other : {}),
    questions: classifyQuestions(quote(food), quote(candidate.name), null),
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
  } = {}
): Promise<AssessSelectClassifyResult> {
  const audit: AuditEntry[] = [];

  if (pool.length === 0) {
    return { byCode: new Map(), audit };
  }

  const descriptionKind = options.descriptionKind ?? null;
  const country = options.country ?? null;
  const payload = {
    item: food,
    ...(country !== null ? { country } : {}),
    ...(descriptionKind !== null ? { descriptionKind } : {}),
    terms: pool.map((c) => classifyCandidatePayload(food, c)),
  };

  const { content, model } = await chatJson({
    model: options.model?.trim() || defaultModel(),
    system: systemSelectClassify(descriptionKind, country !== null),
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

function systemSelectParent(withCountry: boolean): string {
  return `You are an expert in food classification.

Your task is to choose among catalogue terms as possible shelves for the food.
First, find the \`candidates\`, if any, that subsumes \`food\`.

Given:
- \`food\`: the food as described.
- \`candidates\`: catalogue terms, each with a \`code\`, a \`name\` and, for some, a \`note\` on what the term means and how to use it.
${withCountry ? `\n${countryContextLine("food")}\n` : ""}
Reply with JSON only, with the code of that term, or null if \`food\` belongs to none of them:
{"code":"<code>"|null}
`;
}

export interface PickClosestParentResult {
  code: string | null;
  audit: AuditEntry[];
}

/** Among the broad shelf candidates passed in, pick one. */
export async function pickClosestParent(
  food: string,
  parents: BaseTermCandidate[],
  options: { model?: string; country?: string | null } = {}
): Promise<PickClosestParentResult> {
  const audit: AuditEntry[] = [];
  if (parents.length === 0) {
    return { code: null, audit };
  }
  if (parents.length === 1) {
    return { code: parents[0]!.code, audit };
  }

  const allowed = new Set(parents.map((c) => c.code));
  const cat = Catalogue.load();
  const country = options.country ?? null;
  const payload = {
    food,
    ...(country !== null ? { country } : {}),
    candidates: parents.map((c) => {
      const note = cat.term(c.code)?.scopeNote?.trim();
      return { ...candidatePayload(c), ...(note ? { note } : {}) };
    }),
  };

  const { content, model } = await chatJson({
    model: options.model?.trim() || defaultModel(),
    system: systemSelectParent(country !== null),
    user: JSON.stringify(payload, null, 2),
  });

  const code = pickAllowedCode(content, allowed);

  audit.push({
    step: "select_parent_pick",
    detail: {
      model,
      food,
      candidates: parents.map((c) => ({ code: c.code, name: c.name })),
      pick: code,
    },
  });

  return { code, audit };
}
