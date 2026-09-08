/**
 * Base-term encoding, then residuals (essence when dish/dish_type, then input vs base).
 *
 *   search → identical wording? → residuals
 *   else → expo traversal (embeddings tip walk seeds) → selection → residuals
 */

import { Catalogue } from "../catalogue.js";
import { searchTerms } from "../search/lexical.js";
import { isProviderInfraReason, LlmError } from "../llm.js";
import { formatFoodEx2Code } from "./foodex2-code.js";
import { evaluateLexicalAccept } from "./lexical-accept.js";
import { assignResiduals } from "./residuals.js";
import { scoreTraversalCandidates } from "./select.js";
import { collectTraversalCandidates } from "./traverse.js";
import type { AuditEntry, BaseTermRef, EncodeOk, EncodeResult } from "./types.js";

function rejectFromError(err: unknown, audit: AuditEntry[]): EncodeResult {
  const raw = err instanceof Error ? err.message : String(err);
  const reason = err instanceof LlmError ? err.kind : "traversal_error";
  const message = raw.startsWith("Model/provider error:")
    ? raw
    : `Model/provider error: ${raw}`;
  audit.push({ step: "llm_error", detail: { reason, message: raw } });
  return { status: "rejected", reason, message, audit };
}

export interface EncodeBaseTermOptions {
  lexicalLimit?: number;
  /** Top-K embedding hits used only as traversal walk seeds (default 5). */
  embeddingSeedLimit?: number;
  /** Skip LLM traversal (lexical-only). */
  lexicalOnly?: boolean;
  /** Skip residual facet / free-text assignment (base term only). */
  baseOnly?: boolean;
  model?: string;
}

async function withFacets(
  input: string,
  base: Omit<EncodeOk, "facets" | "freeText" | "code">,
  options: EncodeBaseTermOptions
): Promise<EncodeResult> {
  if (options.baseOnly) {
    return {
      ...base,
      facets: [],
      freeText: null,
      code: formatFoodEx2Code(base.baseTerm.code, []),
    };
  }

  try {
    const assigned = await assignResiduals(input, base.baseTerm, {
      model: options.model,
      fit: base.fit ?? null,
      food: base.food ?? input,
      descriptionKind: base.descriptionKind ?? null,
    });
    base.audit.push(...assigned.audit);
    if (assigned.status === "rejected") {
      return {
        status: "rejected",
        reason: assigned.reason,
        message: assigned.message,
        audit: base.audit,
      };
    }
    return {
      ...base,
      facets: assigned.facets,
      freeText: assigned.freeText,
      code: assigned.code,
    };
  } catch (err: unknown) {
    if (err instanceof LlmError && isProviderInfraReason(err.kind)) {
      return rejectFromError(err, base.audit);
    }
    const message = err instanceof Error ? err.message : String(err);
    base.audit.push({ step: "residuals_error", detail: { message } });
    return {
      ...base,
      facets: [],
      freeText: null,
      code: formatFoodEx2Code(base.baseTerm.code, []),
    };
  }
}

function okBase(
  baseTerm: BaseTermRef,
  method: EncodeOk["method"],
  audit: AuditEntry[],
  extra: Partial<EncodeOk> = {}
): Omit<EncodeOk, "facets" | "freeText" | "code"> {
  return {
    status: "ok",
    baseTerm,
    method,
    audit,
    ...extra,
  };
}

export async function encodeBaseTerm(
  rawInput: string,
  options: EncodeBaseTermOptions = {}
): Promise<EncodeResult> {
  const input = rawInput.trim();
  const audit: AuditEntry[] = [];
  const lexicalLimit = options.lexicalLimit ?? 10;

  audit.push({ step: "input", detail: { raw: rawInput, trimmed: input } });

  if (input === "") {
    return {
      status: "rejected",
      reason: "empty_input",
      message: "Input is empty",
      audit,
    };
  }

  const hits = searchTerms(input, { limit: lexicalLimit, baseOnly: true, underFood: true });

  audit.push({
    step: "lexical_search",
    detail: {
      hits: hits.map((h) => ({ code: h.code, name: h.name, score: h.score })),
    },
  });

  const pick = evaluateLexicalAccept(input, hits);

  audit.push({
    step: "identical_wording",
    detail: pick ? { code: pick.hit.code, name: pick.hit.name } : { matched: false },
  });

  if (pick) {
    const term = Catalogue.load().term(pick.hit.code);
    const base = okBase(
      { code: pick.hit.code, name: term?.name ?? pick.hit.name },
      "lexical",
      audit
    );
    return withFacets(input, base, options);
  }

  if (options.lexicalOnly) {
    return {
      status: "rejected",
      reason: "no_identical_wording",
      message: "No catalogue term has identical wording to the input",
      audit,
    };
  }

  try {
    const collected = await collectTraversalCandidates(input, {
      model: options.model,
      ...(options.embeddingSeedLimit !== undefined
        ? { embeddingSeedLimit: options.embeddingSeedLimit }
        : {}),
    });
    audit.push(...collected.audit);

    const candidates = collected.candidates;
    audit.push({
      step: "candidate_pool",
      detail: {
        traversalCount: candidates.length,
      },
    });

    if (candidates.length === 0) {
      return {
        status: "rejected",
        reason: "no_candidates",
        message: "Catalogue walk yielded no term candidates",
        audit,
      };
    }

    const selection = await scoreTraversalCandidates(input, candidates, {
      model: options.model,
      descriptionKind: collected.descriptionKind,
    });
    audit.push(...selection.audit);

    if (selection.pick === null) {
      return {
        status: "rejected",
        reason: "no_selectable_candidate",
        message: "No usable term candidates found in the catalogue walk pool",
        audit,
      };
    }

    const base = okBase(selection.pick, "traversal", audit, {
      ...(selection.pickKind !== null ? { fit: selection.pickKind } : {}),
      food: input,
      descriptionKind: collected.descriptionKind,
      candidates,
      scored: selection.scored,
      walks: collected.walks,
      steps: collected.steps,
    });
    return withFacets(input, base, options);
  } catch (err: unknown) {
    return rejectFromError(err, audit);
  }
}
