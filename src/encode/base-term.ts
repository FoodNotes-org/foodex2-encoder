/**
 * Base-term encoding, then residuals. A composite-dish pick whose name is not
 * the description is read as a dish; any other pick is read as a foodstuff.
 *
 *   search → identical wording? → residuals
 *   else → expo traversal (embeddings tip walk seeds) → selection → residuals
 */

import { Catalogue, DEFAULT_HIERARCHY } from "../catalogue.js";
import { DEFAULT_COUNTRY_CODE, resolveCountry } from "../country.js";
import { searchTerms } from "../search/lexical.js";
import { sameContentTokenSet } from "../search/content-match.js";
import { LlmError } from "../llm.js";
import { formatFoodEx2Code } from "./foodex2-code.js";
import { evaluateLexicalAccept } from "./lexical-accept.js";
import { processTableFact, type NamedFacets } from "./base-compare.js";
import type { DescriptionKind } from "./types.js";
import { assignResiduals } from "./residuals.js";
import { scoreTraversalCandidates } from "./select.js";
import { collectTraversalCandidates } from "./traverse.js";
import type { AuditEntry, BaseTermRef, EncodeOk, EncodeResult } from "./types.js";

/**
 * Upper bound on a trimmed food description. Longer pastes ride along in
 * every model call and multiply cost; eval cases top out well under this.
 */
export const MAX_ENCODE_INPUT_CHARS = 300;

/** Exposure root of composite dishes. A pick here is a dish shelf. */
const COMPOSITE_DISHES = "A03VA";

/**
 * A composite-dish term whose name is not the description is a named dish:
 * the name stands for ingredients the term does not already state. Any other
 * pick is read as a foodstuff, so a stated process can be recorded on it.
 */
export function descriptionKindForPick(code: string, description: string): DescriptionKind {
  const cat = Catalogue.load();
  const name = cat.term(code)?.name ?? "";
  if (cat.isAncestor(COMPOSITE_DISHES, code, DEFAULT_HIERARCHY) && !sameContentTokenSet(description, name)) {
    return "dish";
  }
  return "foodstuff";
}

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
  /** ISO 3166-1 alpha-2 code of the country the description comes from, or EU. */
  country?: string;
  /** False uses the legacy residual path. Default is attribute slots. */
  facetSlots?: boolean;
}

async function withFacets(
  input: string,
  base: Omit<EncodeOk, "facets" | "freeText" | "code">,
  options: EncodeBaseTermOptions,
  country: string | null,
  minorFoods?: string[],
  named?: NamedFacets | null
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
      country,
      ...(minorFoods !== undefined && minorFoods.length > 0 ? { minorFoods } : {}),
      ...(options.facetSlots === false ? { facetSlots: false } : {}),
      ...(named !== undefined && named !== null ? { named } : {}),
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
    if (err instanceof LlmError) {
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

  const given = options.country?.trim() ?? "";
  const resolved = resolveCountry(given === "" ? DEFAULT_COUNTRY_CODE : given);
  if (!resolved.ok) {
    audit.push({ step: "input", detail: { input, country: options.country ?? given } });
    return { status: "rejected", reason: "invalid_country", message: resolved.message, audit };
  }
  const country = resolved.name;
  audit.push({ step: "input", detail: { input, country: resolved.code } });

  if (input.length === 0) {
    return {
      status: "rejected",
      reason: "empty_input",
      message: "Input is empty",
      audit,
    };
  }

  if (input.length > MAX_ENCODE_INPUT_CHARS) {
    return {
      status: "rejected",
      reason: "input_too_long",
      message: `Food descriptions must be at most ${MAX_ENCODE_INPUT_CHARS} characters (got ${input.length}).`,
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
    return withFacets(input, base, options, country);
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
      country,
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

    const processes = (collected.named?.processes ?? []).flatMap((process) => {
      const fact = processTableFact(Catalogue.load(), process.code);
      return fact === null ? [] : [fact];
    });
    const selection = await scoreTraversalCandidates(input, candidates, {
      model: options.model,
      country,
      processes,
    });
    audit.push(...selection.audit);

    const { pick, pickKind } = selection;

    if (pick === null) {
      return {
        status: "rejected",
        reason: "no_selectable_candidate",
        message: "No usable term candidates found in the catalogue walk pool",
        audit,
      };
    }

    const base = okBase(pick, "traversal", audit, {
      ...(pickKind !== null ? { fit: pickKind } : {}),
      food: input,
      descriptionKind: descriptionKindForPick(pick.code, input),
      candidates,
      scored: selection.scored,
      walks: collected.walks,
      steps: collected.steps,
    });
    return withFacets(input, base, options, country, selection.minorFoods, collected.named);
  } catch (err: unknown) {
    return rejectFromError(err, audit);
  }
}
