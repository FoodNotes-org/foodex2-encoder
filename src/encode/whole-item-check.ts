/**
 * Whole-item check on the composed code.
 *
 * A FoodEx2 code describes one item; each added facet is a statement about the
 * item as a whole. A facet stays only when the input establishes that statement
 * of the item as a whole, judged against the full input rather than the phrase
 * that proposed it. "Fresh and frozen shellfish" is not established as frozen;
 * a plate of "sausage with potatoes and fries" contains fries but was not fried.
 *
 * Generic-term (F26) is not checked: it records why the base was chosen, not a
 * property of the food.
 */

import { Catalogue } from "../catalogue.js";
import { chatJson } from "../llm.js";
import type { FacetDescriptorRef } from "./types.js";

const UNCHECKED_HEADERS: ReadonlySet<string> = new Set(["F26"]);

const SYSTEM_WHOLE_ITEM = `You are a food and nutrition ontology expert.

A FoodEx2 code describes one item: a base term plus facet descriptors. Each facet descriptor is a statement about the item as a whole, read through its facet category.

Given a description of the item (\`input\`) and a proposed code, judge each facet: does \`input\` establish its statement of the item as a whole?

Reply with JSON only:
{"verdicts":[{"facet":"<header>.<code>","statement":"<the facet as a sentence about the item>","true":true|false}]}
`;

export interface WholeItemVerdict {
  facet: FacetDescriptorRef;
  statement: string | null;
  /** Null when the reply gave no verdict for this facet (kept). */
  holds: boolean | null;
}

function facetKey(facet: FacetDescriptorRef): string {
  return `${facet.header}.${facet.code}`.toUpperCase();
}

export function isWholeItemChecked(facet: FacetDescriptorRef): boolean {
  return !UNCHECKED_HEADERS.has(facet.header);
}

export function wholeItemPayload(
  cat: Catalogue,
  input: string,
  baseCode: string,
  facets: FacetDescriptorRef[]
): string {
  return JSON.stringify(
    {
      input,
      code: {
        baseTerm: cat.term(baseCode)?.name ?? baseCode,
        facets: facets.map((f) => ({
          facet: `${f.header}.${f.code}`,
          category: cat.facetCategory(f.header)?.label ?? f.header,
          descriptor: f.name,
        })),
      },
    },
    null,
    2
  );
}

/**
 * Verdict per facet. Replies name facets as `<header>.<code>`, sometimes with
 * the category label in place of the header, so fall back to the descriptor
 * code when it identifies one facet unambiguously.
 */
export function parseWholeItemVerdicts(
  content: unknown,
  facets: FacetDescriptorRef[]
): WholeItemVerdict[] {
  const raw =
    content !== null && typeof content === "object"
      ? (content as { verdicts?: unknown }).verdicts
      : undefined;
  const rows = Array.isArray(raw) ? raw : [];
  const byKey = new Map<string, { statement: string | null; holds: boolean }>();
  const byCode = new Map<string, Array<{ statement: string | null; holds: boolean }>>();
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const r = row as { facet?: unknown; statement?: unknown; true?: unknown };
    if (typeof r.facet !== "string" || typeof r.true !== "boolean") continue;
    const verdict = {
      statement: typeof r.statement === "string" ? r.statement : null,
      holds: r.true,
    };
    const key = r.facet.trim().toUpperCase();
    byKey.set(key, verdict);
    const code = key.slice(key.lastIndexOf(".") + 1);
    byCode.set(code, [...(byCode.get(code) ?? []), verdict]);
  }

  return facets.map((facet) => {
    const code = facet.code.toUpperCase();
    const sameCode = facets.filter((f) => f.code.toUpperCase() === code).length;
    const byCodeHits = byCode.get(code) ?? [];
    const verdict =
      byKey.get(facetKey(facet)) ??
      (sameCode === 1 && byCodeHits.length === 1 ? byCodeHits[0] : undefined);
    return {
      facet,
      statement: verdict?.statement ?? null,
      holds: verdict?.holds ?? null,
    };
  });
}

/** Keep facets the input establishes of the item as a whole; F26 passes unchecked. */
export async function checkWholeItem(
  cat: Catalogue,
  input: string,
  baseCode: string,
  facets: FacetDescriptorRef[],
  options: { model: string }
): Promise<{
  facets: FacetDescriptorRef[];
  rejected: FacetDescriptorRef[];
  detail: Record<string, unknown>;
}> {
  const checked = facets.filter(isWholeItemChecked);
  if (checked.length === 0) {
    return { facets, rejected: [], detail: { skipped: "no_checked_facets" } };
  }

  const answered = await chatJson({
    model: options.model,
    system: SYSTEM_WHOLE_ITEM,
    user: wholeItemPayload(cat, input, baseCode, checked),
  });
  const verdicts = parseWholeItemVerdicts(answered.content, checked);
  const rejectedKeys = new Set(
    verdicts.filter((v) => v.holds === false).map((v) => facetKey(v.facet))
  );

  return {
    facets: facets.filter((f) => !rejectedKeys.has(facetKey(f))),
    rejected: checked.filter((f) => rejectedKeys.has(facetKey(f))),
    detail: {
      model: answered.model,
      verdicts: verdicts.map((v) => ({
        facet: facetKey(v.facet),
        name: v.facet.name,
        statement: v.statement,
        holds: v.holds,
      })),
      ...(verdicts.some((v) => v.holds === null)
        ? { unjudged: verdicts.filter((v) => v.holds === null).map((v) => facetKey(v.facet)) }
        : {}),
    },
  };
}
