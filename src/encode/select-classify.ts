/**
 * Select-stage fit classification over the full recall pool.
 * SKOS-aligned labels (exact|broad|narrow|related|none), judged afresh —
 * one comparative pass that ranks candidates and supplies residual fit.
 */

import { Catalogue } from "../catalogue.js";
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
function systemSelectClassify(descriptionKind: DescriptionKind | null): string {
  const noun = descriptionKindNoun(descriptionKind);
  return classifySystemPrompt({
    framing: `You are matching one ${noun} against terms in a food catalogue. The item text is that ${noun}.`,
    answerKey: "fit",
  });
}

function candidatePayload(cat: Catalogue, candidate: BaseTermCandidate) {
  const term = cat.term(candidate.code);
  return {
    code: candidate.code,
    name: candidate.name,
    ...(term?.scopeNote ? { scopeNote: term.scopeNote } : {}),
  };
}

function classifyCandidatePayload(
  cat: Catalogue,
  food: string,
  candidate: BaseTermCandidate
) {
  return {
    ...candidatePayload(cat, candidate),
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
  options: { model?: string; descriptionKind?: DescriptionKind | null } = {}
): Promise<AssessSelectClassifyResult> {
  const audit: AuditEntry[] = [];

  if (pool.length === 0) {
    return { byCode: new Map(), audit };
  }

  const cat = Catalogue.load();
  const descriptionKind = options.descriptionKind ?? null;
  const payload = {
    item: food,
    ...(descriptionKind !== null ? { descriptionKind } : {}),
    terms: pool.map((c) => classifyCandidatePayload(cat, food, c)),
  };

  const { content, model } = await chatJson({
    model: options.model?.trim() || defaultModel(),
    system: systemSelectClassify(descriptionKind),
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

const SYSTEM_SELECT_PARENT = `As a food and nutrition ontology expert, you are choosing among catalogue base terms as possible shelves for the food.

Pick the most specific candidate that the food is a kind of, in the strict sense. A candidate that names only one part of a mixture is not a kind of the whole. If no candidate is a kind-of cover, reply with null.

Reply with JSON only:
{"code":"<code>|null"}
`;

export interface PickClosestParentResult {
  code: string | null;
  audit: AuditEntry[];
}

/** Among shelf candidates (broad, and related under those broads), pick the tightest. */
export async function pickClosestParent(
  food: string,
  parents: BaseTermCandidate[],
  options: { model?: string } = {}
): Promise<PickClosestParentResult> {
  const audit: AuditEntry[] = [];
  if (parents.length === 0) {
    return { code: null, audit };
  }
  if (parents.length === 1) {
    return { code: parents[0]!.code, audit };
  }

  const cat = Catalogue.load();
  const allowed = new Set(parents.map((c) => c.code));
  const payload = {
    food,
    candidates: parents.map((c) => candidatePayload(cat, c)),
  };

  const { content, model } = await chatJson({
    model: options.model?.trim() || defaultModel(),
    system: SYSTEM_SELECT_PARENT,
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
