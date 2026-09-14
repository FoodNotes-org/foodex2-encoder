/**
 * Residuals after the base term: unstated essence / name meaning first, then
 * input vs base.
 *
 * 1a. Named-dish unstated essence — when route said dish/dish_type: define →
 *     kind-tagged properties → drop those entailed by the base name (model) →
 *     place survivors by kind (code-to-code implicits at place).
 * 1b. Foodstuff name meaning — when route said foodstuff and fit is broad:
 *     what the common name conventionally means that the locked base does not
 *     capture → same property shape, miss → drop (no not_in_input filter).
 * 1c. Fortification — before any ingredient/source placement: does the input
 *     claim fortification/enrichment/supplementation? Bare → F10 Fortified;
 *     named agents → F09 via the fortification-agent shortlist (A0EVE tree).
 *     Recorded in `covered` so input-vs-base does not re-list those as ingredient.
 * 2. Input vs base — what the input still expresses; covered includes step 1;
 *    `side` → free text; ingredient/source → origin role → F01/F27/F04
 *    (`mix` on an RPC/derivative base prefers F27 over F01); `other` → Facets
 *    (A0B8V) dimension pick → closed place in that header. Mix skips F26 Other.
 * For dish/dish_type, defining span is for essence grounding + dish= identity;
 * step 2 always sees the full input (attributes in the dish wording stay claimable).
 * Other route kinds: wording denseness goes through input vs base like any leftover.
 * Both channels use the same property shape and placeByKind (no cross-kind fall-through).
 * Essence / name meaning (`onMiss: drop`) may specify a child under an implied F04
 * when the phrase names that child (beef under mammals meat); it drops generic
 * restatements (eggs under Whole eggs → not Hen eggs). Input-vs-base may still
 * narrow freely.
 */

import { Catalogue, DEFAULT_HIERARCHY } from "../catalogue.js";
import { chatJson, defaultModel } from "../llm.js";
import { contentTokens, sameContentTokenSet } from "../search/content-match.js";
import { searchTerms, type SearchCandidate } from "../search/lexical.js";
import { vectorIndexAvailable, vectorSearchFacets } from "../search/vector.js";
import { pickAllowedCode, pickAllowedCodes } from "./answers.js";
import { formatFoodEx2Code, sortFacets } from "./foodex2-code.js";
import type {
  AuditEntry,
  BaseTermRef,
  DescriptionKind,
  FacetDescriptorRef,
  FreeTextEntry,
  SelectFit,
} from "./types.js";

const INGRED_HIERARCHY = "ingred";
const F01 = "F01";
const F04 = "F04";
const F26 = "F26";
const F27 = "F27";
const F28 = "F28";
const F21 = "F21";
const F09 = "F09";
const F10 = "F10";
/** Qualitative-info leaf: fortifying agents have been added, none named. */
const F10_FORTIFIED = "A0F6C";

const F26_UNSPECIFIED = "A07XD";
const F26_OTHER = "A07XE";

/** MTX Facets root — closed attribute dimensions (not Source / Ingredient / F27). */
const FACETS_ROOT = "A0B8V";
/** Generic-term under Facets — F26 only via the dedicated base-generic path. */
const FACETS_GENERIC_TERM = "A0B9F";
const MTX_HIERARCHY = "MTX";

/** How a named organism relates to the food: it is one (F01), made from one (F27), or contains one (F04). */
export type OriginRole = "organism" | "made_from" | "contains";

/**
 * The base term's type fixes which origin facet its components take (guidance
 * Table 8): raw commodity → source (F01), derivative → source-commodities (F27),
 * composite → ingredients (F04). Same-nature mixes (§3.1.10 / §5.4.3) override:
 * components of an RPC or derivative mix are source-commodities (F27), not live
 * sources (F01). Returned in try-order: a phrase that does not resolve as the
 * prescribed origin is by definition an addition (§3.1.9), so F04 is the
 * fallback. Null when the type does not settle it (broad, natural source,
 * unknown) and the model must be asked.
 */
export function originRolesForBaseType(
  baseTermType: string | null,
  descriptionKind: DescriptionKind | null = null
): OriginRole[] | null {
  if (
    descriptionKind === "mix" &&
    (baseTermType === "r" || baseTermType === "d")
  ) {
    return ["made_from", "contains"];
  }
  switch (baseTermType) {
    case "r":
      return ["organism", "contains"];
    case "d":
      return ["made_from", "contains"];
    case "s":
    case "c":
      return ["contains"];
    default:
      return null;
  }
}

/**
 * Fallback when the base type leaves the origin facet open:
 * organism → F01, made-from → F27, contains → F04.
 */
const SYSTEM_ORIGIN_ROLE = `You are a food and nutrition ontology expert.

Relative to the locked food, does this property point to:
(1) which organism the food comes from
(2) what raw foodstuff it was made from
(3) what it contains as a characterising inclusion

Use (1) when specifying the live plant or animal (species on fish/meat, plant on a raw commodity).
Use (2) when the locked food is made from a raw foodstuff (milk for cheese, grain for flour, seed for oil) — even if the property only names the animal or plant.
Use (3) when the property is an inclusion in a composite or mixed food.
If unclear, return null.

Reply with JSON only:
{"role":"organism"|"made_from"|"contains"|null}
`;

/**
 * Facets (A0B8V) dimension recall for an `other` property.
 * Candidates may include codingGuidance — MTX scope text for that dimension.
 * Embedding tips reorder candidates / seed leaf pick in code; they are not shown to the model.
 * Wide recall: list every dimension that might fit; placement tries them in order.
 */
const SYSTEM_FACET_DIMENSION = `You are a food and nutrition ontology expert.

Relative to the food, which candidates might be a possible fit for this property?

Candidates may include codingGuidance: catalogue coding instructions for that dimension — not a description of the food. Use it only to judge whether the property could belong there.

List every candidate code that might fit (wide recall). Empty list if none.

Reply with JSON only:
{"codes":["<code>",...]}
`;

/** Named-dish unstated essence → kind-tagged properties to place. */
const SYSTEM_ESSENCE = `You are a food and nutrition ontology expert.

Give a concise definition of this named dish or dish type that only captures the essential characteristics of the dish – only the ones that strictly define it.

From that definition only, list the characterising parts of the finished dish as properties. For each: a short \`phrase\` and a \`kind\`.

Kinds:
- ingredient — characterising ingredient or inclusion
- source — plant/animal/commodity the food comes from
- process — treatment or preparation
- other — any other distinctness (fat level, part, packaging, production method, …)

Reply with JSON only:
{"definition":"<text>","properties":[{"phrase":"<text>","kind":"ingredient"|"source"|"process"|"other"},...]}
`;

/**
 * Does the base term itself already entail each essence property?
 * Catalogue implicits are applied later, code-to-code, when placing.
 */
const SYSTEM_ESSENCE_COVER = `You are a food and nutrition ontology expert.

A food has been assigned the given base term. Each property is a candidate attribute.

For each property, is it already entailed by that base term — something the base name itself assumes or defines (ingredient, source, process, or other), not merely a common optional addition or variant?

Reply with JSON only:
{"verdicts":[{"id":"<id>","covered":true|false},...]}
`;

/**
 * Foodstuff common-name meaning when the locked base is only a broader shelf.
 * Same property shape as dish essence; miss → drop (world knowledge, not input parse).
 */
const SYSTEM_NAME_MEANING = `You are a food and nutrition ontology expert.

You are given a food name and the locked catalogue base term (a broader shelf that does not fully name that food).

State briefly what the name conventionally means. Imagine the densest catalogue-style name for that meaning. List only characterising properties that denser name would carry beyond the locked base. For each: a short \`phrase\` and a \`kind\`.

Kinds:
- ingredient — characterising ingredient or inclusion
- source — plant/animal/commodity the food comes from
- process — treatment or preparation
- other — any other distinctness (freshness/storage state, fat level, part, packaging, production method, …)

If the base already covers the name, return an empty property list.
Do not list properties already captured in \`covered\`.

Reply with JSON only:
{"definition":"<text>","properties":[{"phrase":"<text>","kind":"ingredient"|"source"|"process"|"other"},...]}
`;

/**
 * Fortification / enrichment / supplementation — asked before ingredient/source
 * placement so those routes do not claim the same wording as F04.
 */
const SYSTEM_FORTIFICATION = `You are a food and nutrition ontology expert.

Does this food description state that the food is fortified, enriched, or supplemented — including a nutrient or substance added for that purpose?

If no: return null.
If yes but no fortifying agent is named: return "bare".
If yes and one or more agents are named: list each agent as a short phrase (the nutrient or substance only).

Reply with JSON only:
{"fortification":null|"bare"|{"agents":["<phrase>",...]}}
`;

/** Detected fortification claim; facet placement comes in a later step. */
export type FortificationClaim =
  | { status: "none" }
  | { status: "bare" }
  | { status: "agents"; agents: string[] };

/** Input vs locked base → kind-tagged properties not yet captured. */
function systemInputVsBase(allowSide: boolean): string {
  const kinds = [
    "- ingredient — a characterising constituent of this food",
    "- source — plant/animal/commodity the food comes from",
    "- process — treatment or preparation",
    ...(allowSide ? ["- side — another food served with it"] : []),
    "- other — any other distinctness (fat level, part, packaging, production method, …)",
  ].join("\n");
  const kindEnum = allowSide
    ? '"ingredient"|"source"|"process"|"side"|"other"'
    : '"ingredient"|"source"|"process"|"other"';
  return `You are a food and nutrition ontology expert.

You are given a food description (\`input\`) and what is already captured (\`baseTerm\`, \`implicits\`, \`covered\`).

List only the properties that \`input\` still expresses and that are not yet captured. Omit wording that do not materially change the food. For each kept property: a short \`phrase\` and a \`kind\`. Put omitted candidates in \`omitted\` with a short \`reason\` so the omission is explicit.

Kinds:
${kinds}

If nothing is left to keep, return an empty properties list.

Reply with JSON only:
{"properties":[{"phrase":"<text>","kind":${kindEnum}},...],"omitted":[{"phrase":"<text>","reason":"<text>"},...]}
`;
}

function sideAllowedForKind(descriptionKind: DescriptionKind | null): boolean {
  return descriptionKind === "dish" || descriptionKind === "dish_type";
}

/** Residual property kinds; each has exactly one placement route (see placeByKind). */
export type GapPropertyKind =
  | "ingredient"
  | "source"
  | "process"
  | "side"
  | "other";

export interface GapProperty {
  phrase: string;
  kind: GapPropertyKind;
}

const GAP_KINDS = new Set<GapPropertyKind>([
  "ingredient",
  "source",
  "process",
  "side",
  "other",
]);

/** Whether a phrase names a characterising ingredient among F04 candidates. */
const SYSTEM_F04_PICK = `You are a food and nutrition ontology expert.

You are matching a phrase against a list of candidate ingredient descriptors. The phrase describes one property of a food whose main term is already chosen. If the phrase states a characterising ingredient of that food and a candidate denotes that same ingredient, that candidate is the match; otherwise there is no match.

A candidate denotes the same ingredient only when it is not a broader group, a related product, or a preparation the phrase does not state.

Something served alongside the food, a cooking method or form, or an optional or alternative inclusion is not an ingredient of the food.

Return the matching candidate's code, preferring the raw commodity over a flavour descriptor when the phrase names the food itself. Otherwise return null.

Reply with JSON only:
{"code":"<code>"|null}
`;

/** Closed-facet pick (F28/F21/F01/F27/…): same thing as a candidate, or null. */
const SYSTEM_CLOSED_PICK = `You are a food and nutrition ontology expert.

Does the phrase mean the same thing as one of the candidates?

If yes, return that candidate's code. Prefer a more specific candidate when the phrase still means the same thing; do not pick a candidate that adds detail the phrase does not support.
If none, return null.

Reply with JSON only:
{"code":"<CODE>"|null}
`;

/** F26 Other: is this food a missing sibling under the parent base (not a parent/relative of the set)? */
export function promptF26Other(a: string, termNames: string[]): string {
  return `As an ontologist, how would you classify ${JSON.stringify(a)} in relationship with the set ${JSON.stringify(termNames)}?

Assign one of:
- "parent" — it is a broader kind that the set belongs under
- "sibling" — it belongs as a peer of the set, forming a coherent set together
- "relative" — it is related but neither a parent nor a peer
- "non-related" — it does not belong with this set

Reply with JSON only:
{"verdict":"parent"|"sibling"|"relative"|"non-related"}
`;
}

export interface AssignResidualsOptions {
  model?: string;
  /** How the base was selected relative to the input (from traversal/lexical). */
  fit?: SelectFit | null;
  /**
   * Phrase residuals treat as the food name (usually the full input). Used as the
   * grounded dish name when essence runs (route said dish / dish_type).
   */
  food?: string;
  /**
   * From the traversal route. Dish essence runs for `dish` / `dish_type`.
   * Foodstuff name meaning runs for `foodstuff` when fit is `broad`.
   * `mix` places components as F27 on an RPC/derivative base and skips F26 Other.
   * Lexical auto-accept and missing route → skip dish / foodstuff essence.
   */
  descriptionKind?: DescriptionKind | null;
}

export interface AssignResidualsOk {
  status: "ok";
  facets: FacetDescriptorRef[];
  freeText: FreeTextEntry[] | null;
  code: string;
  audit: AuditEntry[];
}

export interface AssignResidualsRejected {
  status: "rejected";
  reason: string;
  message: string;
  audit: AuditEntry[];
}

export type AssignResidualsResult = AssignResidualsOk | AssignResidualsRejected;

type LexHit = Pick<SearchCandidate, "code" | "name" | "score">;

interface PlaceContext {
  cat: Catalogue;
  baseCode: string;
  baseName: string;
  /** MTX termType of the locked base (r/d/c/…). */
  baseTermType: string | null;
  /** From the traversal route; drives mix → F27 and dish essence. */
  descriptionKind: DescriptionKind | null;
  implied: Set<string>;
  impliedF04: string[];
  facets: FacetDescriptorRef[];
  freeText: FreeTextEntry[];
  seenCodes: Set<string>;
  singleHeaders: Set<string>;
  model: string;
  input: string;
  fit: SelectFit | null;
  /** Step 0 claim; later leftover phrases that restate it are not placed again. */
  fortificationClaim: FortificationClaim;
}

function altNames(code: string): string[] {
  return Catalogue.load().altNames(code);
}

function impliedKeys(cat: Catalogue, baseCode: string): Set<string> {
  return new Set(cat.impliedFacets(baseCode));
}

function impliedF04Codes(cat: Catalogue, baseCode: string): string[] {
  return [...impliedKeys(cat, baseCode)]
    .filter((f) => f.startsWith(`${F04}.`))
    .map((f) => f.slice(4));
}

function isIngredientDescriptor(cat: Catalogue, code: string): boolean {
  return cat.belongsTo(code, INGRED_HIERARCHY) && !cat.isDeprecated(code);
}

export function parseOriginRole(content: unknown): OriginRole | null {
  if (content === null || typeof content !== "object") return null;
  const raw = (content as { role?: unknown }).role;
  if (typeof raw !== "string") return null;
  const role = raw.trim().toLowerCase();
  if (role === "organism" || role === "made_from" || role === "contains") {
    return role;
  }
  return null;
}

/**
 * Roles to try for an ingredient/source phrase, in order. The base type decides
 * when it can; otherwise the model is asked once.
 */
async function originRolesFor(
  ctx: PlaceContext,
  phrase: string
): Promise<{ roles: OriginRole[]; detail: Record<string, unknown> }> {
  const fixed = originRolesForBaseType(ctx.baseTermType, ctx.descriptionKind);
  if (fixed !== null) {
    return {
      roles: fixed,
      detail: {
        via: "origin_role",
        phrase,
        food: ctx.baseName,
        baseTermType: ctx.baseTermType,
        descriptionKind: ctx.descriptionKind,
        roles: fixed,
        decidedBy:
          ctx.descriptionKind === "mix" &&
          (ctx.baseTermType === "r" || ctx.baseTermType === "d")
            ? "mix"
            : "base_term_type",
      },
    };
  }

  const answered = await chatJson({
    model: ctx.model,
    system: SYSTEM_ORIGIN_ROLE,
    user: JSON.stringify(
      {
        food: ctx.baseName,
        property: phrase,
        input: ctx.input,
      },
      null,
      2
    ),
  });
  const role = parseOriginRole(answered.content);
  return {
    roles: role === null ? [] : [role],
    detail: {
      via: "origin_role",
      model: answered.model,
      phrase,
      food: ctx.baseName,
      baseTermType: ctx.baseTermType,
      role,
      decidedBy: "model",
    },
  };
}

function freeTextLabelForOriginRole(
  role: OriginRole | null,
  kind: GapPropertyKind,
  otherLabel?: string | null
): string {
  if (role === "contains") return "ingredient";
  if (role === "organism") return "source";
  if (role === "made_from") return "source-commodity";
  if (kind === "ingredient") return "ingredient";
  if (kind === "source") return "source";
  if (kind === "process") return "process";
  if (kind === "other" && otherLabel !== undefined && otherLabel !== null && otherLabel.trim() !== "") {
    return otherLabel.trim().toLowerCase();
  }
  if (kind === "other") return "note";
  return "note";
}

export interface FacetDimension {
  code: string;
  name: string;
  /** Facet header (Fxx) whose descriptors live under this dimension. */
  header: string;
  /** MTX scope note on the dimension root — coder guidance, not a food definition. */
  codingGuidance: string | null;
}

/**
 * Map a Facets-tree dimension root to its Fxx via the hierarchyCode on descendants
 * (catalogue-driven — not a hand-written role→header table).
 */
export function headerForFacetDimension(
  cat: Catalogue,
  dimensionCode: string
): string | null {
  const queue = [...cat.children(dimensionCode, MTX_HIERARCHY)];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const code = queue.shift()!;
    if (seen.has(code)) continue;
    seen.add(code);
    const term = cat.term(code);
    if (term === undefined) continue;
    for (const hierarchy of Object.keys(term.hierarchies)) {
      if (hierarchy === MTX_HIERARCHY) continue;
      for (const [header, def] of Object.entries(cat.data.facetCategories)) {
        if (def.hierarchyCode === hierarchy) return header;
      }
    }
    for (const child of cat.children(code, MTX_HIERARCHY)) {
      queue.push(child);
    }
  }
  return null;
}

/** Direct children of Facets (A0B8V), excluding Generic-term (F26 path). */
export function facetDimensions(cat: Catalogue): FacetDimension[] {
  const out: FacetDimension[] = [];
  for (const code of cat.children(FACETS_ROOT, MTX_HIERARCHY)) {
    if (code === FACETS_GENERIC_TERM) continue;
    if (cat.isDeprecated(code)) continue;
    const header = headerForFacetDimension(cat, code);
    if (header === null || header === F26) continue;
    const term = cat.term(code);
    const name = term?.name ?? code;
    const guidance = term?.scopeNote?.trim() || null;
    out.push({ code, name, header, codingGuidance: guidance });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
}

/**
 * Walk MTX parents to the Facets (A0B8V) dimension root that owns this term.
 * Returns null when the term is not under Facets.
 */
export function facetDimensionCodeForTerm(
  cat: Catalogue,
  termCode: string
): string | null {
  let current: string | null = termCode;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const parent = cat.parent(current, MTX_HIERARCHY);
    if (parent === FACETS_ROOT) return current;
    current = parent;
  }
  return null;
}

export interface FacetEmbeddingTip {
  descriptorCode: string;
  descriptorName: string;
  similarity: number;
  dimensionCode: string;
  dimensionName: string;
  header: string;
}

const DEFAULT_FACET_EMBEDDING_TIP_LIMIT = 5;

/** Semantic tip hits for an `other` property — never auto-accept. */
export async function gatherFacetEmbeddingTips(
  cat: Catalogue,
  phrase: string,
  dimensions: FacetDimension[],
  limit = DEFAULT_FACET_EMBEDDING_TIP_LIMIT
): Promise<FacetEmbeddingTip[]> {
  if (!vectorIndexAvailable("facets")) return [];
  const byDim = new Map(dimensions.map((d) => [d.code, d]));
  const hits = await vectorSearchFacets(phrase, limit);
  const tips: FacetEmbeddingTip[] = [];
  for (const hit of hits) {
    const dimensionCode = facetDimensionCodeForTerm(cat, hit.code);
    if (dimensionCode === null || dimensionCode === FACETS_GENERIC_TERM) continue;
    const dim = byDim.get(dimensionCode);
    if (dim === undefined) continue;
    tips.push({
      descriptorCode: hit.code,
      descriptorName: cat.term(hit.code)?.name ?? hit.code,
      similarity: hit.similarity,
      dimensionCode: dim.code,
      dimensionName: dim.name,
      header: dim.header,
    });
  }
  return tips;
}

async function askFacetDimension(
  ctx: PlaceContext,
  phrase: string,
  dimensions: FacetDimension[],
  embeddingTips: FacetEmbeddingTip[] = []
): Promise<{
  dimensions: FacetDimension[];
  model: string;
  detail: Record<string, unknown>;
}> {
  const byCode = new Map(dimensions.map((d) => [d.code, d]));
  const allowed = new Set(byCode.keys());
  const tipped = new Set(embeddingTips.map((t) => t.dimensionCode));
  const ordered = [
    ...dimensions.filter((d) => tipped.has(d.code)),
    ...dimensions.filter((d) => !tipped.has(d.code)),
  ];
  const answered = await chatJson({
    model: ctx.model,
    system: SYSTEM_FACET_DIMENSION,
    user: JSON.stringify(
      {
        food: ctx.baseName,
        property: phrase,
        input: ctx.input,
        candidates: ordered.map((d) => {
          const row: { code: string; name: string; codingGuidance?: string } = {
            code: d.code,
            name: d.name,
          };
          if (d.codingGuidance !== null) row.codingGuidance = d.codingGuidance;
          return row;
        }),
      },
      null,
      2
    ),
  });
  const pickedCodes = pickAllowedCodes(answered.content, allowed);
  // Among model recalls, try embedding-tipped dimensions first.
  const rankedCodes = [
    ...pickedCodes.filter((c) => tipped.has(c)),
    ...pickedCodes.filter((c) => !tipped.has(c)),
  ];
  const picked = rankedCodes
    .map((c) => byCode.get(c))
    .filter((d): d is FacetDimension => d !== undefined);
  return {
    dimensions: picked,
    model: answered.model,
    detail: {
      via: "facet_dimension",
      model: answered.model,
      phrase,
      food: ctx.baseName,
      picked: rankedCodes,
      embeddingTips: embeddingTips.map((t) => ({
        code: t.descriptorCode,
        name: t.descriptorName,
        similarity: Math.round(t.similarity * 1000) / 1000,
        dimension: t.dimensionName,
        header: t.header,
      })),
    },
  };
}

export type AcceptFacetOptions = {
  baseCode?: string;
  baseTermType?: string | null;
  /**
   * Essence channel: when a descriptor sits under an implied F04, keep it only if
   * `phrase` names that child (specify-the-generic). Drop if the phrase merely
   * restates the implied parent (e.g. "eggs" under Whole eggs → not Hen eggs).
   */
  rejectUnderImplied?: boolean;
  /** Required with rejectUnderImplied for the specify-vs-restate test. */
  phrase?: string;
};

export function acceptF04Descriptor(
  cat: Catalogue,
  descriptorCode: string,
  impliedF04: string[],
  options: AcceptFacetOptions = {}
):
  | "keep"
  | "restate"
  | "broader"
  | "already_implied"
  | "not_ingredient"
  | "composite_on_composite" {
  if (!isIngredientDescriptor(cat, descriptorCode)) return "not_ingredient";

  const descType = cat.term(descriptorCode)?.termType ?? null;
  if (options.baseTermType === "c" && descType === "c") {
    return "composite_on_composite";
  }
  if (options.baseCode !== undefined) {
    if (descriptorCode === options.baseCode) return "restate";
    // Descriptor is a parent of the base on ingred → broader restatement.
    if (cat.isAncestor(descriptorCode, options.baseCode, INGRED_HIERARCHY)) {
      return "broader";
    }
  }

  const phrase = options.phrase?.trim() ?? "";
  const descName = cat.term(descriptorCode)?.name ?? descriptorCode;

  for (const implied of impliedF04) {
    if (descriptorCode === implied) return "restate";
    if (cat.isAncestor(descriptorCode, implied, INGRED_HIERARCHY)) return "broader";
    if (
      options.rejectUnderImplied === true &&
      cat.isAncestor(implied, descriptorCode, INGRED_HIERARCHY)
    ) {
      // Narrower than implied: keep only when the phrase specifies this child,
      // not when it only matches the implied generic ("eggs" ≠ "Hen eggs").
      if (phrase === "") return "already_implied";
      const impliedName = cat.term(implied)?.name ?? implied;
      if (alignsComponentToFoodTerm(phrase, implied, impliedName)) {
        return "already_implied";
      }
      if (!alignsComponentToFoodTerm(phrase, descriptorCode, descName)) {
        return "already_implied";
      }
    }
  }
  return "keep";
}

function acceptClosedDescriptor(
  cat: Catalogue,
  header: string,
  code: string,
  implied: Set<string>,
  options: Pick<AcceptFacetOptions, "rejectUnderImplied"> = {}
): "keep" | "restate" | "broader" | "already_implied" | "not_descriptor" {
  const key = `${header}.${code}`;
  if (implied.has(key)) return "restate";

  const hierarchy = cat.facetCategory(header)?.hierarchyCode;
  if (hierarchy === undefined || !cat.belongsTo(code, hierarchy) || cat.isDeprecated(code)) {
    return "not_descriptor";
  }

  for (const imp of implied) {
    if (!imp.startsWith(`${header}.`)) continue;
    const impliedCode = imp.slice(header.length + 1);
    if (cat.isAncestor(code, impliedCode, hierarchy)) return "broader";
  }
  if (
    options.rejectUnderImplied === true &&
    narrowerThanImplied(cat, header, code, implied)
  ) {
    return "already_implied";
  }
  return "keep";
}

/** True when code is a proper descendant of an implied descriptor of the same header. */
function narrowerThanImplied(
  cat: Catalogue,
  header: string,
  code: string,
  implied: Set<string>
): boolean {
  const hierarchy = cat.facetCategory(header)?.hierarchyCode;
  if (hierarchy === undefined) return false;
  for (const imp of implied) {
    if (!imp.startsWith(`${header}.`)) continue;
    const impliedCode = imp.slice(header.length + 1);
    if (code === impliedCode) continue;
    if (cat.isAncestor(impliedCode, code, hierarchy)) return true;
  }
  return false;
}

export function parseGapProperties(content: unknown): GapProperty[] {
  if (content === null || typeof content !== "object") return [];
  const raw = (content as { properties?: unknown }).properties;
  if (!Array.isArray(raw)) return [];
  const out: GapProperty[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const phrase = item.trim();
      if (phrase !== "") out.push({ phrase, kind: "other" });
      continue;
    }
    if (item === null || typeof item !== "object") continue;
    const body = item as { phrase?: unknown; kind?: unknown };
    const phrase = typeof body.phrase === "string" ? body.phrase.trim() : "";
    if (phrase === "") continue;
    const kindRaw = typeof body.kind === "string" ? body.kind.trim().toLowerCase() : "";
    const kind = GAP_KINDS.has(kindRaw as GapPropertyKind)
      ? (kindRaw as GapPropertyKind)
      : "other";
    out.push({ phrase, kind });
  }
  return out;
}

/** Parse the fortification detection reply. Unknown shapes → none. */
export function parseFortification(content: unknown): FortificationClaim {
  if (content === null || typeof content !== "object") return { status: "none" };
  const raw = (content as { fortification?: unknown }).fortification;
  if (raw === null || raw === undefined) return { status: "none" };
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "bare") return { status: "bare" };
    if (s === "" || s === "null" || s === "none") return { status: "none" };
    // Single agent returned as a plain string.
    return { status: "agents", agents: [raw.trim()] };
  }
  if (typeof raw !== "object") return { status: "none" };
  const agentsRaw = (raw as { agents?: unknown }).agents;
  if (!Array.isArray(agentsRaw)) return { status: "none" };
  const agents: string[] = [];
  for (const item of agentsRaw) {
    if (typeof item !== "string") continue;
    const phrase = item.trim();
    if (phrase === "") continue;
    if (!agents.some((a) => a.toLowerCase() === phrase.toLowerCase())) {
      agents.push(phrase);
    }
  }
  if (agents.length === 0) return { status: "bare" };
  return { status: "agents", agents };
}

function normalizeFortificationPhrase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[-]/g, " ")
    .replace(/\s+/g, " ");
}

const FORTIFICATION_CLAIM_RE =
  /\b(fortif(?:y|ied|ication|ying)?|enrich(?:ed|ment)?|supplement(?:ed|s|ation)?)\b/;

/**
 * True when a leftover phrase restates a fortification claim already placed
 * (named agent and/or generic fortified/enriched/supplemented wording).
 */
export function phraseCoveredByFortification(
  phrase: string,
  claim: FortificationClaim
): boolean {
  if (claim.status === "none") return false;
  const p = normalizeFortificationPhrase(phrase);
  if (p === "") return false;
  if (claim.status === "agents") {
    for (const agent of claim.agents) {
      const a = normalizeFortificationPhrase(agent);
      if (a !== "" && p.includes(a)) return true;
    }
  }
  return FORTIFICATION_CLAIM_RE.test(p);
}

export function dropFortificationRestatements(
  properties: GapProperty[],
  claim: FortificationClaim
): { kept: GapProperty[]; dropped: GapProperty[] } {
  const kept: GapProperty[] = [];
  const dropped: GapProperty[] = [];
  for (const property of properties) {
    if (phraseCoveredByFortification(property.phrase, claim)) dropped.push(property);
    else kept.push(property);
  }
  return { kept, dropped };
}

async function askFortification(
  ctx: PlaceContext,
  foodDescription: string
): Promise<{ claim: FortificationClaim; detail: Record<string, unknown> }> {
  const answered = await chatJson({
    model: ctx.model,
    system: SYSTEM_FORTIFICATION,
    user: JSON.stringify(
      {
        input: foodDescription,
        baseTerm: { code: ctx.baseCode, name: ctx.baseName },
      },
      null,
      2
    ),
  });
  const claim = parseFortification(answered.content);
  return {
    claim,
    detail: {
      via: "fortification",
      model: answered.model,
      claim,
    },
  };
}

/** F10 Fortified when the claim names no agent. Null if implied or not a descriptor. */
export function bareFortifiedFacet(
  cat: Catalogue,
  implied: Set<string>
): FacetDescriptorRef | null {
  if (acceptClosedDescriptor(cat, F10, F10_FORTIFIED, implied) !== "keep") return null;
  return {
    header: F10,
    code: F10_FORTIFIED,
    name: cat.term(F10_FORTIFIED)?.name ?? "Fortified",
  };
}

async function applyFortification(
  ctx: PlaceContext,
  claim: FortificationClaim
): Promise<Record<string, unknown>> {
  if (claim.status === "none") {
    return { placement: "none" };
  }

  if (claim.status === "bare") {
    const facet = bareFortifiedFacet(ctx.cat, ctx.implied);
    const added = facet !== null && addFacet(ctx, facet);
    return {
      placement: "bare",
      facet,
      added,
    };
  }

  const f09Label =
    ctx.cat.facetCategory(F09)?.label?.trim().toLowerCase() || "fortification-agent";
  const placed: Array<{ agent: string; facet: FacetDescriptorRef }> = [];
  const missed: Array<{ agent: string; detail: Record<string, unknown> }> = [];

  for (const agent of claim.agents) {
    const resolved = await resolveClosedFacetPhrase(ctx.cat, agent, F09, ctx.implied, {
      model: ctx.model,
      allowRootFallback: false,
    });
    if (resolved.facet !== null && addFacet(ctx, resolved.facet)) {
      placed.push({ agent, facet: resolved.facet });
    } else {
      missed.push({ agent, detail: resolved.detail });
      pushFreeText(ctx.freeText, f09Label, agent);
    }
  }

  return {
    placement: "agents",
    placed,
    missed,
  };
}

/** Shape stored on `covered` so input-vs-base does not re-emit fortification. */
function fortificationCovered(claim: FortificationClaim): Record<string, unknown> | null {
  if (claim.status === "none") return null;
  if (claim.status === "bare") {
    return { status: "bare", facet: `${F10}.${F10_FORTIFIED}` };
  }
  return { status: "agents", agents: claim.agents, header: F09 };
}

export interface GapOmitted {
  phrase: string;
  reason: string | null;
}

/** Phrases the input-gap model considered but chose not to keep. */
export function parseGapOmitted(content: unknown): GapOmitted[] {
  if (content === null || typeof content !== "object") return [];
  const raw = (content as { omitted?: unknown }).omitted;
  if (!Array.isArray(raw)) return [];
  const out: GapOmitted[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const phrase = item.trim();
      if (phrase !== "") out.push({ phrase, reason: null });
      continue;
    }
    if (item === null || typeof item !== "object") continue;
    const body = item as { phrase?: unknown; reason?: unknown };
    const phrase = typeof body.phrase === "string" ? body.phrase.trim() : "";
    if (phrase === "") continue;
    const reason =
      typeof body.reason === "string" && body.reason.trim() !== ""
        ? body.reason.trim()
        : null;
    out.push({ phrase, reason });
  }
  return out;
}

/** True when the description and base already share identical content words (name or alt). */
function foodMatchesBaseTerm(food: string, baseCode: string, baseName: string): boolean {
  if (sameContentTokenSet(food, baseName)) return true;
  return altNames(baseCode).some((alt) => sameContentTokenSet(food, alt));
}

function parseEssence(content: unknown): {
  definition: string | null;
  properties: GapProperty[];
} {
  if (content === null || typeof content !== "object") {
    return { definition: null, properties: [] };
  }
  const body = content as { definition?: unknown };
  const definition =
    typeof body.definition === "string" && body.definition.trim() !== ""
      ? body.definition.trim()
      : null;
  return { definition, properties: parseGapProperties(content) };
}

export function parseEssenceCover(content: unknown): Map<string, boolean> {
  const out = new Map<string, boolean>();
  if (content === null || typeof content !== "object") return out;
  const raw = (content as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(raw)) return out;
  for (const row of raw) {
    if (row === null || typeof row !== "object") continue;
    const id = (row as { id?: unknown }).id;
    const covered = (row as { covered?: unknown }).covered;
    if (typeof id !== "string" || id.trim() === "") continue;
    if (typeof covered !== "boolean") continue;
    out.set(id.trim(), covered);
  }
  return out;
}

type EssenceCoverDrop = {
  property: GapProperty;
  id: string;
  reason: "base_entailed";
};

/**
 * Drop essence properties the base name already entails; survivors go to place
 * (where implicits are applied code-to-code).
 */
async function coverEssenceProperties(
  ctx: PlaceContext,
  properties: GapProperty[]
): Promise<{
  kept: GapProperty[];
  dropped: EssenceCoverDrop[];
  model: string | null;
  asked: Array<{ id: string; phrase: string; kind: GapPropertyKind }>;
  verdicts: Array<{ id: string; covered: boolean }>;
}> {
  if (properties.length === 0) {
    return { kept: [], dropped: [], model: null, asked: [], verdicts: [] };
  }

  const indexed = properties.map((property, i) => ({
    id: String(i + 1),
    property,
  }));
  const asked = indexed.map(({ id, property }) => ({
    id,
    phrase: property.phrase,
    kind: property.kind,
  }));
  const answered = await chatJson({
    model: ctx.model,
    system: SYSTEM_ESSENCE_COVER,
    user: JSON.stringify(
      {
        baseTerm: { code: ctx.baseCode, name: ctx.baseName },
        properties: asked,
      },
      null,
      2
    ),
  });
  const byId = parseEssenceCover(answered.content);
  const dropped: EssenceCoverDrop[] = [];
  const kept: GapProperty[] = [];
  const verdicts: Array<{ id: string; covered: boolean }> = [];
  for (const { id, property } of indexed) {
    const covered = byId.get(id) === true;
    verdicts.push({ id, covered });
    if (covered) {
      dropped.push({ property, id, reason: "base_entailed" });
    } else {
      kept.push(property);
    }
  }
  return { kept, dropped, model: answered.model, asked, verdicts };
}

/**
 * Locate `name` as a contiguous case-insensitive substring of `input`.
 * Returns the span using the input's own characters. No fuzzy recovery.
 */
export function findDishSpan(
  input: string,
  name: string
): { start: number; end: number; span: string } | null {
  const needle = name.trim();
  if (needle === "") return null;
  const hay = input.toLowerCase();
  const idx = hay.indexOf(needle.toLowerCase());
  if (idx < 0) return null;
  const end = idx + needle.length;
  return { start: idx, end, span: input.slice(idx, end) };
}

/** Input-vs-base may only keep phrases whose content words appear in the input. */
function filterPropertiesToInput(
  properties: GapProperty[],
  input: string
): { kept: GapProperty[]; dropped: Array<{ phrase: string; kind: string; reason: string }> } {
  const kept: GapProperty[] = [];
  const dropped: Array<{ phrase: string; kind: string; reason: string }> = [];
  for (const property of properties) {
    if (input === "" || !queryTokensInText(property.phrase, input)) {
      dropped.push({ ...property, reason: "not_in_input" });
      continue;
    }
    kept.push(property);
  }
  return { kept, dropped };
}

function termTypeRank(termType: string | null | undefined): number {
  switch (termType) {
    case "r":
      return 0;
    case "d":
      return 1;
    case "s":
      return 2;
    case "c":
      return 3;
    default:
      return 4;
  }
}

/** Prefer core, then extended, over hierarchy/generic detail levels. */
function detailLevelRank(detailLevel: string | null | undefined): number {
  switch (detailLevel) {
    case "C":
      return 0;
    case "E":
      return 1;
    case "P":
      return 2;
    case "M":
      return 3;
    default:
      return 4;
  }
}

function queryTokensInText(query: string, text: string): boolean {
  const q = contentTokens(query);
  const n = contentTokens(text);
  if (q.size === 0) return false;
  for (const t of q) if (!n.has(t)) return false;
  return true;
}

/**
 * Content tokens of an F04 phrase (no curated process/link/form stripping —
 * claims should already be clean food words from gap/stated listing).
 */
function foodTokensForF04(phrase: string): Set<string> {
  return contentTokens(phrase);
}

function foodPhraseForF04(phrase: string): string {
  return [...foodTokensForF04(phrase)].join(" ");
}

/**
 * F04 alignment against an `ingred` term: identical content tokens, or every
 * content token of the phrase appears in the term name / alt.
 */
export function alignsComponentToFoodTerm(
  phrase: string,
  code: string,
  termName: string
): boolean {
  const foodPhrase = foodPhraseForF04(phrase);
  if (foodPhrase === "") return false;
  if (sameContentTokenSet(foodPhrase, termName)) return true;
  if (queryTokensInText(foodPhrase, termName)) return true;
  for (const alt of altNames(code)) {
    if (sameContentTokenSet(foodPhrase, alt)) return true;
    if (queryTokensInText(foodPhrase, alt)) return true;
  }
  return false;
}

function phraseMatchesTerm(phrase: string, code: string, termName: string): boolean {
  return alignsComponentToFoodTerm(phrase, code, termName);
}

function termExactFood(foodPhrase: string, code: string, termName: string): boolean {
  if (foodPhrase === "") return false;
  if (sameContentTokenSet(foodPhrase, termName)) return true;
  return altNames(code).some((alt) => sameContentTokenSet(foodPhrase, alt));
}

interface IngredHit {
  code: string;
  name: string;
  exact: boolean;
}

/**
 * Literal seeds on `ingred`: exact name/alt content-set first; else terms whose
 * name/alt covers every food token of the phrase (*chicken* ⊂ *Chicken fresh meat*).
 * Candidates come from lexical recall plus alias rows — preferred names alone are
 * often absent from search-names.json.
 */
function findLiteralIngredSeeds(cat: Catalogue, phrase: string): IngredHit[] {
  const foodPhrase = foodPhraseForF04(phrase);
  if (foodPhrase === "") return [];

  const exact: IngredHit[] = [];
  const partial: IngredHit[] = [];
  const seen = new Set<string>();

  const consider = (code: string, name: string): void => {
    if (seen.has(code) || !isIngredientDescriptor(cat, code)) return;
    seen.add(code);
    if (termExactFood(foodPhrase, code, name)) {
      exact.push({ code, name, exact: true });
      return;
    }
    const alts = altNames(code);
    if (
      queryTokensInText(foodPhrase, name) ||
      alts.some((alt) => queryTokensInText(foodPhrase, alt))
    ) {
      partial.push({ code, name, exact: false });
    }
  };

  for (const hit of searchTerms(foodPhrase, { limit: 40, underFood: true })) {
    consider(hit.code, cat.term(hit.code)?.name ?? hit.name);
  }
  for (const [code, alts] of cat.altNameEntries()) {
    if (seen.has(code) || !isIngredientDescriptor(cat, code)) continue;
    const name = cat.term(code)?.name ?? code;
    if (
      termExactFood(foodPhrase, code, name) ||
      queryTokensInText(foodPhrase, name) ||
      alts.some(
        (alt) =>
          sameContentTokenSet(foodPhrase, alt) || queryTokensInText(foodPhrase, alt)
      )
    ) {
      consider(code, name);
    }
  }

  return exact.length > 0 ? exact : partial;
}

/**
 * Walk down `ingred` from literal seeds: keep descendants that still cover the
 * food tokens (*chicken* → also *Chicken, minced meat*, then rank prefers muscle).
 */
function expandIngredDescendants(
  cat: Catalogue,
  phrase: string,
  seeds: IngredHit[]
): IngredHit[] {
  const foodPhrase = foodPhraseForF04(phrase);
  const byCode = new Map<string, IngredHit>();
  for (const seed of seeds) byCode.set(seed.code, seed);

  const queue = seeds.map((s) => s.code);
  const seen = new Set(queue);

  while (queue.length > 0) {
    const parent = queue.shift() as string;
    for (const child of cat.children(parent, INGRED_HIERARCHY)) {
      if (seen.has(child) || cat.isDeprecated(child)) continue;
      seen.add(child);
      if (!isIngredientDescriptor(cat, child)) continue;
      const term = cat.term(child);
      if (term === undefined) continue;
      const name = term.name ?? child;
      if (!alignsComponentToFoodTerm(phrase, child, name)) continue;
      const hit: IngredHit = {
        code: child,
        name,
        exact: termExactFood(foodPhrase, child, name),
      };
      byCode.set(child, hit);
      queue.push(child);
    }
  }

  return [...byCode.values()];
}

function underImpliedF04(cat: Catalogue, code: string, impliedF04: string[]): boolean {
  return impliedF04.some(
    (implied) => code === implied || cat.isAncestor(implied, code, INGRED_HIERARCHY)
  );
}

function rankIngredHits(
  cat: Catalogue,
  phrase: string,
  hits: IngredHit[],
  impliedF04: string[]
): IngredHit[] {
  return [...hits].sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;

    const aMatch = phraseMatchesTerm(phrase, a.code, a.name) ? 0 : 1;
    const bMatch = phraseMatchesTerm(phrase, b.code, b.name) ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;

    const aUnder = underImpliedF04(cat, a.code, impliedF04) ? 0 : 1;
    const bUnder = underImpliedF04(cat, b.code, impliedF04) ? 0 : 1;
    if (aUnder !== bUnder) return aUnder - bUnder;

    const aType = termTypeRank(cat.term(a.code)?.termType);
    const bType = termTypeRank(cat.term(b.code)?.termType);
    if (aType !== bType) return aType - bType;

    const aDetail = detailLevelRank(cat.term(a.code)?.detailLevel);
    const bDetail = detailLevelRank(cat.term(b.code)?.detailLevel);
    if (aDetail !== bDetail) return aDetail - bDetail;

    return a.name.length - b.name.length;
  });
}

const F04_PICK_LIMIT = 8;

/**
 * Search phrases for F04 recall: the full leftover, plus its last food token when
 * multi-word (*amarena cherries* also searches *cherries*) so cultivar names can
 * still reach the commodity branch the model may pick.
 */
function f04RecallQueries(phrase: string): string[] {
  const foodPhrase = foodPhraseForF04(phrase);
  if (foodPhrase === "") return [];
  const tokens = [...foodTokensForF04(phrase)];
  const out = [foodPhrase];
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1]!;
    if (last.length >= 3 && last !== foodPhrase) out.push(last);
  }
  return out;
}

function alignsToAnyF04Query(phrase: string, code: string, name: string): boolean {
  for (const query of f04RecallQueries(phrase)) {
    if (alignsComponentToFoodTerm(query, code, name)) return true;
  }
  return false;
}

/**
 * Add one level of `ingred` children that still align to a recall query so the
 * model can specify a parent (*Sour cherries* → light/dark red).
 */
function enrichWithIngredChildren(
  cat: Catalogue,
  phrase: string,
  hits: IngredHit[]
): IngredHit[] {
  const foodPhrase = foodPhraseForF04(phrase);
  const byCode = new Map(hits.map((h) => [h.code, h]));
  for (const hit of hits) {
    for (const child of cat.children(hit.code, INGRED_HIERARCHY)) {
      if (byCode.has(child) || cat.isDeprecated(child)) continue;
      if (!isIngredientDescriptor(cat, child)) continue;
      const term = cat.term(child);
      if (term === undefined) continue;
      const name = term.name ?? child;
      if (!alignsToAnyF04Query(phrase, child, name)) continue;
      byCode.set(child, {
        code: child,
        name,
        exact: termExactFood(foodPhrase, child, name),
      });
    }
  }
  return [...byCode.values()];
}

function recallIngredF04Once(
  cat: Catalogue,
  phrase: string,
  impliedF04: string[],
  options: AcceptFacetOptions
): IngredHit[] {
  const seeds = findLiteralIngredSeeds(cat, phrase);
  const pool = expandIngredDescendants(cat, phrase, seeds);
  return rankIngredHits(cat, phrase, pool, impliedF04).filter(
    (hit) => acceptF04Descriptor(cat, hit.code, impliedF04, options) === "keep"
  );
}

/**
 * F04 recall: literal hit on `ingred` (name/alt), walk descendants that still
 * cover the food tokens, accept-filter and rank. Multi-word leftovers also
 * recall from the head food token; top hits keep aligning children so the model
 * can specify. Does not choose — selection is `resolveF04Phrase`.
 */
export function recallIngredF04(
  cat: Catalogue,
  phrase: string,
  impliedF04: string[] = [],
  options: AcceptFacetOptions = {}
): IngredHit[] {
  const foodPhrase = foodPhraseForF04(phrase);
  const byCode = new Map<string, IngredHit>();
  for (const query of f04RecallQueries(phrase)) {
    for (const hit of recallIngredF04Once(cat, query, impliedF04, options)) {
      const name = cat.term(hit.code)?.name ?? hit.name;
      const exact = termExactFood(foodPhrase, hit.code, name);
      const prev = byCode.get(hit.code);
      if (prev === undefined || (exact && !prev.exact)) {
        byCode.set(hit.code, { code: hit.code, name, exact });
      }
    }
  }
  const top = rankIngredHits(cat, phrase, [...byCode.values()], impliedF04).slice(
    0,
    F04_PICK_LIMIT
  );
  const enriched = enrichWithIngredChildren(cat, phrase, top).filter(
    (hit) => acceptF04Descriptor(cat, hit.code, impliedF04, options) === "keep"
  );
  const topCodes = new Set(top.map((h) => h.code));
  const extras = rankIngredHits(
    cat,
    phrase,
    enriched.filter((h) => !topCodes.has(h.code)),
    impliedF04
  );
  return [...top, ...extras];
}

async function resolveF04Phrase(
  ctx: PlaceContext,
  phrase: string,
  options: AcceptFacetOptions = {}
): Promise<{ facet: FacetDescriptorRef | null; detail: Record<string, unknown> }> {
  const acceptOpts: AcceptFacetOptions = {
    baseCode: ctx.baseCode,
    baseTermType: ctx.baseTermType,
    phrase,
    ...options,
  };
  const candidates = recallIngredF04(ctx.cat, phrase, ctx.impliedF04, acceptOpts);
  const seeds = findLiteralIngredSeeds(ctx.cat, phrase);

  if (candidates.length === 0) {
    return {
      facet: null,
      detail: {
        phrase,
        header: F04,
        resolved: null,
        via: "ingred_recall_empty",
        seedCount: seeds.length,
        poolSize: 0,
        ...(options.rejectUnderImplied === true
          ? { rejectUnderImplied: true }
          : {}),
      },
    };
  }

  // Identical wording to a preferred name / alt — same decisiveness as base lexical accept.
  const exact = candidates.find((c) => c.exact);
  if (exact !== undefined && candidates.filter((c) => c.exact).length === 1) {
    const name = ctx.cat.term(exact.code)?.name ?? exact.name;
    return {
      facet: { header: F04, code: exact.code, name },
      detail: {
        phrase,
        header: F04,
        resolved: exact.code,
        name,
        verdict: "keep",
        via: "ingred_exact",
        seedCount: seeds.length,
        poolSize: candidates.length,
      },
    };
  }

  const allowed = new Set(candidates.map((c) => c.code));
  const payload = {
    phrase,
    candidates: candidates.map((c) => {
      const term = ctx.cat.term(c.code);
      const alts = altNames(c.code);
      return {
        code: c.code,
        name: term?.name ?? c.name,
        ...(alts.length > 0 ? { alts } : {}),
        ...(term?.scopeNote ? { scopeNote: term.scopeNote } : {}),
      };
    }),
  };

  const picked = await chatJson({
    model: ctx.model,
    system: SYSTEM_F04_PICK,
    user: JSON.stringify(payload, null, 2),
  });
  const code = pickAllowedCode(picked.content, allowed);
  if (code === null) {
    return {
      facet: null,
      detail: {
        phrase,
        header: F04,
        resolved: null,
        via: "ingred_model",
        model: picked.model,
        seedCount: seeds.length,
        poolSize: candidates.length,
        candidates: candidates.map((c) => ({
          code: c.code,
          name: ctx.cat.term(c.code)?.name ?? c.name,
          exact: c.exact,
        })),
      },
    };
  }

  const name = ctx.cat.term(code)?.name ?? code;
  return {
    facet: { header: F04, code, name },
    detail: {
      phrase,
      header: F04,
      resolved: code,
      name,
      verdict: "keep",
      via: "ingred_model",
      model: picked.model,
      seedCount: seeds.length,
      poolSize: candidates.length,
      candidates: candidates.map((c) => ({
        code: c.code,
        name: ctx.cat.term(c.code)?.name ?? c.name,
        exact: c.exact,
      })),
    },
  };
}

/** Surface forms to search: canned ↔ canning, dried ↔ drying. */
function searchVariants(phrase: string): string[] {
  const p = phrase.trim().toLowerCase();
  if (p === "") return [];
  const out = new Set<string>([p]);
  if (p.endsWith("ed") && p.length > 3) out.add(`${p.slice(0, -2)}ing`);
  if (p.endsWith("ing") && p.length > 4) out.add(`${p.slice(0, -3)}ed`);
  return [...out];
}

function gatherClosedHits(phrase: string, header: string): LexHit[] {
  const byCode = new Map<string, LexHit>();
  for (const variant of searchVariants(phrase)) {
    for (const hit of searchTerms(variant, {
      limit: 20,
      descriptorsOnly: true,
      facetCategory: header,
    })) {
      const prev = byCode.get(hit.code);
      if (prev === undefined || hit.score > prev.score) {
        byCode.set(hit.code, hit);
      }
    }
  }
  return [...byCode.values()];
}

/** Phrase tokens equal name tokens, ignoring order ("Juice, orange"). */
function closedExactName(phrase: string, code: string, termName: string): boolean {
  if (sameContentTokenSet(phrase, termName)) return true;
  return altNames(code).some((alt) => sameContentTokenSet(phrase, alt));
}

/** Phrase tokens all appear in the name ("organic" ⊂ "Organic production"). */
function closedNameContainsPhrase(phrase: string, code: string, termName: string): boolean {
  if (queryTokensInText(phrase, termName)) return true;
  return altNames(code).some((alt) => queryTokensInText(phrase, alt));
}

/**
 * Extra name tokens that only qualify an origin label ("Camel (as animal)"),
 * not a different head noun ("Butter nut").
 */
function originQualifierOnly(phrase: string, termName: string): boolean {
  if (!queryTokensInText(phrase, termName)) return false;
  const q = contentTokens(phrase);
  const extras = [...contentTokens(termName)].filter((t) => !q.has(t));
  if (extras.length === 0) return true;
  const qualifiers = new Set(["animal", "plant", "spp"]);
  return extras.every((t) => qualifiers.has(t));
}

/**
 * Closed-facet alignment. Non-origin closed headers allow a phrase inside the
 * descriptor name (*organic* ⊂ *Organic production*). F01/F27 require an exact
 * name, a specify-the-generic narrowing of an implied descriptor, or an origin
 * qualifier form — not "butter" ⊂ "Butter nut".
 */
function closedAligned(
  phrase: string,
  hit: LexHit,
  cat: Catalogue,
  header: string,
  implied: Set<string>
): boolean {
  for (const variant of searchVariants(phrase)) {
    if (closedExactName(variant, hit.code, hit.name)) return true;
    if (!closedNameContainsPhrase(variant, hit.code, hit.name)) continue;
    if (header !== F01 && header !== F27) return true;
    if (narrowerThanImplied(cat, header, hit.code, implied)) return true;
    if (originQualifierOnly(variant, hit.name)) return true;
    if (altNames(hit.code).some((alt) => originQualifierOnly(variant, alt))) return true;
  }
  return false;
}

function rankClosedHits(
  cat: Catalogue,
  phrase: string,
  header: string,
  implied: Set<string>,
  hits: LexHit[]
): LexHit[] {
  return [...hits].sort((a, b) => {
    const aExact = searchVariants(phrase).some((v) => sameContentTokenSet(v, a.name)) ? 0 : 1;
    const bExact = searchVariants(phrase).some((v) => sameContentTokenSet(v, b.name)) ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;

    const aNarrow = narrowerThanImplied(cat, header, a.code, implied) ? 0 : 1;
    const bNarrow = narrowerThanImplied(cat, header, b.code, implied) ? 0 : 1;
    if (aNarrow !== bNarrow) return aNarrow - bNarrow;

    const aIn = closedAligned(phrase, a, cat, header, implied) ? 0 : 1;
    const bIn = closedAligned(phrase, b, cat, header, implied) ? 0 : 1;
    if (aIn !== bIn) return aIn - bIn;
    if (b.score !== a.score) return b.score - a.score;
    return a.name.length - b.name.length;
  });
}

function facetRootChildren(cat: Catalogue, header: string): LexHit[] {
  const hierarchy = cat.facetCategory(header)?.hierarchyCode;
  if (hierarchy === undefined) return [];
  const out: LexHit[] = [];
  for (const code of cat.children("root", hierarchy)) {
    if (cat.isDeprecated(code)) continue;
    if (!cat.belongsTo(code, hierarchy)) continue;
    const name = cat.term(code)?.name ?? code;
    out.push({ code, name, score: 0 });
  }
  return out;
}

/**
 * Candidate pool for closed-tree model pick when lexical alignment is absent or ambiguous.
 * Prefer accepted aligned hits; else (F28/F21 only) accepted ranked lexical hits or root children.
 * Origin trees (F01/F27) never fall back to weak lexical hits — miss instead of "Butter nut".
 */
export function buildClosedPickPool(
  cat: Catalogue,
  phrase: string,
  header: string,
  implied: Set<string>,
  options: {
    allowRootFallback?: boolean;
    limit?: number;
    /** Extra candidates (e.g. embedding tips) merged into the shortlist. */
    seedHits?: LexHit[];
    rejectUnderImplied?: boolean;
  } = {}
): { alignedAccepted: LexHit[]; pool: LexHit[]; ranked: LexHit[] } {
  const limit = options.limit ?? 8;
  const acceptOpts = { rejectUnderImplied: options.rejectUnderImplied };
  const ranked = rankClosedHits(cat, phrase, header, implied, gatherClosedHits(phrase, header));
  const seedHits = options.seedHits ?? [];
  const alignedAccepted = ranked.filter(
    (h) =>
      closedAligned(phrase, h, cat, header, implied) &&
      acceptClosedDescriptor(cat, header, h.code, implied, acceptOpts) === "keep"
  );
  if (alignedAccepted.length > 0) {
    const seedAccepted = seedHits.filter(
      (h) => acceptClosedDescriptor(cat, header, h.code, implied, acceptOpts) === "keep"
    );
    const merged: LexHit[] = [];
    const seen = new Set<string>();
    for (const hit of [...alignedAccepted, ...seedAccepted]) {
      if (seen.has(hit.code)) continue;
      seen.add(hit.code);
      merged.push(hit);
    }
    return { alignedAccepted, pool: merged.slice(0, limit), ranked };
  }

  // Origin: aligned or nothing (no Butter-nut-from-butter lexical shortlist).
  if (header === F01 || header === F27) {
    return { alignedAccepted, pool: [], ranked };
  }

  const lexicalAccepted = ranked.filter(
    (h) => acceptClosedDescriptor(cat, header, h.code, implied, acceptOpts) === "keep"
  );
  const seedAccepted = seedHits.filter(
    (h) => acceptClosedDescriptor(cat, header, h.code, implied, acceptOpts) === "keep"
  );
  const merged: LexHit[] = [];
  const seen = new Set<string>();
  for (const hit of [...seedAccepted, ...lexicalAccepted]) {
    if (seen.has(hit.code)) continue;
    seen.add(hit.code);
    merged.push(hit);
  }
  if (merged.length > 0) {
    return { alignedAccepted, pool: merged.slice(0, limit), ranked };
  }

  if (options.allowRootFallback) {
    const roots = facetRootChildren(cat, header).filter(
      (h) => acceptClosedDescriptor(cat, header, h.code, implied, acceptOpts) === "keep"
    );
    return { alignedAccepted, pool: roots.slice(0, limit), ranked };
  }

  return { alignedAccepted, pool: [], ranked };
}

async function modelPickClosedDescriptor(
  cat: Catalogue,
  phrase: string,
  header: string,
  candidates: LexHit[],
  model: string
): Promise<{ code: string | null; model: string; detail: Record<string, unknown> }> {
  const allowed = new Set(candidates.map((c) => c.code));
  const payload = {
    phrase,
    candidates: candidates.map((c) => {
      const term = cat.term(c.code);
      const alts = altNames(c.code);
      return {
        code: c.code,
        name: term?.name ?? c.name,
        ...(alts.length > 0 ? { alts } : {}),
        ...(term?.scopeNote ? { scopeNote: term.scopeNote } : {}),
      };
    }),
  };
  const picked = await chatJson({
    model,
    system: SYSTEM_CLOSED_PICK,
    user: JSON.stringify(payload, null, 2),
  });
  const code = pickAllowedCode(picked.content, allowed);
  return {
    code,
    model: picked.model,
    detail: {
      phrase,
      header,
      via: "closed_model_pick",
      candidates: candidates.map((c) => ({ code: c.code, name: c.name })),
      picked: code,
    },
  };
}

function closedFacetResult(
  cat: Catalogue,
  header: string,
  phrase: string,
  hit: LexHit,
  extra: Record<string, unknown> = {}
): { facet: FacetDescriptorRef; detail: Record<string, unknown> } {
  const name = cat.term(hit.code)?.name ?? hit.name;
  return {
    facet: { header, code: hit.code, name },
    detail: { phrase, header, resolved: hit.code, name, verdict: "keep", ...extra },
  };
}

/**
 * Closed facet place: lexical first; model pick among the shortlist when aligned is
 * empty or ambiguous. Root-children fallback only for F28/F21.
 */
async function resolveClosedFacetPhrase(
  cat: Catalogue,
  phrase: string,
  header: string,
  implied: Set<string>,
  options: {
    model?: string;
    allowRootFallback?: boolean;
    seedHits?: LexHit[];
    rejectUnderImplied?: boolean;
  } = {}
): Promise<{ facet: FacetDescriptorRef | null; detail: Record<string, unknown> }> {
  const allowRootFallback =
    options.allowRootFallback ?? (header === F28 || header === F21);
  const { alignedAccepted, pool, ranked } = buildClosedPickPool(
    cat,
    phrase,
    header,
    implied,
    {
      allowRootFallback,
      seedHits: options.seedHits,
      rejectUnderImplied: options.rejectUnderImplied,
    }
  );

  // Unique exact lexical hit — no model call. Partial name containment
  // (*chocolate* ⊂ *Chocolate coating*) still needs a model refuse/accept.
  if (alignedAccepted.length === 1) {
    const only = alignedAccepted[0]!;
    const exact = searchVariants(phrase).some((v) =>
      closedExactName(v, only.code, only.name)
    );
    if (exact) {
      return closedFacetResult(cat, header, phrase, only);
    }
  }

  // Ambiguous aligned set, unique partial, or weak/no alignment — model pick.
  const pickPool = pool.length > 0 ? pool : alignedAccepted;
  if (pickPool.length > 0 && options.model !== undefined && options.model.trim() !== "") {
    const picked = await modelPickClosedDescriptor(
      cat,
      phrase,
      header,
      pickPool,
      options.model
    );
    if (picked.code !== null) {
      const hit = pickPool.find((c) => c.code === picked.code) ?? {
        code: picked.code,
        name: cat.term(picked.code)?.name ?? picked.code,
        score: 0,
      };
      return closedFacetResult(cat, header, phrase, hit, {
        via: "closed_model_pick",
        model: picked.model,
        candidates: pickPool.map((c) => ({ code: c.code, name: c.name })),
      });
    }
    return {
      facet: null,
      detail: {
        ...picked.detail,
        resolved: null,
        ranked: ranked.slice(0, 5).map((h) => ({ code: h.code, name: h.name })),
      },
    };
  }

  if (alignedAccepted.length > 0) {
    const only = alignedAccepted[0]!;
    const exact = searchVariants(phrase).some((v) =>
      closedExactName(v, only.code, only.name)
    );
    if (exact || alignedAccepted.length > 1) {
      return closedFacetResult(cat, header, phrase, only);
    }
  }

  return {
    facet: null,
    detail: {
      phrase,
      header,
      resolved: null,
      hits: ranked.slice(0, 5).map((h) => ({ code: h.code, name: h.name })),
    },
  };
}

function facetCardinality(cat: Catalogue, header: string): "single" | "repeatable" {
  const card = cat.facetCategory(header)?.cardinality;
  return card === "single" ? "single" : "repeatable";
}

function hierarchyDepth(cat: Catalogue, header: string, code: string): number {
  const hierarchy = cat.facetCategory(header)?.hierarchyCode;
  if (hierarchy === undefined) return 0;
  let depth = 0;
  let current: string | null = code;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    current = cat.parent(current, hierarchy);
    if (current !== null) depth += 1;
  }
  return depth;
}

/** Higher = keep when a single-cardinality header has several candidates. */
function compareFacetInformativeness(
  cat: Catalogue,
  header: string,
  a: FacetDescriptorRef,
  b: FacetDescriptorRef,
  implied: Set<string>
): number {
  const aNarrow = narrowerThanImplied(cat, header, a.code, implied) ? 1 : 0;
  const bNarrow = narrowerThanImplied(cat, header, b.code, implied) ? 1 : 0;
  if (aNarrow !== bNarrow) return bNarrow - aNarrow;
  const aDepth = hierarchyDepth(cat, header, a.code);
  const bDepth = hierarchyDepth(cat, header, b.code);
  if (aDepth !== bDepth) return bDepth - aDepth;
  return a.name.length - b.name.length;
}

function acceptPlacedFacet(
  cat: Catalogue,
  facet: FacetDescriptorRef,
  implied: Set<string>,
  impliedF04: string[],
  options: AcceptFacetOptions
): "keep" | string {
  if (facet.header === F04) {
    return acceptF04Descriptor(cat, facet.code, impliedF04, options);
  }
  return acceptClosedDescriptor(cat, facet.header, facet.code, implied, options);
}

export interface CleanupDrop {
  facet: FacetDescriptorRef;
  reason: string;
}

/**
 * Post-place cleanup: implicits rule, drop broader-than-sibling within a header,
 * and for single-cardinality headers keep the most informative descriptor.
 */
export function cleanupFacets(
  cat: Catalogue,
  facets: FacetDescriptorRef[],
  implied: Set<string>,
  options: AcceptFacetOptions = {}
): { facets: FacetDescriptorRef[]; dropped: CleanupDrop[] } {
  const impliedF04 = [...implied]
    .filter((key) => key.startsWith(`${F04}.`))
    .map((key) => key.slice(F04.length + 1));
  const dropped: CleanupDrop[] = [];

  let kept: FacetDescriptorRef[] = [];
  for (const facet of facets) {
    const verdict = acceptPlacedFacet(cat, facet, implied, impliedF04, options);
    if (verdict !== "keep") {
      dropped.push({ facet, reason: verdict });
      continue;
    }
    kept.push(facet);
  }

  kept = kept.filter((facet) => {
    const hierarchy = cat.facetCategory(facet.header)?.hierarchyCode;
    if (hierarchy === undefined) return true;
    const broaderThanAdded = kept.some(
      (other) =>
        other.header === facet.header &&
        other.code !== facet.code &&
        cat.isAncestor(facet.code, other.code, hierarchy)
    );
    if (broaderThanAdded) {
      dropped.push({ facet, reason: "broader_than_added" });
      return false;
    }
    return true;
  });

  const byHeader = new Map<string, FacetDescriptorRef[]>();
  for (const facet of kept) {
    const group = byHeader.get(facet.header) ?? [];
    group.push(facet);
    byHeader.set(facet.header, group);
  }

  const out: FacetDescriptorRef[] = [];
  for (const [header, group] of byHeader) {
    if (facetCardinality(cat, header) === "single" && group.length > 1) {
      const ranked = [...group].sort((a, b) =>
        compareFacetInformativeness(cat, header, a, b, implied)
      );
      const winner = ranked[0]!;
      out.push(winner);
      for (const extra of ranked.slice(1)) {
        dropped.push({ facet: extra, reason: "cardinality_single" });
      }
    } else {
      out.push(...group);
    }
  }

  return { facets: out, dropped };
}

function addFacet(ctx: PlaceContext, facet: FacetDescriptorRef): boolean {
  const key = `${facet.header}.${facet.code}`;
  if (ctx.seenCodes.has(key)) return false;
  if (
    facetCardinality(ctx.cat, facet.header) === "single" &&
    ctx.singleHeaders.has(facet.header)
  ) {
    return false;
  }
  ctx.seenCodes.add(key);
  if (facetCardinality(ctx.cat, facet.header) === "single") {
    ctx.singleHeaders.add(facet.header);
  }
  ctx.facets.push(facet);
  return true;
}

function pushFreeText(entries: FreeTextEntry[], label: string, value: string): void {
  const lab = label.trim() || "note";
  const val = value.trim();
  if (val === "") return;
  const valNorm = val.toLowerCase();
  if (entries.some((e) => e.value.trim().toLowerCase() === valNorm)) return;
  if (entries.some((e) => e.label === lab && e.value === val)) return;
  entries.push({ label: lab, value: val });
}

/**
 * Place a kind-tagged property (no cross-kind fall-through).
 * ingredient/source: origin role → F01 / F27 / F04.
 * process: F28.
 * side: free text only (no plate-companion facet in MTX).
 * other: Facets (A0B8V) dimension pick → closed place in that header only.
 * onMiss: essence drops (dish= covers identity); input vs base → free text.
 */
async function placeByKind(
  ctx: PlaceContext,
  property: GapProperty,
  onMiss: "freeText" | "drop" = "freeText"
): Promise<Record<string, unknown>> {
  const { phrase, kind } = property;
  const attempts: Record<string, unknown>[] = [];
  /** Essence / name meaning: F04 uses specify-vs-restate under an implied parent.
   * Origin trees (F01/F27) must still allow naming a child organism/commodity
   * under a broad implied source (deer under mammals-as-animal). */
  const rejectUnderImplied = onMiss === "drop";

  if (kind === "side") {
    if (onMiss === "drop") {
      return { phrase, kind, placed: "dropped", attempts };
    }
    const value = phrase.replace(/^(with|and)\s+/i, "").trim() || phrase;
    pushFreeText(ctx.freeText, "side", value);
    return {
      phrase,
      kind,
      placed: "freeText",
      freeText: { label: "side", value },
      attempts,
    };
  }

  let originRole: OriginRole | null = null;
  let otherLabel: string | null = null;

  if (kind === "ingredient" || kind === "source") {
    const { roles, detail } = await originRolesFor(ctx, phrase);
    attempts.push(detail);
    originRole = roles[0] ?? null;

    for (const role of roles) {
      const resolved =
        role === "contains"
          ? await resolveF04Phrase(ctx, phrase, { rejectUnderImplied })
          : await resolveClosedFacetPhrase(
              ctx.cat,
              phrase,
              role === "organism" ? F01 : F27,
              ctx.implied,
              { model: ctx.model, allowRootFallback: false }
            );
      attempts.push(resolved.detail);
      if (resolved.facet !== null && addFacet(ctx, resolved.facet)) {
        return {
          phrase,
          kind,
          originRole: role,
          placed: "facet",
          facet: resolved.facet,
          attempts,
        };
      }
    }
  } else if (kind === "process") {
    const dimensions = facetDimensions(ctx.cat);
    const embeddingTips = await gatherFacetEmbeddingTips(ctx.cat, phrase, dimensions, 15);
    const seedHits: LexHit[] = embeddingTips
      .filter((t) => t.header === F28)
      .map((t) => ({
        code: t.descriptorCode,
        name: t.descriptorName,
        score: t.similarity,
      }));
    const process = await resolveClosedFacetPhrase(ctx.cat, phrase, F28, ctx.implied, {
      model: ctx.model,
      allowRootFallback: false,
      seedHits,
      rejectUnderImplied,
    });
    attempts.push(process.detail);
    if (process.facet !== null && addFacet(ctx, process.facet)) {
      return { phrase, kind, placed: "facet", facet: process.facet, attempts };
    }
  } else if (kind === "other") {
    const dimensions = facetDimensions(ctx.cat);
    const embeddingTips = await gatherFacetEmbeddingTips(ctx.cat, phrase, dimensions);
    const asked = await askFacetDimension(ctx, phrase, dimensions, embeddingTips);
    attempts.push(asked.detail);
    for (const dimension of asked.dimensions) {
      otherLabel = ctx.cat.facetCategory(dimension.header)?.label ?? dimension.name;
      const seedHits: LexHit[] = embeddingTips
        .filter((t) => t.header === dimension.header)
        .map((t) => ({
          code: t.descriptorCode,
          name: t.descriptorName,
          score: t.similarity,
        }));
      const placed = await resolveClosedFacetPhrase(
        ctx.cat,
        phrase,
        dimension.header,
        ctx.implied,
        {
          model: ctx.model,
          allowRootFallback: false,
          seedHits,
          rejectUnderImplied,
        }
      );
      attempts.push(placed.detail);
      if (placed.facet !== null && addFacet(ctx, placed.facet)) {
        return {
          phrase,
          kind,
          dimension: dimension.name,
          header: dimension.header,
          placed: "facet",
          facet: placed.facet,
          attempts,
        };
      }
    }
  }

  if (onMiss === "drop") {
    return { phrase, kind, ...(originRole !== null ? { originRole } : {}), placed: "dropped", attempts };
  }

  const label = freeTextLabelForOriginRole(originRole, kind, otherLabel);
  pushFreeText(ctx.freeText, label, phrase);
  return {
    phrase,
    kind,
    ...(originRole !== null ? { originRole } : {}),
    ...(otherLabel !== null ? { dimensionLabel: otherLabel } : {}),
    placed: "freeText",
    freeText: { label, value: phrase },
    attempts,
  };
}

/**
 * Direct expo children of a base (sibling candidates for F26 Other).
 */
export function siblingChildrenForF26(
  cat: Catalogue,
  baseCode: string
): Array<{ code: string; name: string }> {
  const out: Array<{ code: string; name: string }> = [];
  for (const code of cat.children(baseCode, DEFAULT_HIERARCHY)) {
    if (cat.isDeprecated(code)) continue;
    const name = cat.term(code)?.name ?? code;
    out.push({ code, name });
  }
  return out;
}

/**
 * F26 Unspecified when the locked base is a hierarchy term.
 */
export function chooseF26Unspecified(
  cat: Catalogue,
  baseCode: string
): FacetDescriptorRef | null {
  const term = cat.term(baseCode);
  if (term === undefined) return null;
  const implied = impliedKeys(cat, baseCode);
  if ([...implied].some((key) => key.startsWith(`${F26}.`))) return null;
  if (term.detailLevel !== "H") return null;
  return {
    header: F26,
    code: F26_UNSPECIFIED,
    name: cat.term(F26_UNSPECIFIED)?.name ?? "Unspecified",
  };
}

function parseF26OtherVerdict(content: unknown): "yes" | "no" {
  if (content === null || typeof content !== "object") return "no";
  const raw = (content as { verdict?: unknown }).verdict;
  if (typeof raw !== "string") return "no";
  // F26 Other means a missing sibling — only "sibling" qualifies. A parent is
  // already covered by the base; a relative is SKOS-related, not a missing leaf.
  return raw.trim().toLowerCase() === "sibling" ? "yes" : "no";
}

/**
 * F26 Other when fit is broad and the model judges a missing natural sibling.
 */
export async function chooseF26Other(
  cat: Catalogue,
  input: string,
  baseCode: string,
  options: { model: string; fit?: SelectFit | null }
): Promise<{ facet: FacetDescriptorRef | null; detail: Record<string, unknown> }> {
  const implied = impliedKeys(cat, baseCode);
  if ([...implied].some((key) => key.startsWith(`${F26}.`))) {
    return { facet: null, detail: { reason: "already_implied" } };
  }
  if (options.fit !== "broad") {
    return { facet: null, detail: { reason: "fit_not_broad", fit: options.fit ?? null } };
  }
  if (cat.term(baseCode)?.detailLevel === "H") {
    return { facet: null, detail: { reason: "hierarchy_uses_unspecified" } };
  }

  const siblings = siblingChildrenForF26(cat, baseCode);
  if (siblings.length === 0) {
    return { facet: null, detail: { reason: "no_siblings" } };
  }

  const picked = await chatJson({
    model: options.model,
    system: promptF26Other(input, siblings.map((s) => s.name)),
    user: input,
  });
  const verdict = parseF26OtherVerdict(picked.content);
  const detail = {
    model: picked.model,
    verdict,
    siblingCount: siblings.length,
  };
  if (verdict !== "yes") {
    return { facet: null, detail };
  }
  return {
    facet: {
      header: F26,
      code: F26_OTHER,
      name: cat.term(F26_OTHER)?.name ?? "Other",
    },
    detail,
  };
}

async function finishResiduals(
  ctx: PlaceContext,
  audit: AuditEntry[],
  extra: Record<string, unknown> = {}
): Promise<AssignResidualsOk> {
  // Same-nature mix: the generic base is intentional (§3.1.10); F26 Other would
  // mis-flag it as a missing sibling.
  if (ctx.descriptionKind === "mix") {
    audit.push({
      step: "residuals_f26",
      detail: {
        skipped: "mix",
        applied: false,
        facet: null,
        fit: ctx.fit,
      },
    });
  } else {
    const unspecified = chooseF26Unspecified(ctx.cat, ctx.baseCode);
    if (unspecified !== null) {
      const added = addFacet(ctx, unspecified);
      audit.push({
        step: "residuals_f26",
        detail: {
          kind: "unspecified",
          applied: added,
          facet: unspecified,
          fit: ctx.fit,
          baseDetailLevel: ctx.cat.term(ctx.baseCode)?.detailLevel ?? null,
        },
      });
    } else {
      const other = await chooseF26Other(ctx.cat, ctx.input, ctx.baseCode, {
        model: ctx.model,
        fit: ctx.fit,
      });
      audit.push({
        step: "residuals_f26",
        detail: {
          kind: "other",
          ...other.detail,
          applied: other.facet !== null,
          facet: other.facet,
          fit: ctx.fit,
        },
      });
      if (other.facet !== null) {
        addFacet(ctx, other.facet);
      }
    }
  }

  const cleaned = cleanupFacets(ctx.cat, ctx.facets, ctx.implied, {
    baseCode: ctx.baseCode,
    baseTermType: ctx.baseTermType,
  });
  if (cleaned.dropped.length > 0) {
    audit.push({
      step: "residuals_cleanup",
      detail: {
        dropped: cleaned.dropped.map((d) => ({
          header: d.facet.header,
          code: d.facet.code,
          name: d.facet.name,
          reason: d.reason,
        })),
        kept: cleaned.facets.map((f) => ({
          header: f.header,
          code: f.code,
          name: f.name,
        })),
      },
    });
  }

  const sorted = sortFacets(cleaned.facets);
  const freeTextOut = ctx.freeText.length > 0 ? ctx.freeText : null;
  const code = formatFoodEx2Code(ctx.baseCode, sorted);
  audit.push({
    step: "residuals_place",
    detail: {
      ...extra,
      facets: sorted,
      freeText: freeTextOut,
      code,
    },
  });
  return { status: "ok", facets: sorted, freeText: freeTextOut, code, audit };
}

function impliedNamed(cat: Catalogue, baseCode: string): Array<{ key: string; name: string }> {
  return cat.impliedFacets(baseCode).map((key) => {
    const code = key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
    return { key, name: cat.term(code)?.name ?? code };
  });
}

export async function assignResiduals(
  input: string,
  baseTerm: BaseTermRef,
  options: AssignResidualsOptions = {}
): Promise<AssignResidualsResult> {
  const cat = Catalogue.load();
  const audit: AuditEntry[] = [];
  const model = options.model?.trim() || defaultModel();
  const implied = impliedKeys(cat, baseTerm.code);
  const impliedF04 = impliedF04Codes(cat, baseTerm.code);
  const implicits = impliedNamed(cat, baseTerm.code);

  const ctx: PlaceContext = {
    cat,
    baseCode: baseTerm.code,
    baseName: cat.term(baseTerm.code)?.name ?? baseTerm.code,
    baseTermType: cat.term(baseTerm.code)?.termType ?? null,
    descriptionKind: options.descriptionKind ?? null,
    implied,
    impliedF04,
    facets: [],
    freeText: [],
    seenCodes: new Set(),
    singleHeaders: new Set(),
    model,
    input,
    fit: options.fit ?? null,
    fortificationClaim: { status: "none" },
  };

  // --- 0. Fortification (before any ingredient/source placement) ---
  const { claim: fortificationClaim, detail: fortificationDetect } =
    await askFortification(ctx, input);
  ctx.fortificationClaim = fortificationClaim;
  const fortificationPlace = await applyFortification(ctx, fortificationClaim);
  audit.push({
    step: "residuals_fortification",
    detail: { ...fortificationDetect, ...fortificationPlace },
  });
  const fortificationCover = fortificationCovered(fortificationClaim);

  // --- 1. Unstated essence (dish / dish type from route) ---
  const descriptionKind = ctx.descriptionKind;
  const essenceKinds = descriptionKind === "dish" || descriptionKind === "dish_type";

  /** Dish / dish_type only: grounded span for essence + dish= identity. */
  let definingSpan: { start: number; end: number; span: string } | null = null;

  if (!essenceKinds) {
    const nameMeaning =
      descriptionKind === "foodstuff" && options.fit === "broad";

    if (!nameMeaning) {
      audit.push({
        step: "residuals_essence",
        detail: {
          skipped:
            descriptionKind === null
              ? "no_route_kind"
              : descriptionKind === "foodstuff"
                ? "fit_not_broad"
                : "not_dish_kind",
          descriptionKind,
          fit: options.fit ?? null,
        },
      });
    } else {
      const foodName = (options.food?.trim() || input).trim();
      const defined = await chatJson({
        model,
        system: SYSTEM_NAME_MEANING,
        user: JSON.stringify(
          {
            name: foodName,
            baseTerm: { code: baseTerm.code, name: baseTerm.name },
            implicits,
            covered: {
              facets: ctx.facets.map((f) => ({
                header: f.header,
                code: f.code,
                name: f.name,
              })),
              ...(fortificationCover !== null ? { fortification: fortificationCover } : {}),
            },
          },
          null,
          2
        ),
      });
      const meaning = parseEssence(defined.content);
      const meaningFiltered = dropFortificationRestatements(
        meaning.properties,
        ctx.fortificationClaim
      );
      audit.push({
        step: "residuals_name_meaning",
        detail: {
          model: defined.model,
          name: foodName,
          definition: meaning.definition,
          properties: meaningFiltered.kept,
          fit: options.fit,
          ...(meaningFiltered.dropped.length > 0
            ? { droppedFortification: meaningFiltered.dropped }
            : {}),
        },
      });

      const meaningResolutions = [];
      for (const property of meaningFiltered.kept) {
        meaningResolutions.push(await placeByKind(ctx, property, "drop"));
      }
      audit.push({
        step: "residuals_place",
        detail: {
          from: "name_meaning",
          resolutions: meaningResolutions,
          facets: [...ctx.facets],
          freeText: [...ctx.freeText],
        },
      });
    }
  } else {
    const dishPhrase = (options.food?.trim() || input).trim();
    const span = findDishSpan(input, dishPhrase);
    if (span === null) {
      audit.push({
        step: "residuals_essence_ungrounded",
        detail: {
          reason: "name_not_in_input",
          name: dishPhrase,
          descriptionKind,
        },
      });
      return {
        status: "rejected",
        reason: "named_dish_ungrounded",
        message: `Dish name ${JSON.stringify(dishPhrase)} is not a substring of the input`,
        audit,
      };
    }

    definingSpan = span;
    const dishName = span.span;
    audit.push({
      step: "residuals_essence_span",
      detail: {
        descriptionKind,
        name: dishPhrase,
        span: dishName,
        start: span.start,
        end: span.end,
      },
    });

    const defined = await chatJson({
      model,
      system: SYSTEM_ESSENCE,
      user: JSON.stringify({ name: dishName }, null, 2),
    });
    const essence = parseEssence(defined.content);
    audit.push({
      step: "residuals_essence_define",
      detail: {
        model: defined.model,
        name: dishName,
        definition: essence.definition,
        properties: essence.properties,
      },
    });

    const essenceResolutions = [];
    if (essence.properties.length > 0) {
      const covered = await coverEssenceProperties(ctx, essence.properties);
      audit.push({
        step: "residuals_essence_cover",
        detail: {
          model: covered.model,
          asked: covered.asked,
          verdicts: covered.verdicts,
          dropped: covered.dropped.map((d) => ({
            id: d.id,
            phrase: d.property.phrase,
            kind: d.property.kind,
            reason: d.reason,
          })),
          kept: covered.kept,
        },
      });
      for (const property of dropFortificationRestatements(
        covered.kept,
        ctx.fortificationClaim
      ).kept) {
        essenceResolutions.push(await placeByKind(ctx, property, "drop"));
      }
    }
    if (!foodMatchesBaseTerm(dishName, baseTerm.code, baseTerm.name)) {
      pushFreeText(ctx.freeText, "dish", dishName);
    }
    audit.push({
      step: "residuals_place",
      detail: {
        from: "essence",
        resolutions: essenceResolutions,
        facets: [...ctx.facets],
        freeText: [...ctx.freeText],
      },
    });
  }

  // --- 2. Input vs base ---
  // Always the full input. Covered (facets + free text from step 1) dedupes
  // essence / name-meaning claims; dish= identity does not hide modifiers.
  const gapInput = input;

  if (gapInput.trim() === "") {
    audit.push({
      step: "residuals_input",
      detail: { skipped: "empty_gap_input", properties: [] },
    });
    return await finishResiduals(ctx, audit, { from: "input", resolutions: [] });
  }

  if (foodMatchesBaseTerm(gapInput, baseTerm.code, baseTerm.name)) {
    audit.push({
      step: "residuals_input",
      detail: { skipped: "identical_wording", properties: [] },
    });
    return await finishResiduals(ctx, audit, { from: "input", resolutions: [] });
  }

  const covered = {
    facets: ctx.facets.map((f) => ({
      header: f.header,
      code: f.code,
      name: f.name,
    })),
    freeText: [...ctx.freeText],
    ...(fortificationCover !== null ? { fortification: fortificationCover } : {}),
  };

  const allowSide = sideAllowedForKind(descriptionKind);
  const listed = await chatJson({
    model,
    system: systemInputVsBase(allowSide),
    user: JSON.stringify(
      {
        input: gapInput,
        ...(definingSpan !== null ? { dishSpan: definingSpan.span } : {}),
        baseTerm: { code: baseTerm.code, name: baseTerm.name },
        implicits,
        covered,
        ...(descriptionKind !== null ? { descriptionKind } : {}),
      },
      null,
      2
    ),
  });
  const listedRaw = parseGapProperties(listed.content);
  const omitted = parseGapOmitted(listed.content);
  const forFilter = allowSide
    ? listedRaw
    : listedRaw.map((p) =>
        p.kind === "side" ? { ...p, kind: "ingredient" as const } : p
      );
  const { kept: inInput, dropped } = filterPropertiesToInput(forFilter, gapInput);
  const fortDrop = dropFortificationRestatements(inInput, ctx.fortificationClaim);
  const properties = fortDrop.kept;
  const droppedAll = [
    ...dropped,
    ...fortDrop.dropped.map((p) => ({
      phrase: p.phrase,
      kind: p.kind,
      reason: "fortification_already_placed",
    })),
  ];
  audit.push({
    step: "residuals_input",
    detail: {
      model: listed.model,
      gapInput,
      properties,
      ...(omitted.length > 0 ? { omitted } : {}),
      ...(allowSide ? {} : { sideKind: "disallowed" }),
      ...(listedRaw.some((p) => p.kind === "side") && !allowSide
        ? {
            remappedSideToIngredient: listedRaw
              .filter((p) => p.kind === "side")
              .map((p) => p.phrase),
          }
        : {}),
      ...(droppedAll.length > 0 ? { dropped: droppedAll, raw: listedRaw } : {}),
    },
  });

  const inputResolutions = [];
  for (const property of properties) {
    inputResolutions.push(await placeByKind(ctx, property));
  }
  return await finishResiduals(ctx, audit, { from: "input", resolutions: inputResolutions });
}
