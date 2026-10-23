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
 * 1d. Numeric content — fat % (F07) / alcohol % v/v (F11): model reports values;
 *     code snaps to the nearest catalogue bucket. Soft claims without a number
 *     are left for later residual passes.
 * 2. Input vs base — what the input still expresses; covered includes step 1.
 *    Outside dishes (and in 1b), leftovers are unsorted: one facet pick per
 *    phrase over the Facets dimensions (excl. F07/F09/F11/F26, owned by earlier
 *    steps) plus two origin options, every pick placed. Origin options use the
 *    origin route: `made_from` → F01/F27 (F04 on a composite), `added` → F04.
 *    Dishes keep ingredient/source/side kinds: `side` → free text;
 *    ingredient/source → origin role → F01/F27/F04 (`mix` on an RPC/derivative
 *    base prefers F27 over F01); `process` → F28; `other` → top-down Facets
 *    walk. F04 is also a top-down walk of `ingred`. Mix skips F26.
 * 3. F26 Generic-term — its own step after placement (chooseF26): Other when the
 *    input is a missing sibling of the base's children, else Unspecified on an
 *    H/M/P base.
 * For dish/dish_type, defining span is for essence grounding + dish= identity;
 * step 2 always sees the full input (attributes in the dish wording stay claimable).
 * Other route kinds: wording denseness goes through input vs base like any leftover.
 * Both channels use the same property shape and placeByKind (no cross-kind fall-through).
 * Essence / name meaning (`onMiss: drop`) may specify a child under an implied F04
 * when the phrase names that child (beef under mammals meat); it drops generic
 * restatements (eggs under Whole eggs → not Hen eggs). Input-vs-base may still
 * narrow freely.
 */

import { searchTerms, type SearchCandidate } from "../search/lexical.js";
import { pickAllowedCode } from "./answers.js";
import {
  openFacetDimensions,
  pickFacets,
  resolveFacetWalk,
  type FacetPickExtra,
} from "./facet-walk.js";
import {
  dropNumericRestatements,
  nearestAlcoholFacet,
  nearestFatFacet,
  numericContentCovered,
  parseNumericContent,
  type NumericContentClaim,
} from "./numeric-facets.js";
import type {
  AuditEntry,
  BaseTermRef,
  DescriptionKind,
  FacetDescriptorRef,
  FreeTextEntry,
  SelectFit,
} from "./types.js";
import { Catalogue, DEFAULT_HIERARCHY } from "../catalogue.js";
import { cardinalityKey, impliedRelation } from "../rules/index.js";
import { catalogueLookup } from "../rules/catalogue-lookup.js";
import { chatJson, defaultModel } from "../llm.js";
import { contentTokens, FUNCTION_WORDS, sameContentTokenSet } from "../search/content-match.js";
import { formatFoodEx2Code, sortFacets } from "./foodex2-code.js";
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
 * sources (F01). Returned in try-order.
 *
 * On a raw commodity or derivative, F04 is only for minor ingredients
 * (§3.1.9, §5.14.9), so it follows the prescribed origin as a fallback for an
 * `ingredient` property only. A `source` property states what the food is or
 * comes from; F04 for it is the error §5.14.9 lists ("to specify a source not
 * implicitly included in a specific base term"), so it gets the prescribed
 * origin alone and a miss goes to free text. Composites keep F04: there it is
 * the prescribed origin. Null when the type does not settle it (broad, natural
 * source, unknown) and the model must be asked.
 *
 * `made_from` behaves like `source`. An `added` property is something put into
 * the food, never its origin, so it is an ingredient (F04): characterising on a
 * composite, minor on a raw commodity or derivative (§3.1.9, §5.13). In a
 * same-nature mix, what is put in is a component (almonds in mixed nuts), so it
 * tries F27 first and keeps F04 as the fallback for a true minor ingredient.
 */
export function originRolesForBaseType(
  baseTermType: string | null,
  descriptionKind: DescriptionKind | null = null,
  propertyKind: GapPropertyKind | null = null
): OriginRole[] | null {
  const withFallback = (prescribed: OriginRole): OriginRole[] =>
    propertyKind === "source" || propertyKind === "made_from"
      ? [prescribed]
      : [prescribed, "contains"];
  if (
    descriptionKind === "mix" &&
    (baseTermType === "r" || baseTermType === "d")
  ) {
    return withFallback("made_from");
  }
  if (propertyKind === "added") return ["contains"];
  switch (baseTermType) {
    case "r":
      return withFallback("organism");
    case "d":
      return withFallback("made_from");
    case "s":
    case "c":
      return ["contains"];
    default:
      return null;
  }
}

/**
 * A category is an aggregate term. Wording that says which foods it includes
 * (*peas*, *lentils* in *dry peas and lentils*; *fresh and frozen*) holds for
 * some members, not all. FoodEx2 has no code for "one of these": F01 holds one
 * organism, several F27 read as a mixture, and F04 is not for raw commodities
 * (§5.14.9). Members therefore go to free text, with no lookup.
 */
export function isCategoryMember(
  descriptionKind: DescriptionKind | null,
  propertyKind: GapPropertyKind
): boolean {
  return (
    propertyKind === "member" ||
    (descriptionKind === "category" &&
      (propertyKind === "source" || propertyKind === "made_from"))
  );
}

/**
 * Term types a descriptor may have to specify the members of a `category`.
 * A category of raw commodities (*Pulses*) names raw commodities (*dry peas*,
 * *lentils*), so an organism (*Garden pea (as plant)*, type `n`) cannot specify
 * a member. Null: no constraint (every other kind, and bases whose members'
 * type is not settled).
 */
export function memberTermTypes(
  descriptionKind: DescriptionKind | null,
  baseTermType: string | null
): ReadonlySet<string> | null {
  if (descriptionKind === "category" && baseTermType === "r") return new Set(["r"]);
  return null;
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
 * Origin options offered to the facet picker beside the Facets dimensions; each
 * code is the property kind whose origin route places it.
 */
const ORIGIN_PICKS: FacetPickExtra[] = [
  {
    code: "made_from",
    name: "Source or source-commodity: the plant, animal or commodity this food is, or is made from",
  },
  { code: "added", name: "Ingredient: a food or substance added to this food" },
];

/**
 * Foodstuff common-name meaning when the locked base is only a broader shelf.
 * Properties are unsorted: the facet picker decides where each goes.
 * Miss → drop (world knowledge, not input parse).
 */
const SYSTEM_NAME_MEANING = `You are a food and nutrition ontology expert.

You are given a food name and the locked catalogue base term (a broader shelf that does not fully name that food).

State briefly what the name conventionally means. Imagine the densest catalogue-style name for that meaning. List only characterising properties that denser name would carry beyond the locked base: for each, the \`phrase\` it comes from and, as \`name\`, a short catalogue-style name of the food, organism, substance, treatment or attribute it states.

Give more than one property for a phrase only when the phrase itself states more than one.

If the base already covers the name, return an empty property list.
Do not list properties already captured in \`covered\`.

Reply with JSON only:
{"definition":"<text>","properties":[{"phrase":"<text>","name":"<text>"},...]}
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

/**
 * Stated fat % / alcohol % v/v — asked early so later residual passes do not
 * place the same wording via F10 soft claims or a facet walk of F07/F11.
 * Soft labels without a number (low fat, alcohol free) stay null here.
 */
const SYSTEM_NUMERIC_CONTENT = `You are a food and nutrition ontology expert.

Does this food description state a fat percentage and/or an alcohol-by-volume percentage?

If a fat percentage is stated, set fatPercent to that number (ranges → midpoint).
If an alcohol-by-volume percentage is stated (including ABV or "% volume" on drinks), set alcoholPercent similarly.
If only a soft claim is present with no number (low fat, alcohol free, …), leave that field null.
If neither percentage is stated, both fields are null.

Reply with JSON only:
{"fatPercent":<number>|null,"alcoholPercent":<number>|null}
`;

/** Detected fortification claim; facet placement comes in a later step. */
export type FortificationClaim =
  | { status: "none" }
  | { status: "bare" }
  | { status: "agents"; agents: string[] };

/** Input vs locked base → kind-tagged properties not yet captured. */
export function systemInputVsBase(allowSide: boolean): string {
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

List only additional properties asserted by input that are not already represented by \`baseTerm\`, \`implicits\`, or \`covered\`. Omit wording that do not materially change the food. For each kept property: a short \`phrase\` and a \`kind\`. Put omitted candidates in \`omitted\` with a short \`reason\` so the omission is explicit.

Kinds:
${kinds}

If nothing is left to keep, return an empty properties list.

Reply with JSON only:
{"properties":[{"phrase":"<text>","kind":${kindEnum}},...],"omitted":[{"phrase":"<text>","reason":"<text>"},...]}
`;
}

/**
 * Input vs locked base for anything but a dish. Leftovers are unsorted: the
 * facet picker decides which facets each phrase speaks to, so one phrase can
 * carry several (in sunflower oil → surrounding medium and ingredient). Dishes
 * keep `systemInputVsBase`: there the base type already sends constituents to
 * F04, and relation wording made the model re-describe parts (fries → fried).
 */
export function systemInputRelations(descriptionKind: DescriptionKind | null = null): string {
  const aggregate = descriptionKind === "category";
  const group = aggregate
    ? "\n`input` is an aggregate term: it names a group of foods, not one food. A property is something every food in the group has; mark wording that says which foods the group includes with `\"kind\":\"member\"`.\n"
    : "";
  const shape = aggregate
    ? '{"phrase":"<text>","name":"<text>","kind":"member"?}'
    : '{"phrase":"<text>","name":"<text>"}';
  return `You are a food and nutrition ontology expert.

You are given a food description (\`input\`) and what is already captured (\`baseTerm\`, \`implicits\`, \`covered\`).
${group}
First, list what the input says about the food that is not already represented by \`baseTerm\`, \`implicits\`, or \`covered\`. Omit wording that does not materially change the food. Put omitted candidates in \`omitted\` with a short \`reason\`.

Then, state each as a property of this food: the \`phrase\` from the input and, as \`name\`, a short catalogue-style name of the food, organism, substance, treatment or attribute it states.

Give more than one property for a phrase only when the phrase itself states more than one.

If nothing is left to keep, return an empty properties list.

Reply with JSON only:
{"properties":[${shape},...],"omitted":[{"phrase":"<text>","reason":"<text>"},...]}
`;
}

function sideAllowedForKind(descriptionKind: DescriptionKind | null): boolean {
  return descriptionKind === "dish" || descriptionKind === "dish_type";
}

/** Residual property kinds; each has exactly one placement route (see placeByKind). */
export type GapPropertyKind =
  | "ingredient"
  | "source"
  | "made_from"
  | "added"
  | "process"
  | "side"
  | "member"
  | "other"
  /** Not sorted by the listing model; the facet picker decides (non-dish channels). */
  | "unsorted";

export interface GapProperty {
  /** Wording from the input (or the name's meaning) the property comes from. */
  phrase: string;
  kind: GapPropertyKind;
  /** Catalogue-style name to look up; the phrase when the model gave none. */
  name?: string;
}

const GAP_KINDS = new Set<GapPropertyKind>([
  "ingredient",
  "source",
  "made_from",
  "added",
  "process",
  "side",
  "member",
  "other",
]);

/** Closed-facet pick (F01/F27/F09/…): same thing as a candidate, or null. */
const SYSTEM_CLOSED_PICK = `You are a food and nutrition ontology expert.

Does the phrase mean the same thing as one of the candidates?

Candidates may include codingGuidance: catalogue instructions for when to use or not use that descriptor, and sometimes how it trades off against other facets. It is not a definition of the phrase or of the food. Use it only to decide whether that candidate is the right code for the phrase.

If yes, return that candidate's code. Prefer a more specific candidate when the phrase still means the same thing; do not pick a candidate that adds detail the phrase does not support.
If none, return null.

Reply with JSON only:
{"code":"<CODE>"|null}
`;

/**
 * F26: how the input relates to the base's direct children. The answer decides
 * Other vs Unspecified in code (see decideF26); the model does not pick F26.
 */
const SYSTEM_F26_RELATION = `You are a food and nutrition ontology expert.

You are given a food description (\`input\`), the catalogue term chosen for it (\`baseTerm\`), and the terms directly under that term (\`children\`).

First, consider what food \`input\` identifies.

Then, consider what kinds of \`baseTerm\` the children are.

Then, decide how \`input\` relates to the children:
- "same" — it is the same food as one of the children
- "within" — it is a kind of one of the children
- "sibling" — it is another kind of \`baseTerm\`, at the same level as the children, that none of them covers
- "parent" — it covers several of the children, or is no narrower than \`baseTerm\`
- "none" — none of these

Reply with JSON only:
{"relation":"same"|"within"|"sibling"|"parent"|"none"}
`;

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
   * `mix` places components as F27 on an RPC/derivative base and skips F26.
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
  /** Term types an origin descriptor may have (category members); null = any. */
  memberTypes: ReadonlySet<string> | null;
  implied: Set<string>;
  impliedF04: string[];
  facets: FacetDescriptorRef[];
  freeText: FreeTextEntry[];
  seenCodes: Set<string>;
  /** Cardinality keys already filled (see rules `cardinalityKey`). */
  limitedSlots: Set<string>;
  model: string;
  input: string;
  fit: SelectFit | null;
  /** Step 0 claim; later leftover phrases that restate it are not placed again. */
  fortificationClaim: FortificationClaim;
  /** Step 0b claim; quantitative fat/alcohol % restatements are not placed again. */
  numericClaim: NumericContentClaim;
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
  phrase: string,
  kind: GapPropertyKind
): Promise<{ roles: OriginRole[]; detail: Record<string, unknown> }> {
  const fixed = originRolesForBaseType(ctx.baseTermType, ctx.descriptionKind, kind);
  if (fixed !== null) {
    return {
      roles: fixed,
      detail: {
        via: "origin_role",
        phrase,
        kind,
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
  if (kind === "ingredient" || kind === "added") return "ingredient";
  if (kind === "source" || kind === "made_from") return "source";
  if (kind === "process") return "process";
  if (
    (kind === "other" || kind === "unsorted") &&
    otherLabel !== undefined &&
    otherLabel !== null &&
    otherLabel.trim() !== ""
  ) {
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
):
  | "keep"
  | "restate"
  | "broader"
  | "already_implied"
  | "contradicts_implied"
  | "not_descriptor" {
  const relation = impliedRelation(catalogueLookup(cat), header, code, [...implied]);
  if (relation === "repeats") return "restate";

  const hierarchy = cat.facetCategory(header)?.hierarchyCode;
  if (hierarchy === undefined || !cat.belongsTo(code, hierarchy) || cat.isDeprecated(code)) {
    return "not_descriptor";
  }

  if (relation === "broader") return "broader";
  if (relation === "contradicts") return "contradicts_implied";
  if (options.rejectUnderImplied === true && relation === "narrower") return "already_implied";
  return "keep";
}

/** True when code is a proper descendant of an implied descriptor of the same header. */
function narrowerThanImplied(
  cat: Catalogue,
  header: string,
  code: string,
  implied: Set<string>
): boolean {
  return impliedRelation(catalogueLookup(cat), header, code, [...implied]) === "narrower";
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
    const body = item as { phrase?: unknown; kind?: unknown; name?: unknown };
    const phrase = typeof body.phrase === "string" ? body.phrase.trim() : "";
    if (phrase === "") continue;
    const kindRaw = typeof body.kind === "string" ? body.kind.trim().toLowerCase() : "";
    const kind = GAP_KINDS.has(kindRaw as GapPropertyKind)
      ? (kindRaw as GapPropertyKind)
      : "other";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    out.push(name !== "" && name !== phrase ? { phrase, kind, name } : { phrase, kind });
  }
  return out;
}

/** Non-dish channels: every property but a category member goes to the facet picker. */
export function asUnsorted(properties: GapProperty[]): GapProperty[] {
  return properties.map((p) => (p.kind === "member" ? p : { ...p, kind: "unsorted" }));
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

async function askNumericContent(
  ctx: PlaceContext,
  foodDescription: string
): Promise<{ claim: NumericContentClaim; detail: Record<string, unknown> }> {
  const answered = await chatJson({
    model: ctx.model,
    system: SYSTEM_NUMERIC_CONTENT,
    user: JSON.stringify(
      {
        input: foodDescription,
        baseTerm: { code: ctx.baseCode, name: ctx.baseName },
      },
      null,
      2
    ),
  });
  const claim = parseNumericContent(answered.content);
  return {
    claim,
    detail: {
      via: "numeric_content",
      model: answered.model,
      claim,
    },
  };
}

async function applyNumericContent(
  ctx: PlaceContext,
  claim: NumericContentClaim
): Promise<Record<string, unknown>> {
  const placed: FacetDescriptorRef[] = [];
  const missed: Array<{ kind: "fat" | "alcohol"; value: number; reason: string }> = [];

  if (claim.fatPercent !== null) {
    const facet = nearestFatFacet(ctx.cat, claim.fatPercent);
    if (
      facet !== null &&
      acceptClosedDescriptor(ctx.cat, facet.header, facet.code, ctx.implied) === "keep" &&
      addFacet(ctx, facet)
    ) {
      placed.push(facet);
    } else {
      missed.push({
        kind: "fat",
        value: claim.fatPercent,
        reason: facet === null ? "no_bucket" : "not_accepted",
      });
      pushFreeText(ctx.freeText, "fat-content", `${claim.fatPercent}% fat`);
    }
  }

  if (claim.alcoholPercent !== null) {
    const facet = nearestAlcoholFacet(ctx.cat, claim.alcoholPercent);
    if (
      facet !== null &&
      acceptClosedDescriptor(ctx.cat, facet.header, facet.code, ctx.implied) === "keep" &&
      addFacet(ctx, facet)
    ) {
      placed.push(facet);
    } else {
      missed.push({
        kind: "alcohol",
        value: claim.alcoholPercent,
        reason: facet === null ? "no_bucket" : "not_accepted",
      });
      pushFreeText(ctx.freeText, "alcohol-content", `${claim.alcoholPercent}% alcohol`);
    }
  }

  return {
    placement: placed.length > 0 || missed.length > 0 ? "numeric" : "none",
    placed,
    missed,
  };
}

/** Drop leftovers already owned by fortification or numeric early placement. */
function dropEarlyClaimRestatements(
  properties: GapProperty[],
  fortification: FortificationClaim,
  numeric: NumericContentClaim
): { kept: GapProperty[]; dropped: GapProperty[] } {
  const fort = dropFortificationRestatements(properties, fortification);
  const num = dropNumericRestatements(fort.kept, numeric);
  return { kept: num.kept, dropped: [...fort.dropped, ...num.dropped] };
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
  const accept = (_header: string, code: string): boolean =>
    acceptF04Descriptor(ctx.cat, code, ctx.impliedF04, acceptOpts) === "keep" &&
    (ctx.memberTypes === null || ctx.memberTypes.has(ctx.cat.term(code)?.termType ?? ""));
  const seeds = recallIngredF04(ctx.cat, phrase, ctx.impliedF04, acceptOpts)
    .slice(0, F04_PICK_LIMIT)
    .map((hit) => ({ header: F04, code: hit.code }));
  const walked = await resolveFacetWalk(ctx.cat, phrase, [F04], {
    model: ctx.model,
    accept,
    food: { input: ctx.input, baseTerm: ctx.baseName },
    seeds,
  });
  return {
    facet: walked.facet,
    detail: {
      ...walked.detail,
      ...(options.rejectUnderImplied === true ? { rejectUnderImplied: true } : {}),
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
 * not a different head noun ("Butter nut"). Function words in the label
 * ("as") are scaffolding, not a second head.
 */
function originQualifierOnly(phrase: string, termName: string): boolean {
  if (!queryTokensInText(phrase, termName)) return false;
  const q = contentTokens(phrase);
  const extras = [...contentTokens(termName)].filter((t) => !q.has(t));
  if (extras.length === 0) return true;
  const qualifiers = new Set(["animal", "plant", "spp"]);
  return extras.every((t) => qualifiers.has(t) || FUNCTION_WORDS.has(t));
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
    /** Only descriptors of these term types (category members); undefined = any. */
    termTypes?: ReadonlySet<string> | null;
  } = {}
): { alignedAccepted: LexHit[]; pool: LexHit[]; ranked: LexHit[] } {
  const limit = options.limit ?? 8;
  const acceptOpts = { rejectUnderImplied: options.rejectUnderImplied };
  const typeOk = (h: LexHit): boolean =>
    options.termTypes == null || options.termTypes.has(cat.term(h.code)?.termType ?? "");
  const ranked = rankClosedHits(
    cat,
    phrase,
    header,
    implied,
    gatherClosedHits(phrase, header)
  ).filter(typeOk);
  const seedHits = (options.seedHits ?? []).filter(typeOk);
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
        ...(term?.scopeNote?.trim()
          ? { codingGuidance: term.scopeNote.trim() }
          : {}),
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
    termTypes?: ReadonlySet<string> | null;
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
      termTypes: options.termTypes,
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

  const lookup = catalogueLookup(cat);
  const bySlot = new Map<string, FacetDescriptorRef[]>();
  for (const facet of kept) {
    const slot =
      cardinalityKey(lookup, facet.header, facet.code) ?? `${facet.header}.${facet.code}`;
    const group = bySlot.get(slot) ?? [];
    group.push(facet);
    bySlot.set(slot, group);
  }

  const out: FacetDescriptorRef[] = [];
  for (const group of bySlot.values()) {
    if (group.length > 1) {
      const header = group[0]!.header;
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
  const slot = cardinalityKey(catalogueLookup(ctx.cat), facet.header, facet.code);
  if (slot !== null && ctx.limitedSlots.has(slot)) return false;
  ctx.seenCodes.add(key);
  if (slot !== null) ctx.limitedSlots.add(slot);
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

/** Origin route: base type (or the model) orders F01 / F27 / F04; the first role that places wins. */
async function placeOrigin(
  ctx: PlaceContext,
  lookup: string,
  kind: GapPropertyKind,
  rejectUnderImplied: boolean,
  attempts: Record<string, unknown>[]
): Promise<{ facet: FacetDescriptorRef | null; role: OriginRole | null }> {
  const { roles, detail } = await originRolesFor(ctx, lookup, kind);
  attempts.push(detail);
  for (const role of roles) {
    const resolved =
      role === "contains"
        ? await resolveF04Phrase(ctx, lookup, { rejectUnderImplied })
        : await resolveClosedFacetPhrase(
            ctx.cat,
            lookup,
            role === "organism" ? F01 : F27,
            ctx.implied,
            { model: ctx.model, allowRootFallback: false, termTypes: ctx.memberTypes }
          );
    attempts.push(resolved.detail);
    if (resolved.facet !== null && addFacet(ctx, resolved.facet)) {
      return { facet: resolved.facet, role };
    }
  }
  return { facet: null, role: roles[0] ?? null };
}

/**
 * Place a kind-tagged property (no cross-kind fall-through).
 * unsorted: facet picker → every picked facet placed (origin picks via the
 * origin route with the catalogue-style `name`; Facets dimensions walked with
 * the input phrase).
 * ingredient/source/made_from: origin role → F01 / F27 / F04.
 * added: F04 only.
 * Lookups use the property's catalogue-style `name` when the model gave one.
 * process: F28 Facets walk.
 * side: free text only (no plate-companion facet in MTX).
 * other: Facets dimension open → walk selected headers (excl. F07/F09/F11/F26).
 * onMiss: essence drops (dish= covers identity); input vs base → free text.
 */
async function placeByKind(
  ctx: PlaceContext,
  property: GapProperty,
  onMiss: "freeText" | "drop" = "freeText"
): Promise<Record<string, unknown>> {
  const { phrase, kind } = property;
  const lookup = property.name ?? phrase;
  const food = { input: ctx.input, baseTerm: ctx.baseName };
  const attempts: Record<string, unknown>[] = [];
  /** Essence / name meaning: F04 uses specify-vs-restate under an implied parent.
   * Origin trees (F01/F27) must still allow naming a child organism/commodity
   * under a broad implied source (deer under mammals-as-animal). */
  const rejectUnderImplied = onMiss === "drop";
  const walkAccept = (header: string, code: string): boolean =>
    acceptClosedDescriptor(ctx.cat, header, code, ctx.implied, {
      rejectUnderImplied,
    }) === "keep";

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

  if (isCategoryMember(ctx.descriptionKind, kind)) {
    if (onMiss === "drop") {
      return { phrase, kind, placed: "dropped", reason: "category_member", attempts };
    }
    pushFreeText(ctx.freeText, "member", phrase);
    return {
      phrase,
      kind,
      placed: "freeText",
      reason: "category_member",
      freeText: { label: "member", value: phrase },
      attempts,
    };
  }

  if (kind === "unsorted") {
    const picked = await pickFacets(ctx.cat, phrase, facetDimensions(ctx.cat), ORIGIN_PICKS, {
      model: ctx.model,
      accept: walkAccept,
      food,
    });
    attempts.push(picked.detail);
    const placed: FacetDescriptorRef[] = [];
    let member = false;
    for (const code of picked.codes) {
      if (code === "made_from" || code === "added") {
        if (isCategoryMember(ctx.descriptionKind, code)) {
          member = true;
          continue;
        }
        const origin = await placeOrigin(ctx, lookup, code, rejectUnderImplied, attempts);
        originRole ??= origin.role;
        if (origin.facet !== null) placed.push(origin.facet);
        continue;
      }
      const walked = await resolveFacetWalk(ctx.cat, phrase, [code], {
        model: ctx.model,
        accept: walkAccept,
        food,
      });
      attempts.push(walked.detail);
      if (walked.facet !== null && addFacet(ctx, walked.facet)) placed.push(walked.facet);
    }
    if (placed.length > 0) {
      return {
        phrase,
        kind,
        placed: "facet",
        facet: placed[0],
        facets: placed,
        attempts,
      };
    }
    if (member) {
      if (onMiss === "drop") {
        return { phrase, kind, placed: "dropped", reason: "category_member", attempts };
      }
      pushFreeText(ctx.freeText, "member", phrase);
      return {
        phrase,
        kind,
        placed: "freeText",
        reason: "category_member",
        freeText: { label: "member", value: phrase },
        attempts,
      };
    }
    const walkedHeaders = picked.codes.filter((c) => c !== "made_from" && c !== "added");
    if (originRole === null && walkedHeaders.length === 1) {
      otherLabel = ctx.cat.facetCategory(walkedHeaders[0]!)?.label ?? walkedHeaders[0]!;
    }
  } else if (kind === "ingredient" || kind === "source" || kind === "made_from" || kind === "added") {
    const origin = await placeOrigin(ctx, lookup, kind, rejectUnderImplied, attempts);
    originRole = origin.role;
    if (origin.facet !== null) {
      return {
        phrase,
        kind,
        originRole: origin.role,
        placed: "facet",
        facet: origin.facet,
        attempts,
      };
    }
  } else if (kind === "process") {
    const process = await resolveFacetWalk(ctx.cat, lookup, [F28], {
      model: ctx.model,
      accept: walkAccept,
      food,
    });
    attempts.push(process.detail);
    if (process.facet !== null && addFacet(ctx, process.facet)) {
      return { phrase, kind, placed: "facet", facet: process.facet, attempts };
    }
  } else if (kind === "other") {
    const dimensions = facetDimensions(ctx.cat);
    const opened = await openFacetDimensions(ctx.cat, lookup, dimensions, {
      model: ctx.model,
      accept: walkAccept,
      food,
    });
    attempts.push(opened.detail);
    const walked = await resolveFacetWalk(ctx.cat, lookup, opened.headers, {
      model: ctx.model,
      accept: walkAccept,
      food,
    });
    attempts.push(walked.detail);
    if (walked.facet !== null && addFacet(ctx, walked.facet)) {
      otherLabel =
        ctx.cat.facetCategory(walked.facet.header)?.label ?? walked.facet.header;
      return {
        phrase,
        kind,
        header: walked.facet.header,
        placed: "facet",
        facet: walked.facet,
        attempts,
      };
    }
    if (opened.headers.length === 1) {
      otherLabel =
        ctx.cat.facetCategory(opened.headers[0]!)?.label ?? opened.headers[0]!;
    }
  }

  if (onMiss === "drop") {
    return { phrase, kind, ...(originRole !== null ? { originRole } : {}), placed: "dropped", attempts };
  }

  const label = freeTextLabelForOriginRole(originRole, kind, otherLabel);
  pushFreeText(ctx.freeText, label, lookup);
  return {
    phrase,
    kind,
    ...(property.name !== undefined ? { name: property.name } : {}),
    ...(originRole !== null ? { originRole } : {}),
    ...(otherLabel !== null ? { dimensionLabel: otherLabel } : {}),
    placed: "freeText",
    freeText: { label, value: lookup },
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

/** How the input relates to the base's children (SYSTEM_F26_RELATION). */
export type F26Relation = "same" | "within" | "sibling" | "parent" | "none";

const F26_RELATIONS = new Set<F26Relation>(["same", "within", "sibling", "parent", "none"]);

/** Detail levels above core/extended: the base itself is a broad group. */
const F26_BROAD_LEVELS = new Set(["H", "M", "P"]);

export function parseF26Relation(content: unknown): F26Relation | null {
  if (content === null || typeof content !== "object") return null;
  const raw = (content as { relation?: unknown }).relation;
  if (typeof raw !== "string") return null;
  const relation = raw.trim().toLowerCase() as F26Relation;
  return F26_RELATIONS.has(relation) ? relation : null;
}

export type F26Decision =
  | { kind: "other" }
  | { kind: "unspecified" }
  | { kind: "none"; reason: string };

/**
 * Other and Unspecified are exclusive (F26 is single cardinality); Other is
 * decided first.
 *
 * - Other: the input names another kind of the base that no child covers.
 * - Unspecified: the base is a broad group (H/M/P) and the input does not name
 *   anything narrower. We only land on a broad group when the input is that
 *   vague, so detail level settles it once Other is ruled out.
 * - same/within: a child fits, so the base should have gone lower; neither
 *   descriptor describes that (a selection miss, visible in the audit).
 * - No children: no more detailed item exists to be missing or unknown.
 */
export function decideF26(
  hasChildren: boolean,
  baseDetailLevel: string | null,
  relation: F26Relation | null
): F26Decision {
  if (!hasChildren) return { kind: "none", reason: "no_children" };
  if (relation === "sibling") return { kind: "other" };
  if (relation === "same" || relation === "within") {
    return { kind: "none", reason: `child_fits_${relation}` };
  }
  if (baseDetailLevel !== null && F26_BROAD_LEVELS.has(baseDetailLevel)) {
    return { kind: "unspecified" };
  }
  return { kind: "none", reason: "base_core_or_extended" };
}

/** F26 for the locked base: one relation call, then decideF26. */
export async function chooseF26(
  cat: Catalogue,
  input: string,
  baseCode: string,
  options: { model: string }
): Promise<{ facet: FacetDescriptorRef | null; detail: Record<string, unknown> }> {
  if ([...impliedKeys(cat, baseCode)].some((key) => key.startsWith(`${F26}.`))) {
    return { facet: null, detail: { reason: "already_implied" } };
  }
  const baseTerm = cat.term(baseCode);
  const baseDetailLevel = baseTerm?.detailLevel ?? null;
  const children = siblingChildrenForF26(cat, baseCode);

  let relation: F26Relation | null = null;
  let model: string | undefined;
  if (children.length > 0) {
    const answered = await chatJson({
      model: options.model,
      system: SYSTEM_F26_RELATION,
      user: JSON.stringify(
        {
          input,
          baseTerm: baseTerm?.name ?? baseCode,
          children: children.map((c) => c.name),
        },
        null,
        2
      ),
    });
    relation = parseF26Relation(answered.content);
    model = answered.model;
  }

  const decision = decideF26(children.length > 0, baseDetailLevel, relation);
  const detail = {
    ...(model !== undefined ? { model } : {}),
    relation,
    childCount: children.length,
    baseDetailLevel,
    decision: decision.kind,
    ...(decision.kind === "none" ? { reason: decision.reason } : {}),
  };
  if (decision.kind === "none") return { facet: null, detail };
  const code = decision.kind === "other" ? F26_OTHER : F26_UNSPECIFIED;
  return {
    facet: {
      header: F26,
      code,
      name: cat.term(code)?.name ?? (decision.kind === "other" ? "Other" : "Unspecified"),
    },
    detail,
  };
}

async function finishResiduals(
  ctx: PlaceContext,
  audit: AuditEntry[],
  extra: Record<string, unknown> = {}
): Promise<AssignResidualsOk> {
  // Same-nature mix: the generic base is intentional (§3.1.10); neither a
  // missing sibling (Other) nor missing detail (Unspecified).
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
    const f26 = await chooseF26(ctx.cat, ctx.input, ctx.baseCode, { model: ctx.model });
    const applied = f26.facet !== null && addFacet(ctx, f26.facet);
    audit.push({
      step: "residuals_f26",
      detail: { ...f26.detail, applied, facet: f26.facet, fit: ctx.fit },
    });
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
    memberTypes: memberTermTypes(
      options.descriptionKind ?? null,
      cat.term(baseTerm.code)?.termType ?? null
    ),
    implied,
    impliedF04,
    facets: [],
    freeText: [],
    seenCodes: new Set(),
    limitedSlots: new Set(),
    model,
    input,
    fit: options.fit ?? null,
    fortificationClaim: { status: "none" },
    numericClaim: { fatPercent: null, alcoholPercent: null },
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

  // --- 0b. Fat % / alcohol % (F07 / F11 nearest bucket) ---
  const { claim: numericClaim, detail: numericDetect } = await askNumericContent(
    ctx,
    input
  );
  ctx.numericClaim = numericClaim;
  const numericPlace = await applyNumericContent(ctx, numericClaim);
  audit.push({
    step: "residuals_numeric",
    detail: { ...numericDetect, ...numericPlace },
  });
  const numericCover = numericContentCovered(numericClaim);

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
              ...(numericCover !== null ? { numeric: numericCover } : {}),
            },
          },
          null,
          2
        ),
      });
      const meaning = parseEssence(defined.content);
      const meaningFiltered = dropEarlyClaimRestatements(
        asUnsorted(meaning.properties),
        ctx.fortificationClaim,
        ctx.numericClaim
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
            ? { droppedEarlyClaims: meaningFiltered.dropped }
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
      for (const property of dropEarlyClaimRestatements(
        covered.kept,
        ctx.fortificationClaim,
        ctx.numericClaim
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
    ...(numericCover !== null ? { numeric: numericCover } : {}),
  };

  const allowSide = sideAllowedForKind(descriptionKind);
  const listed = await chatJson({
    model,
    system: allowSide ? systemInputVsBase(true) : systemInputRelations(descriptionKind),
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
  const forFilter = allowSide ? listedRaw : asUnsorted(listedRaw);
  const { kept: inInput, dropped } = filterPropertiesToInput(forFilter, gapInput);
  const claimDrop = dropEarlyClaimRestatements(
    inInput,
    ctx.fortificationClaim,
    ctx.numericClaim
  );
  const properties = claimDrop.kept;
  const droppedAll = [
    ...dropped,
    ...claimDrop.dropped.map((p) => ({
      phrase: p.phrase,
      kind: p.kind,
      reason: "early_claim_already_placed",
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
      ...(droppedAll.length > 0 ? { dropped: droppedAll, raw: listedRaw } : {}),
    },
  });

  const inputResolutions = [];
  for (const property of properties) {
    inputResolutions.push(await placeByKind(ctx, property));
  }
  return await finishResiduals(ctx, audit, { from: "input", resolutions: inputResolutions });
}
