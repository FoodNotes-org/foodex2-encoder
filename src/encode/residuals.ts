/**
 * Residuals after the base term: fortification and numeric claims first, then
 * either the composite-dish route or foodstuff name meaning + input vs base.
 *
 * 1a. Composite dish — when route said dish/dish_type, after 1c and 1d: the
 *     principal characterising ingredients (F04 walk), one descriptor choice
 *     per facet in DISH_FACETS, then a gate over the whole code that drops the
 *     chosen descriptors an expert would infer from the rest. Then step 3 and
 *     the cleanup; foodstuff name meaning and input-vs-base do not run
 *     (dish-route.ts).
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
 * 2. Input vs base — non-dish only: what the input still expresses; covered
 *    includes step 1. A foodstuff also receives `called`, the name already
 *    resolved. Leftovers are unsorted: one facet pick per phrase over the Facets
 *    dimensions (excl. F07/F09/F11/F26) plus two origin options. Origin options
 *    use the origin route: `made_from` → F01/F27 (F04 on a composite),
 *    `added` → F04. F04 is also a top-down walk of `ingred`. Mix skips F26.
 * 3. F26 Generic-term — its own step after placement (chooseF26): Other when the
 *    input is a missing sibling of the base's children, else Unspecified on an
 *    H/M/P base.
 * 4. Included characteristics — after the deterministic cleanup, when two or
 *    more descriptors remain besides generic-term: drop a descriptor whose
 *    characteristic another recorded descriptor already includes. Other and
 *    Unspecified stay out of that judgement.
 */

import { searchTerms, type SearchCandidate } from "../search/lexical.js";
import { pickAllowedCode, pickAllowedCodes } from "./answers.js";
import {
  openFacetDimensions,
  pickFacets,
  hierarchyDescriptorsHeldBack,
  resolveFacetWalk,
  selectStatedFacet,
  systemOriginPick,
  type FacetPickExtra,
  type FacetWalkFood,
  type OriginPickRole,
} from "./facet-walk.js";
import {
  dishFacetInfo,
  dishFacets,
  dishFacetTerms,
  dishGateDescriptor,
  dishGateShelf,
  parseDishIngredients,
  parseOfferedCodes,
  systemDishFacetSelect,
  systemDishGate,
  systemDishIngredients,
} from "./dish-route.js";
import {
  dropNumericRestatements,
  nearestAlcoholFacet,
  nearestFatFacet,
  numericContentCovered,
  parseNumericContent,
  type NumericContentClaim,
} from "./numeric-facets.js";
import { removePhrases, type NamedFacets } from "./base-compare.js";
import type {
  AuditEntry,
  BaseTermRef,
  DescriptionKind,
  FacetDescriptorRef,
  FreeTextEntry,
  SelectFit,
} from "./types.js";
import { Catalogue, DEFAULT_HIERARCHY } from "../catalogue.js";
import { countryParagraph, DEFAULT_COUNTRY_CODE, resolveCountry } from "../country.js";
import { cardinalityKey, facetCardinality, impliedRelation } from "../rules/index.js";
import { catalogueLookup } from "../rules/catalogue-lookup.js";
import { chatJson, defaultModel } from "../llm.js";
import { contentTokens, FUNCTION_WORDS, sameContentTokenSet } from "../search/content-match.js";
import { formatFoodEx2Code, sortFacets } from "./foodex2-code.js";
import { matchCommoditySource, resolveSourceWalk } from "./source-walk.js";
const INGRED_HIERARCHY = "ingred";
const F01 = "F01";
const F04 = "F04";
const F26 = "F26";
const F27 = "F27";
const F28 = "F28";
const F20 = "F20";
/** Process facet "Raw, no heat treatment". Redundant on a raw primary commodity. */
const RAW_NO_HEAT = "A07HS";
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
function systemOriginRole(withCountry: boolean): string {
  return `You are an expert in food classification.

Relative to the locked food, does this property point to:
(1) which organism the food comes from
(2) what raw foodstuff it was made from
(3) what it contains as a characterising inclusion

Use (1) when specifying the live plant or animal (species on fish/meat, plant on a raw commodity).
Use (2) when the locked food is made from a raw foodstuff (milk for cheese, grain for flour, seed for oil) — even if the property only names the animal or plant.
Use (3) when the property is an inclusion in a composite or mixed food.
If unclear, return null.
${countryBlock(withCountry)}
Reply with JSON only:
{"role":"organism"|"made_from"|"contains"|null}
`;
}

/**
 * Origin options offered to the facet picker beside the Facets dimensions; each
 * code is the property kind whose origin route places it.
 */
const ORIGIN_PICKS: FacetPickExtra[] = [
  {
    code: "made_from",
    name: "Source",
    covers: "the plant, animal or commodity this food is, or is made from",
  },
  { code: "added", name: "Ingredient", covers: "a food or substance added to this food" },
];

/**
 * Differentiae of a foodstuff within the chosen genus. Each phrase is looked
 * up across the facet lists. A phrase that matches nothing is dropped.
 */
export function systemDifferentiae(withCountry: boolean): string {
  const description = withCountry
    ? "- `description`: a food description, as understood in the food nomenclature of: `country`."
    : "- `description`: a food description.";
  const country = withCountry ? "- `country`: the country of the food description.\n" : "";
  return `You are an expert in food classification.

You are given:
${description}
${country}- \`genus\`: the catalogue term chosen for \`description\`, defined by its \`name\`, its \`descriptors\`, and its \`scope\`. In \`scope\`, "the group" is this genus.

Task: name the differentiae, if any, of \`description\` within \`genus\`. Each is a short phrase for one characteristic \`description\` expresses and \`genus\` does not. A characteristic that only follows from a kind \`description\` names is not a differentia. "Any type of" this genus does not name a particular kind. A kind \`description\` names is a differentia when \`scope\` does not name it.

Reply with JSON only:
{"differentiae":["<phrase>"]}
`;
}

/** Scope note up to the repeated part-consumed instruction. */
export function genusScope(note: string | null | undefined): string {
  const text = note?.trim() ?? "";
  const cut = text.search(/The part consumed\/analysed/i);
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x !== "")
    : [];
}

/** Phrases from a differentiae answer. */
export function parseDifferentiae(content: unknown): string[] {
  const body = content !== null && typeof content === "object" ? (content as Record<string, unknown>) : {};
  return stringList(body.differentiae);
}

/** `from` entries of an origin or group-origin answer, plus the definition when given. */
export function parseOriginAnswer(content: unknown): { definition: string | null; from: string[] } {
  const body = content !== null && typeof content === "object" ? (content as Record<string, unknown>) : {};
  const definition = typeof body.definition === "string" && body.definition.trim() !== "" ? body.definition.trim() : null;
  return { definition, from: stringList(body.from) };
}

/** The answered name, or null when it is empty or not found in `description`. */
export function parseFoodName(content: unknown, description: string): string | null {
  const raw =
    content !== null && typeof content === "object" ? (content as { name?: unknown }).name : null;
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name === "" || !description.toLowerCase().includes(name.toLowerCase())) return null;
  return name;
}

/**
 * Fortification / enrichment / supplementation — asked before ingredient/source
 * placement so those routes do not claim the same wording as F04.
 */
function systemFortification(withCountry: boolean): string {
  return `You are an expert in food classification.

Does this food description state that the food is fortified, enriched, or supplemented — including a nutrient or substance added for that purpose?

If no: return null.
If yes but no fortifying agent is named: return "bare".
If yes and one or more agents are named: list each agent as a short phrase (the nutrient or substance only).
${countryBlock(withCountry)}
Reply with JSON only:
{"fortification":null|"bare"|{"agents":["<phrase>",...]}}
`;
}

/**
 * Stated fat % / alcohol % v/v — asked early so later residual passes do not
 * place the same wording via F10 soft claims or a facet walk of F07/F11.
 * Soft labels without a number (low fat, alcohol free) stay null here.
 */
function systemNumericContent(withCountry: boolean): string {
  return `You are an expert in food classification.

Does this food description state a fat percentage and/or an alcohol-by-volume percentage?

If a fat percentage is stated, set fatPercent to that number (ranges → midpoint).
If an alcohol-by-volume percentage is stated (including ABV or "% volume" on drinks), set alcoholPercent similarly.
If only a soft claim is present with no number (low fat, alcohol free, …), leave that field null.
If neither percentage is stated, both fields are null.
${countryBlock(withCountry)}
Reply with JSON only:
{"fatPercent":<number>|null,"alcoholPercent":<number>|null}
`;
}

/** Detected fortification claim; facet placement comes in a later step. */
export type FortificationClaim =
  | { status: "none" }
  | { status: "bare" }
  | { status: "agents"; agents: string[] };

function countryBlock(withCountry: boolean, textField = "input"): string {
  return countryParagraph(withCountry, textField);
}

/**
 * Leftovers for anything but a dish. The facet picker decides which facets
 * each phrase speaks to, so one phrase can carry several (in sunflower oil →
 * surrounding medium and ingredient). A foodstuff is asked which characterising
 * descriptors remain once `called` denotes the food.
 */
export function systemInputRelations(
  descriptionKind: DescriptionKind | null = null,
  withCountry = false
): string {
  if (descriptionKind === "foodstuff") return systemFoodstuffInput(withCountry);
  const aggregate = descriptionKind === "category";
  const group = aggregate
    ? "\n`input` is an aggregate term: it names a group of foods, not one food. A property is something every food in the group has; mark wording that says which foods the group includes with `\"kind\":\"member\"`.\n"
    : "";
  const shape = aggregate
    ? '{"phrase":"<text>","name":"<text>","kind":"member"?}'
    : '{"phrase":"<text>","name":"<text>"}';
  return `You are an expert in food classification.

You are given a food description (\`input\`) and what is already captured (\`baseTerm\`, \`implicits\`, \`covered\`).
${countryBlock(withCountry)}${group}
First, list the descriptors in the input that are not already expressed by \`baseTerm\`, \`implicits\` or \`covered\`. Put any other wording in \`omitted\`, with a short \`reason\`.

Then, state each as a property of this food: the \`phrase\` from the input and, as \`name\`, a short catalogue-style name of the food, organism, substance, treatment or attribute it states.

Give more than one property for a phrase only when the phrase itself states more than one.

If nothing is left to keep, return an empty properties list.

Reply with JSON only:
{"properties":[${shape},...],"omitted":[{"phrase":"<text>","reason":"<text>"},...]}
`;
}

/** Foodstuff leftovers. `called` denotes the food; words inside it can still be further descriptors. */
function systemFoodstuffInput(withCountry: boolean): string {
  return `You are an expert in food classification.

Which characterising descriptors does this food description still assert, so each one can be recorded?

Given:
- \`input\`: the food description, in full. Read every phrase in this context.
- \`called\`: the part of \`input\` that denotes the food. This denotation has already been resolved.
- \`baseTerm\`: the food group already chosen for it.
- \`implicits\`: the descriptors that group already carries.
- \`covered\`: the descriptors already recorded.
${countryBlock(withCountry)}
\`called\` denotes the food. A phrase that denotes that same food is not a further descriptor. A phrase that states a further descriptor is one, including when it is written inside \`called\`, unless \`baseTerm\`, \`implicits\`, or \`covered\` already record it.

Omit wording that does not change the food. Put each omission in \`omitted\` with a short reason.

For each descriptor kept, give \`phrase\` as written in \`input\`, and \`name\` as a short catalogue-style name of the food, organism, substance, treatment, or attribute it states.

Give more than one property for a phrase only when that phrase states more than one descriptor.

If none remain, \`properties\` is empty.

Reply with JSON only:
{"properties":[{"phrase":"<text>","name":"<text>"},...],"omitted":[{"phrase":"<text>","reason":"<text>"},...]}
`;
}

/**
 * One job: the attributes the description still states about the food, once
 * the base term is chosen. A qualification of an attribute stays inside it.
 */
export function systemAttributeSlots(withCountry: boolean): string {
  return `You are an expert in food classification.

The base term for this food is already chosen. List the attributes the description still states about that food.

Given:
- \`description\`: the food description.
- \`baseTerm\`: the term already chosen.
- \`implicits\`: the facets that term already carries.
${countryBlock(withCountry)}
An attribute is a way the food itself is qualified: a process it underwent, a part of it, what it is made from, what it contains, or what surrounds it.

A detail that qualifies an attribute is part of that attribute. In "potatoes, fried in oil", "fried in oil" is one attribute: the oil qualifies the frying. "in oil" alone would make the oil belong to the potatoes.

Do not list an attribute the base term already is. Do not list the food's own name.

Return each attribute as \`phrase\`, the words from the description. Put wording you do not list in \`omitted\`, with a short \`reason\`.

If none remain, \`attributes\` is empty.

Reply with JSON only:
{"attributes":[{"phrase":"<text>"},...],"omitted":[{"phrase":"<text>","reason":"<text>"},...]}
`;
}

export interface AttributeSlots {
  attributes: string[];
  omitted: GapOmitted[];
}

/** Parse the attribute-slot reply. Phrases are the words from the description. */
export function parseAttributeSlots(content: unknown): AttributeSlots {
  const omitted = parseGapOmitted(content);
  if (content === null || typeof content !== "object") return { attributes: [], omitted };
  const raw = (content as { attributes?: unknown }).attributes;
  if (!Array.isArray(raw)) return { attributes: [], omitted };
  const attributes: string[] = [];
  for (const item of raw) {
    const phrase =
      typeof item === "string"
        ? item.trim()
        : item !== null && typeof item === "object" && typeof (item as { phrase?: unknown }).phrase === "string"
          ? (item as { phrase: string }).phrase.trim()
          : "";
    if (phrase === "") continue;
    if (attributes.some((a) => a.toLowerCase() === phrase.toLowerCase())) continue;
    attributes.push(phrase);
  }
  return { attributes, omitted };
}

function isDishKind(descriptionKind: DescriptionKind | null): boolean {
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
function systemClosedPick(withCountry: boolean): string {
  return `You are an expert in food classification.

Does the phrase mean the same thing as one of the candidates?

Candidates may include codingGuidance: catalogue instructions for when to use or not use that descriptor, and sometimes how it trades off against other facets. It is not a definition of the phrase or of the food. Use it only to decide whether that candidate is the right code for the phrase.

If yes, return that candidate's code. Prefer a more specific candidate when the phrase still means the same thing; do not pick a candidate that adds detail the phrase does not support.
If none, return null.
${countryBlock(withCountry, "phrase")}
Reply with JSON only:
{"code":"<CODE>"|null}
`;
}

/**
 * F26: how the input relates to the base's direct children. The answer decides
 * Other vs Unspecified in code (see decideF26); the model does not pick F26.
 */
function systemF26Relation(withCountry: boolean): string {
  return `You are an expert in food classification.

You are given a food description (\`input\`), the catalogue term chosen for it (\`baseTerm\`), and the terms directly under that term (\`children\`).
${countryBlock(withCountry)}
First, consider what food \`input\` identifies.

Then, consider what kinds of \`baseTerm\` the children are.

Then, decide how \`input\` relates to the children:
- "same" — it is the same food as one of the children
- "within" — it is a kind of one of the children
- "sibling" — it is another kind of \`baseTerm\`, at the same level as the children, that none of them covers
- "parent" — it covers several of the children, or is no narrower than \`baseTerm\`
- "none" — none of these, including when it differs from the children only in how it is processed or which part is eaten

Reply with JSON only:
{"relation":"same"|"within"|"sibling"|"parent"|"none"}
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
   * `mix` places components as F27 on an RPC/derivative base and skips F26.
   * Lexical auto-accept and missing route → skip dish / foodstuff essence.
   */
  descriptionKind?: DescriptionKind | null;
  /**
   * Foods outside a mix's shared generic group that are a minor share of the
   * product. Recorded as ingredients, not as source commodities.
   */
  minorFoods?: string[];
  /** English name of the country the description comes from. */
  country?: string | null;
  /**
   * Attribute slots: one split, every route may propose, one gate chooses.
   * False keeps the legacy residual path, which dishes always take. Default true on this branch.
   */
  facetSlots?: boolean;
  /**
   * A foodstuff's stated processes (F28) and parts (F20), already named from
   * the full lists. They are placed as given; attributes do not search those
   * facets again.
   */
  named?: NamedFacets;
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
  /** Input with stated attribute phrases cut out; falls back to `input`. */
  food: string;
  /** English country name, when the caller passed one. */
  country: string | null;
  fit: SelectFit | null;
  /** Step 0 claim; later leftover phrases that restate it are not placed again. */
  fortificationClaim: FortificationClaim;
  /** Step 0b claim; quantitative fat/alcohol % restatements are not placed again. */
  numericClaim: NumericContentClaim;
  /**
   * Raw commodity or natural source already placed for a derivative. A later
   * attribute whose words sit inside one of these is that same fact.
   */
  originCovered: string[];
  /** Minor-share foods in a mix. An attribute that names one is an ingredient. */
  minorFoods: readonly string[];
  /** Facet keys kept beside a more precise source. Inclusion may not drop them. */
  protectedFacets: Set<string>;
  /** Stated processes and parts named before placement; null when not given. */
  named: NamedFacets | null;
}

function walkFood(ctx: PlaceContext): FacetWalkFood {
  return {
    input: ctx.input,
    food: ctx.food,
    baseTerm: ctx.baseName,
    baseScope: ctx.cat.term(ctx.baseCode)?.scopeNote?.trim() ?? "",
  };
}

/** Longest phrases first so a compound attribute is cut before a word inside it. */
export function stripAttributePhrases(
  description: string,
  phrases: readonly string[]
): string {
  const ordered = [...new Set(phrases.map((phrase) => phrase.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length
  );
  return removePhrases(description, ordered).text;
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
function matchesMinorFood(phrase: string, minorFoods: readonly string[]): boolean {
  return minorFoods.some((food) => wordsWithin(phrase, food) || wordsWithin(food, phrase));
}

async function originRolesFor(
  ctx: PlaceContext,
  phrase: string,
  kind: GapPropertyKind
): Promise<{ roles: OriginRole[]; detail: Record<string, unknown> }> {
  if (matchesMinorFood(phrase, ctx.minorFoods)) {
    return {
      roles: ["contains"],
      detail: {
        via: "origin_role",
        phrase,
        kind,
        food: ctx.baseName,
        roles: ["contains"],
        decidedBy: "minor_share",
      },
    };
  }
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
    system: systemOriginRole(ctx.country !== null),
    user: JSON.stringify(
      {
        food: ctx.baseName,
        property: phrase,
        input: ctx.input,
        ...(ctx.country !== null ? { country: ctx.country } : {}),
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
   * Essence channel: a descriptor under an implied F04 is still eligible. The
   * walk decides which child; a word match is not required.
   */
  rejectUnderImplied?: boolean;
  /** Passed through for callers. The F04 accept no longer matches it to the term name. */
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
  | "kind_of_base"
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
    // A parent of the base restates it more vaguely. A child is a narrower kind
    // of the same food (low-fat salad dressing), not an ingredient of it.
    if (cat.isAncestor(descriptorCode, options.baseCode, INGRED_HIERARCHY)) {
      return "broader";
    }
    if (cat.isAncestor(options.baseCode, descriptorCode, INGRED_HIERARCHY)) {
      return "kind_of_base";
    }
  }

  // An implied source commodity (F27) is the food the base is made from, so an
  // ingredient that names it restates the base as much as an implied F04 does.
  const impliedSources =
    options.baseCode === undefined
      ? []
      : cat
          .impliedFacets(options.baseCode)
          .filter((key) => key.startsWith(`${F27}.`))
          .map((key) => key.slice(F27.length + 1));

  for (const implied of [...impliedF04, ...impliedSources]) {
    if (descriptorCode === implied) return "restate";
    if (cat.isAncestor(descriptorCode, implied, INGRED_HIERARCHY)) return "broader";
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
    system: systemFortification(ctx.country !== null),
    user: JSON.stringify(
      {
        input: foodDescription,
        ...(ctx.country !== null ? { country: ctx.country } : {}),
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
      country: ctx.country,
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
    system: systemNumericContent(ctx.country !== null),
    user: JSON.stringify(
      {
        input: foodDescription,
        ...(ctx.country !== null ? { country: ctx.country } : {}),
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
/**
 * The foods a phrase puts on either side of "or".
 * "stir-fried in vegetable oil or butter" → vegetable oil, butter.
 * Null when the phrase is not a choice.
 */
export function orAlternatives(phrase: string): string[] | null {
  const parts = phrase
    .split(/\s+or\s+/i)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length < 2) return null;
  const sides = parts.map(foodAfterLink);
  if (sides.some((side) => side === "")) return null;
  return sides;
}

/** The food after the last "in" or "with"; the whole part when there is none. */
function foodAfterLink(part: string): string {
  const match = part.match(/^(?:.*\b(?:in|with)\s+)(.+)$/i);
  return (match?.[1] ?? part).trim();
}

function f04RecallQueries(phrase: string): string[] {
  const foodPhrase = foodPhraseForF04(phrase);
  if (foodPhrase === "") return [];
  const tokens = [...foodTokensForF04(phrase)];
  const out = [foodPhrase];
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1]!;
    if (last.length >= 3 && last !== foodPhrase) out.push(last);
  }
  for (const side of orAlternatives(phrase) ?? []) {
    const query = foodPhraseForF04(side);
    if (query !== "" && !out.includes(query)) out.push(query);
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
): Promise<ClosedResolution> {
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
    food: walkFood(ctx),
    country: ctx.country,
    seeds,
    originRole: "ingredient",
  });
  return {
    facet: walked.facet,
    facets: walked.facets,
    detail: {
      ...walked.detail,
      ...(options.rejectUnderImplied === true ? { rejectUnderImplied: true } : {}),
    },
  };
}

/**
 * Source commodities: walk the raw-commodity tree from its root. Word-search
 * hits are extra names, so a term the walk misses can still be chosen.
 */
async function resolveF27Phrase(
  ctx: PlaceContext,
  phrase: string,
  options: AcceptFacetOptions = {}
): Promise<ClosedResolution> {
  const acceptOpts = { rejectUnderImplied: options.rejectUnderImplied };
  const accept = (_header: string, code: string): boolean =>
    acceptClosedDescriptor(ctx.cat, F27, code, ctx.implied, acceptOpts) === "keep" &&
    (ctx.memberTypes === null || ctx.memberTypes.has(ctx.cat.term(code)?.termType ?? ""));
  const { pool } = buildClosedPickPool(ctx.cat, phrase, F27, ctx.implied, {
    allowRootFallback: false,
    rejectUnderImplied: options.rejectUnderImplied,
    termTypes: ctx.memberTypes,
  });
  const walked = await resolveFacetWalk(ctx.cat, phrase, [F27], {
    model: ctx.model,
    accept,
    food: walkFood(ctx),
    country: ctx.country,
    seeds: pool.map((hit) => ({ header: F27, code: hit.code })),
    originRole: "made_from",
  });
  return { facet: walked.facet, facets: walked.facets, detail: walked.detail };
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
 * Prefer accepted aligned hits; otherwise the accepted lexical hits, so the model can
 * refuse a term that only shares a word ("butter" against "Butter nut").
 * Root-children fallback is F28/F21 only.
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
  model: string,
  origin?: { role: OriginPickRole; food: string; baseTerm: { name: string; scope: string } },
  country: string | null = null
): Promise<{ codes: string[]; model: string; detail: Record<string, unknown> }> {
  const allowed = new Set(candidates.map((c) => c.code));
  const withCountry = country !== null;
  const many = origin !== undefined && facetCardinality(header)?.flag === "repeatable";
  if (origin !== undefined) {
    const picked = await chatJson({
      model,
      system: systemOriginPick(origin.role, withCountry, many),
      user: JSON.stringify(
        {
          food: origin.food,
          baseTerm: origin.baseTerm,
          ...(withCountry ? { country } : {}),
          lookingFor: phrase,
          terms: candidates.map((c) => {
            const hierarchy = cat.facetCategory(header)?.hierarchyCode;
            const parentCode = hierarchy === undefined ? null : cat.parent(c.code, hierarchy);
            const parent =
              parentCode === null ? undefined : (cat.term(parentCode)?.name ?? parentCode);
            return {
              code: c.code,
              name: cat.term(c.code)?.name ?? c.name,
              ...(many && parent !== undefined ? { parent } : {}),
            };
          }),
        },
        null,
        2
      ),
    });
    const codes = many
      ? pickAllowedCodes(picked.content, allowed)
      : (() => {
          const code = pickAllowedCode(picked.content, allowed);
          return code === null ? [] : [code];
        })();
    return {
      codes,
      model: picked.model,
      detail: {
        phrase,
        header,
        via: "closed_model_pick",
        originRole: origin.role,
        candidates: candidates.map((c) => ({ code: c.code, name: c.name })),
        picked: many ? codes : (codes[0] ?? null),
      },
    };
  }
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
    system: systemClosedPick(withCountry),
    user: JSON.stringify(
      { ...payload, ...(withCountry ? { country } : {}) },
      null,
      2
    ),
  });
  const code = pickAllowedCode(picked.content, allowed);
  return {
    codes: code === null ? [] : [code],
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

type ClosedResolution = {
  facet: FacetDescriptorRef | null;
  facets: FacetDescriptorRef[];
  detail: Record<string, unknown>;
};

function closedFacetResult(
  cat: Catalogue,
  header: string,
  phrase: string,
  hit: LexHit,
  extra: Record<string, unknown> = {}
): ClosedResolution {
  const name = cat.term(hit.code)?.name ?? hit.name;
  const facet = { header, code: hit.code, name };
  return {
    facet,
    facets: [facet],
    detail: { phrase, header, resolved: hit.code, name, verdict: "keep", ...extra },
  };
}

function facetsForCodes(
  cat: Catalogue,
  header: string,
  codes: string[],
  pool: LexHit[]
): FacetDescriptorRef[] {
  return codes.map((code) => {
    const hit = pool.find((candidate) => candidate.code === code);
    return {
      header,
      code,
      name: cat.term(code)?.name ?? hit?.name ?? code,
    };
  });
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
    /** Origin walks: the model pick asks this role's question about the food. */
    origin?: { role: OriginPickRole; food: string; baseTerm: { name: string; scope: string } };
    /** English country name, when the caller passed one. */
    country?: string | null;
  } = {}
): Promise<ClosedResolution> {
  const allowRootFallback =
    options.allowRootFallback ?? (header === F28 || header === F21);
  const built = buildClosedPickPool(cat, phrase, header, implied, {
    allowRootFallback,
    seedHits: options.seedHits,
    rejectUnderImplied: options.rejectUnderImplied,
    termTypes: options.termTypes,
  });
  const ranked = built.ranked;
  // §5.2: a hierarchy descriptor loses to any other detail level in the same choice.
  const choice = built.pool.length > 0 ? built.pool : built.alignedAccepted;
  const heldBack = hierarchyDescriptorsHeldBack(cat, choice);
  const drop = new Set(heldBack.map((hit) => hit.code));
  const alignedAccepted =
    drop.size === 0
      ? built.alignedAccepted
      : built.alignedAccepted.filter((hit) => !drop.has(hit.code));
  const pool = drop.size === 0 ? built.pool : built.pool.filter((hit) => !drop.has(hit.code));

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
      options.model,
      options.origin,
      options.country ?? null
    );
    const facets = facetsForCodes(cat, header, picked.codes, pickPool);
    if (facets.length > 0) {
      const facet = facets[0]!;
      return {
        facet,
        facets,
        detail: {
          ...picked.detail,
          resolved: facets.length === 1 ? facet.code : facets.map((item) => item.code),
          ...(facets.length === 1 ? { name: facet.name } : {}),
          verdict: "keep",
        },
      };
    }
    return {
      facet: null,
      facets: [],
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
    facets: [],
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
 * The fortification-agent already names the substance and the use.
 * The same term as an ingredient restates the substance, and Fortified
 * only says an agent was added. Both go when the agent is recorded.
 * An ingredient with no agent, and a bare Fortified, stay.
 */
function dropRepeatedFortification(
  facets: FacetDescriptorRef[],
  dropped: CleanupDrop[]
): FacetDescriptorRef[] {
  const agentCodes = new Set(
    facets.filter((facet) => facet.header === F09).map((facet) => facet.code)
  );
  let kept = facets.filter((facet) => {
    if (facet.header === F04 && agentCodes.has(facet.code)) {
      dropped.push({ facet, reason: "same_as_fortification_agent" });
      return false;
    }
    return true;
  });
  if (!kept.some((facet) => facet.header === F09)) return kept;
  return kept.filter((facet) => {
    if (facet.header === F10 && facet.code === F10_FORTIFIED) {
      dropped.push({ facet, reason: "fortified_when_agent_named" });
      return false;
    }
    return true;
  });
}

/**
 * Post-place cleanup: implicits rule, drop broader-than-sibling within a header,
 * and for single-cardinality headers keep the most informative descriptor.
 * Then drop an ingredient that repeats a fortification-agent, and Fortified
 * when a named agent remains.
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

  return { facets: dropRepeatedFortification(out, dropped), dropped };
}

/**
 * Choose among labelled combinations of a derivative and the process it
 * already carries. Every other descriptor stays on each line.
 */
export function systemFacetCleanup(withCountry: boolean): string {
  return `You are an expert in food classification.

Task: choose the description that says what this food is, as precisely and as completely as these descriptions allow, without stating the same fact twice.

Given:
- \`description\`: the food.
- \`candidates\`: the descriptions to choose from. Each has an \`id\` and a \`text\`. The first line of \`text\` is the base term, what the food is. Each further line is a facet descriptor that qualifies it, written as its role and its name.
${countryParagraph(withCountry, "description")}
A precise descriptor stays close to what the description says. A complete description still states each fact the description states. A descriptor that only restates a commodity and a process already stated in that description states the same fact twice.

Reply with JSON only, giving the id of the description to keep:
{"id":"<id>"}
`;
}

export interface FacetCleanupDescriptor {
  code: string;
  name: string;
  scope?: string;
  facet: { code: string; name: string; scope?: string };
  parent?: { code: string; name: string | null; scope?: string };
}

export interface DerivativeProcessPair {
  derivative: {
    code: string;
    name: string;
    scope?: string;
    builtFrom: Array<{ code: string; name: string; facet: string }>;
  };
  processes: Array<{ code: string; name: string }>;
}

/** Implicit facets of a term, as facet descriptors the catalogue already assigns. */
function builtFromFacets(
  cat: Catalogue,
  code: string
): Array<{ code: string; name: string; facet: string }> {
  const out: Array<{ code: string; name: string; facet: string }> = [];
  for (const key of cat.impliedFacets(code)) {
    const dot = key.indexOf(".");
    if (dot <= 0) continue;
    const header = key.slice(0, dot);
    const termCode = key.slice(dot + 1);
    if (termCode === "") continue;
    out.push({
      code: key,
      name: cat.term(termCode)?.name ?? termCode,
      facet: cat.facetCategory(header)?.label ?? header,
    });
  }
  return out;
}

function recordedKey(facet: { header: string; code: string }): string {
  return `${facet.header}.${facet.code}`;
}

/**
 * Derivatives recorded beside a process they already carry.
 * A raw commodity is not a candidate. A process covers an implicit process
 * when it is that process or a narrower one.
 */
export function derivativeProcessPairs(
  cat: Catalogue,
  facets: readonly FacetDescriptorRef[]
): DerivativeProcessPair[] {
  const hierarchy = cat.facetCategory(F28)?.hierarchyCode;
  if (hierarchy === undefined) return [];
  const processes = facets.filter((facet) => facet.header === F28);
  const out: DerivativeProcessPair[] = [];
  for (const facet of facets) {
    if (cat.term(facet.code)?.termType !== "d") continue;
    const builtFrom = builtFromFacets(cat, facet.code);
    const implicitProcesses = builtFrom.filter((item) => item.code.startsWith(`${F28}.`));
    if (implicitProcesses.length === 0) continue;
    const covered = processes.filter((process) =>
      implicitProcesses.some((implicit) => {
        const termCode = impliedTermCode(implicit.code);
        return termCode !== null && cat.isAncestor(termCode, process.code, hierarchy);
      })
    );
    if (covered.length === 0) continue;
    out.push({
      derivative: {
        code: recordedKey(facet),
        name: facet.name,
        ...optionalScope(cat.term(facet.code)?.scopeNote),
        builtFrom,
      },
      processes: covered.map((process) => ({
        code: recordedKey(process),
        name: process.name,
      })),
    });
  }
  return out;
}

function impliedTermCode(key: string): string | null {
  const dot = key.indexOf(".");
  if (dot <= 0) return null;
  const termCode = key.slice(dot + 1);
  return termCode === "" ? null : termCode;
}

export interface FacetCombo {
  id: string;
  text: string;
  /** Keys from the varying set that this description includes. */
  varying: string[];
}

interface LabelledFacet {
  key: string;
  header: string;
  name: string;
  role: string;
}

function subsetKeys(keys: readonly string[]): string[][] {
  const out: string[][] = [[]];
  for (const key of keys) out.push(...out.map((combo) => [...combo, key]));
  return out;
}

/**
 * Every combination of the varying descriptors, each written under the base
 * term with its role. Descriptors outside `varyingKeys` are on every line.
 */
export function derivativeFacetCombos(
  baseName: string,
  facets: readonly LabelledFacet[],
  varyingKeys: readonly string[]
): FacetCombo[] {
  const varying = new Set(varyingKeys);
  const fixed = facets.filter((facet) => !varying.has(facet.key));
  const byKey = new Map(
    facets.filter((facet) => varying.has(facet.key)).map((facet) => [facet.key, facet])
  );
  const ordered = [...varyingKeys].filter((key) => byKey.has(key)).sort();
  return subsetKeys(ordered).map((keys, index) => {
    const chosen = keys.flatMap((key) => {
      const facet = byKey.get(key);
      return facet === undefined ? [] : [facet];
    });
    const lines = [baseName, ...facetLines([...fixed, ...chosen])];
    return { id: String(index + 1), text: lines.join("\n"), varying: keys };
  });
}

function facetLines(facets: readonly LabelledFacet[]): string[] {
  return [...facets]
    .sort((a, b) => a.header.localeCompare(b.header) || a.key.localeCompare(b.key))
    .map((facet) => `${facet.role} = ${facet.name}`);
}

/** The id of the chosen description, or null when the reply does not name one. */
export function parseFacetCombo(content: unknown): string | null {
  if (content === null || typeof content !== "object") return null;
  const id = (content as { id?: unknown }).id;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
}

function optionalScope(note: string | null | undefined): { scope: string } | Record<string, never> {
  const scope = genusScope(note);
  return scope === "" ? {} : { scope };
}

/** Recorded descriptors with facet and parent. Generic-term is left out. */
export function facetCleanupDescriptors(
  cat: Catalogue,
  facets: readonly FacetDescriptorRef[]
): FacetCleanupDescriptor[] {
  const out: FacetCleanupDescriptor[] = [];
  for (const facet of facets) {
    if (facet.header === F26) continue;
    const category = cat.facetCategory(facet.header);
    const hierarchy = category?.hierarchyCode;
    const parentCode =
      hierarchy === undefined ? null : (cat.term(facet.code)?.hierarchies[hierarchy]?.[0] ?? null);
    const recorded: FacetCleanupDescriptor = {
      code: `${facet.header}.${facet.code}`,
      name: facet.name,
      ...optionalScope(cat.term(facet.code)?.scopeNote),
      facet: {
        code: facet.header,
        name: category?.label ?? facet.header,
        ...optionalScope(category?.scopeNote),
      },
    };
    if (parentCode !== null && parentCode !== "root") {
      const parent = cat.term(parentCode);
      if (parent !== undefined) {
        recorded.parent = {
          code: parentCode,
          name: parent.name,
          ...optionalScope(parent.scopeNote),
        };
      }
    }
    out.push(recorded);
  }
  return out;
}

/**
 * Drop the descriptors the reply named, when they were offered. Generic-term
 * is never offered, so a reply that names it changes nothing.
 */
export function dropIncludedDescriptors(
  facets: readonly FacetDescriptorRef[],
  dropCodes: readonly string[]
): { facets: FacetDescriptorRef[]; dropped: FacetDescriptorRef[] } {
  const offered = new Set(
    facets.filter((facet) => facet.header !== F26).map((facet) => `${facet.header}.${facet.code}`)
  );
  const drop = new Set(dropCodes.filter((code) => offered.has(code)));
  const kept: FacetDescriptorRef[] = [];
  const dropped: FacetDescriptorRef[] = [];
  for (const facet of facets) {
    if (drop.has(`${facet.header}.${facet.code}`)) dropped.push(facet);
    else kept.push(facet);
  }
  return { facets: kept, dropped };
}

/**
 * A part (F20) may state what a process (F28) or a quality (F10) already says.
 * When a part is recorded, each of these may be left out.
 */
export function partOverlapKeys(facets: readonly FacetDescriptorRef[]): string[] {
  if (!facets.some((facet) => facet.header === F20)) return [];
  return facets
    .filter((facet) => facet.header === F20 || facet.header === F28 || facet.header === F10)
    .map((facet) => recordedKey(facet));
}

async function askIncludedFacets(
  ctx: PlaceContext,
  facets: FacetDescriptorRef[]
): Promise<{ facets: FacetDescriptorRef[]; detail: Record<string, unknown> } | null> {
  const varying = new Set<string>();
  for (const pair of derivativeProcessPairs(ctx.cat, facets)) {
    if (!ctx.protectedFacets.has(pair.derivative.code)) varying.add(pair.derivative.code);
    for (const process of pair.processes) {
      if (!ctx.protectedFacets.has(process.code)) varying.add(process.code);
    }
  }
  for (const key of partOverlapKeys(facets)) {
    if (!ctx.protectedFacets.has(key)) varying.add(key);
  }
  if (varying.size === 0) return null;
  const labelled = facets
    .filter((facet) => facet.header !== F26)
    .map((facet) => ({
      key: recordedKey(facet),
      header: facet.header,
      name: facet.name,
      role: (ctx.cat.facetCategory(facet.header)?.label ?? facet.header).toLowerCase(),
    }));
  const combos = derivativeFacetCombos(ctx.baseName, labelled, [...varying]);
  if (combos.length < 2) return null;
  const withCountry = ctx.country !== null && ctx.country !== "";
  const asked = await chatJson({
    model: ctx.model,
    system: systemFacetCleanup(withCountry),
    user: JSON.stringify(
      {
        description: ctx.input,
        ...(withCountry ? { country: ctx.country } : {}),
        candidates: combos.map((combo) => ({ id: combo.id, text: combo.text })),
      },
      null,
      2
    ),
  });
  const picked = combos.find((combo) => combo.id === parseFacetCombo(asked.content));
  if (picked === undefined) {
    return {
      facets,
      detail: { model: asked.model, candidates: combos.length, pick: null },
    };
  }
  const keep = new Set(picked.varying);
  const applied = dropIncludedDescriptors(
    facets,
    [...varying].filter((key) => !keep.has(key))
  );
  for (const facet of applied.dropped) ctx.seenCodes.delete(`${facet.header}.${facet.code}`);
  ctx.facets = applied.facets;
  return {
    facets: applied.facets,
    detail: {
      model: asked.model,
      candidates: combos.length,
      pick: picked.id,
      text: picked.text,
      drop: applied.dropped.map((facet) => ({
        header: facet.header,
        code: facet.code,
        name: facet.name,
      })),
    },
  };
}

/**
 * A raw primary commodity is already unheated. The walk may still choose
 * Raw, no heat treatment; it is not recorded on that base.
 */
export function rawNoHeatOnRawCommodity(
  baseTermType: string | null,
  facet: { header: string; code: string }
): boolean {
  return baseTermType === "r" && facet.header === F28 && facet.code === RAW_NO_HEAT;
}

function addFacet(ctx: PlaceContext, facet: FacetDescriptorRef): boolean {
  if (rawNoHeatOnRawCommodity(ctx.baseTermType, facet)) return false;
  if (redundantCommoditySource(ctx, facet)) return false;
  const key = `${facet.header}.${facet.code}`;
  if (ctx.seenCodes.has(key)) return false;
  const slot = cardinalityKey(catalogueLookup(ctx.cat), facet.header, facet.code);
  if (slot !== null && ctx.limitedSlots.has(slot)) return false;
  ctx.seenCodes.add(key);
  if (slot !== null) ctx.limitedSlots.add(slot);
  ctx.facets.push(facet);
  return true;
}

function removeFacet(ctx: PlaceContext, facet: FacetDescriptorRef): void {
  const key = `${facet.header}.${facet.code}`;
  ctx.seenCodes.delete(key);
  const slot = cardinalityKey(catalogueLookup(ctx.cat), facet.header, facet.code);
  if (slot !== null) ctx.limitedSlots.delete(slot);
  const index = ctx.facets.findIndex(
    (item) => item.header === facet.header && item.code === facet.code
  );
  if (index !== -1) ctx.facets.splice(index, 1);
}

function facetDetail(ctx: PlaceContext, facet: FacetDescriptorRef): string | null {
  return ctx.cat.term(facet.code)?.detailLevel ?? null;
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
 * Groups that contain every code, nearest first.
 * A choice among goat milk, sheep milk, and camel milk shares Milk.
 */
export function sharedGroups(
  cat: Catalogue,
  header: string,
  codes: string[]
): FacetDescriptorRef[] {
  const hierarchy = cat.facetCategory(header)?.hierarchyCode;
  if (hierarchy === undefined || codes.length < 2) return [];
  const chains = codes.map((code) => {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current = cat.parent(code, hierarchy);
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      current = cat.parent(current, hierarchy);
    }
    return chain;
  });
  const [first, ...rest] = chains;
  if (first === undefined) return [];
  const common = first.filter((code) => rest.every((chain) => chain.includes(code)));
  const out: FacetDescriptorRef[] = [];
  for (const code of common) {
    if (!cat.isReportable(code, hierarchy)) continue;
    if (acceptClosedDescriptor(cat, header, code, new Set()) !== "keep") continue;
    out.push({ header, code, name: cat.term(code)?.name ?? code });
  }
  return out;
}

export type PhrasePresence = "each" | "one";

/** `{"presence":"each"|"one"}`. */
export function parsePhrasePresence(content: unknown): PhrasePresence | null {
  if (content === null || typeof content !== "object") return null;
  const raw = (content as { presence?: unknown }).presence;
  return raw === "each" || raw === "one" ? raw : null;
}

function systemPhrasePresence(withCountry: boolean): string {
  return `You are an expert in food classification.

Given:
- \`food\`: the food as described.
- \`phrase\`: the words that name the terms.
- \`terms\`: the named terms, each with a \`code\` and a \`name\`.
${countryBlock(withCountry, "food")}
Does the phrase state that each of them is present, or that one of them is present?

Reply with JSON only:
{"presence":"each"|"one"}
`;
}

function systemSharedGroup(withCountry: boolean): string {
  return `You are an expert in food classification.

Given:
- \`food\`: the food as described.
- \`phrase\`: the words that name the choice.
- \`named\`: the foods the phrase chooses among, each with a \`code\` and a \`name\`.
- \`groups\`: groups that contain all of them, nearest first. Each has a \`code\` and a \`name\`.
${countryBlock(withCountry, "food")}
Which nearest group, if any, stays true whichever of those foods it was?

Reply with JSON only:
{"code":"<code>"|null}
`;
}

/**
 * On a category, several sources for one phrase are a choice: each food in the
 * group comes from one of them. They are replaced by the nearest group above
 * them all in that facet's hierarchy, unless the base term already carries it,
 * and the words go to free text, since a shared group loses their detail.
 */
async function settleCategorySources(
  ctx: PlaceContext,
  phrase: string,
  facets: FacetDescriptorRef[],
  attempts: Record<string, unknown>[]
): Promise<FacetDescriptorRef[]> {
  if (ctx.descriptionKind !== "category") return facets;
  const out: FacetDescriptorRef[] = [];
  for (const header of [...new Set(facets.map((facet) => facet.header))]) {
    const group = facets.filter((facet) => facet.header === header);
    if (group.length < 2 || (header !== F27 && header !== F01)) {
      out.push(...group);
      continue;
    }
    const nearest = sharedGroups(ctx.cat, header, group.map((facet) => facet.code))[0] ?? null;
    const kept =
      nearest !== null &&
      acceptClosedDescriptor(ctx.cat, nearest.header, nearest.code, ctx.implied) === "keep";
    attempts.push({
      via: "category_sources",
      phrase,
      header,
      named: group.map((facet) => facet.code),
      nearest: nearest?.code ?? null,
      kept,
    });
    if (kept) out.push(nearest);
    pushFreeText(ctx.freeText, "member", phrase);
  }
  return out;
}

/**
 * Several terms of one facet: each is recorded, or the phrase is a choice and
 * they are replaced by one shared group (or by nothing).
 */
async function settlePhraseChoice(
  ctx: PlaceContext,
  phrase: string,
  facets: FacetDescriptorRef[],
  attempts: Record<string, unknown>[],
  /** This list is already known to be a choice, so skip the each-or-one question. */
  choiceHeader: string | null = null
): Promise<FacetDescriptorRef[]> {
  const withCountry = ctx.country !== null && ctx.country !== "";
  const out: FacetDescriptorRef[] = [];
  facets = await settleCategorySources(ctx, phrase, facets, attempts);
  const headers: string[] = [];
  for (const facet of facets) {
    if (!headers.includes(facet.header)) headers.push(facet.header);
  }
  for (const header of headers) {
    const group = facets.filter((facet) => facet.header === header);
    if (group.length < 2) {
      out.push(...group);
      continue;
    }
    if (header === choiceHeader) {
      const climbed = await climbChoice(ctx, phrase, header, group, attempts);
      out.push(...climbed);
      continue;
    }
    const asked = await chatJson({
      model: ctx.model,
      system: systemPhrasePresence(withCountry),
      user: JSON.stringify(
        {
          food: ctx.input,
          ...(withCountry ? { country: ctx.country } : {}),
          phrase,
          terms: group.map((facet) => ({ code: facet.code, name: facet.name })),
        },
        null,
        2
      ),
    });
    const presence = parsePhrasePresence(asked.content);
    attempts.push({
      via: "phrase_presence",
      phrase,
      header,
      terms: group.map((facet) => facet.code),
      presence,
      model: asked.model,
    });
    if (presence !== "one") {
      out.push(...group);
      continue;
    }
    out.push(...(await climbChoice(ctx, phrase, header, group, attempts)));
  }
  return out;
}

/** Replace a choice with the nearest shared group, or with nothing. */
async function climbChoice(
  ctx: PlaceContext,
  phrase: string,
  header: string,
  group: FacetDescriptorRef[],
  attempts: Record<string, unknown>[]
): Promise<FacetDescriptorRef[]> {
  const withCountry = ctx.country !== null && ctx.country !== "";
  const groups = sharedGroups(ctx.cat, header, group.map((facet) => facet.code));
  if (groups.length === 0) {
    attempts.push({ via: "choice_climb", phrase, header, groups: [], picked: null });
    return [];
  }
  const allowed = new Set(groups.map((facet) => facet.code));
  const climbed = await chatJson({
    model: ctx.model,
    system: systemSharedGroup(withCountry),
    user: JSON.stringify(
      {
        food: ctx.input,
        ...(withCountry ? { country: ctx.country } : {}),
        phrase,
        named: group.map((facet) => ({ code: facet.code, name: facet.name })),
        groups: groups.map((facet) => ({ code: facet.code, name: facet.name })),
      },
      null,
      2
    ),
  });
  const code = pickAllowedCode(climbed.content, allowed);
  const facet = code === null ? null : (groups.find((item) => item.code === code) ?? null);
  attempts.push({
    via: "choice_climb",
    phrase,
    header,
    groups: groups.map((item) => ({ code: item.code, name: item.name })),
    picked: code,
    model: climbed.model,
  });
  return facet === null ? [] : [facet];
}

/**
 * Ingredients named on either side of "or".
 * Empty when a side has no ingredient, so one side is not recorded as the fat.
 */
function orChoiceFacets(
  ctx: PlaceContext,
  phrase: string
): { facets: FacetDescriptorRef[]; detail: Record<string, unknown> } | null {
  const sides = orAlternatives(phrase);
  if (sides === null) return null;
  const facets: FacetDescriptorRef[] = [];
  const resolved: Array<{ side: string; code: string | null; name?: string }> = [];
  for (const side of sides) {
    const hit = recallIngredF04(ctx.cat, side, ctx.impliedF04, {
      baseCode: ctx.baseCode,
      baseTermType: ctx.baseTermType,
      phrase: side,
    })[0];
    resolved.push({
      side,
      code: hit?.code ?? null,
      ...(hit !== undefined ? { name: hit.name } : {}),
    });
    if (hit !== undefined && !facets.some((facet) => facet.code === hit.code)) {
      facets.push({ header: F04, code: hit.code, name: hit.name });
    }
  }
  const complete = resolved.every((side) => side.code !== null) && facets.length >= 2;
  return {
    facets: complete ? facets : [],
    detail: { via: "or_alternatives", sides, resolved, complete },
  };
}

/** Source facet: walk the natural-source tree. Name search only finds the entry. */
async function resolveSourcePhrase(ctx: PlaceContext, lookup: string): Promise<ClosedResolution> {
  const walked = await resolveSourceWalk(ctx.cat, lookup, {
    model: ctx.model,
    country: ctx.country,
    implied: ctx.implied,
  });
  return {
    facet: walked.facet,
    facets: walked.facet === null ? [] : [walked.facet],
    detail: walked.detail,
  };
}

/**
 * Origin route: base type (or the model) orders F01 / F27 / F04; the first role
 * that places wins. A repeatable list may place several terms. When committing,
 * a choice among them is recorded as one shared group, or as nothing.
 */
async function placeOrigin(
  ctx: PlaceContext,
  lookup: string,
  kind: GapPropertyKind,
  rejectUnderImplied: boolean,
  attempts: Record<string, unknown>[],
  commit = true
): Promise<{ facets: FacetDescriptorRef[]; role: OriginRole | null }> {
  const routed = await originRolesFor(ctx, lookup, kind);
  const roles = routed.roles;
  attempts.push(routed.detail);
  for (const role of roles) {
    const resolved =
      role === "contains"
        ? await resolveF04Phrase(ctx, lookup, { rejectUnderImplied })
        : role === "made_from"
          ? await resolveF27Phrase(ctx, lookup, { rejectUnderImplied })
          : await resolveSourcePhrase(ctx, lookup);
    attempts.push(resolved.detail);
    if (resolved.facets.length === 0) continue;
    const facets = commit
      ? await settlePhraseChoice(ctx, lookup, resolved.facets, attempts)
      : resolved.facets;
    if (commit) {
      for (const facet of facets) addFacet(ctx, facet);
    }
    return { facets, role };
  }
  return { facets: [], role: roles[0] ?? null };
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
 *
 * Runs as two passes (placeFacetsPass, then finishPlacement) so a caller can
 * place every property's Facets dimensions before any origin facet.
 */
async function placeByKind(
  ctx: PlaceContext,
  property: GapProperty,
  onMiss: "freeText" | "drop" = "freeText"
): Promise<Record<string, unknown>> {
  return finishPlacement(ctx, await placeFacetsPass(ctx, property, onMiss));
}

/**
 * Facets whose descriptor names a food in a role (packed in it, risky in it).
 * The role is the more specific statement, so it replaces F04 for that food.
 */
const ROLE_FACET_HEADERS = new Set(["F06", "F25"]);

/** A property after its Facets pass; origin placement and fallbacks are still to come. */
interface FacetsPass {
  property: GapProperty;
  onMiss: "freeText" | "drop";
  /** Essence / name meaning: F04 uses specify-vs-restate under an implied parent.
   * Origin trees (F01/F27) must still allow naming a child organism/commodity
   * under a broad implied source (deer under mammals-as-animal). */
  rejectUnderImplied: boolean;
  attempts: Record<string, unknown>[];
  placed: FacetDescriptorRef[];
  /** Origin routes still to try: picker extras, or the property's own kind. */
  originKinds: GapPropertyKind[];
  walkedHeaders: string[];
  member: boolean;
  otherLabel: string | null;
  /** Set when the Facets pass already settled the property. */
  result: Record<string, unknown> | null;
}

function claimedByRole(pass: FacetsPass): boolean {
  return pass.placed.some((f) => ROLE_FACET_HEADERS.has(f.header));
}

function contentWords(text: string): Set<string> {
  return new Set([...contentTokens(text)].filter((t) => !FUNCTION_WORDS.has(t)));
}

/** Every content word of `inner` appears in `outer` ("brine" in "in brine"). */
export function wordsWithin(inner: string, outer: string): boolean {
  const words = contentWords(inner);
  if (words.size === 0) return false;
  const outerWords = contentWords(outer);
  for (const w of words) if (!outerWords.has(w)) return false;
  return true;
}

export type OriginSlotMatch =
  | { match: "role"; phrase: string }
  | { match: "slot"; phrase: string }
  | { match: "alone" };

/**
 * Where a name's origin entry goes among the collected attributes.
 * A role claim (packed in it, risky in it) keeps the entry out. The same
 * words join that attribute. Anything else is the name's own differentia.
 */
export function matchOriginEntry(
  entry: string,
  slots: Array<{ phrase: string; roleClaim: boolean }>
): OriginSlotMatch {
  const overlaps = (phrase: string) => wordsWithin(entry, phrase) || wordsWithin(phrase, entry);
  const role = slots.find((slot) => slot.roleClaim && overlaps(slot.phrase));
  if (role !== undefined) return { match: "role", phrase: role.phrase };
  const slot = slots.find((slot) => overlaps(slot.phrase));
  if (slot !== undefined) return { match: "slot", phrase: slot.phrase };
  return { match: "alone" };
}

async function placeFacetsPass(
  ctx: PlaceContext,
  property: GapProperty,
  onMiss: "freeText" | "drop"
): Promise<FacetsPass> {
  const { phrase, kind } = property;
  const lookup = property.name ?? phrase;
  const food = walkFood(ctx);
  const attempts: Record<string, unknown>[] = [];
  const rejectUnderImplied = onMiss === "drop";
  const walkAccept = (header: string, code: string): boolean =>
    acceptClosedDescriptor(ctx.cat, header, code, ctx.implied, {
      rejectUnderImplied,
    }) === "keep";
  const pass: FacetsPass = {
    property,
    onMiss,
    rejectUnderImplied,
    attempts,
    placed: [],
    originKinds: [],
    walkedHeaders: [],
    member: false,
    otherLabel: null,
    result: null,
  };
  const settle = (result: Record<string, unknown>): FacetsPass => ({ ...pass, result });

  if (kind === "side") {
    if (onMiss === "drop") {
      return settle({ phrase, kind, placed: "dropped", attempts });
    }
    const value = phrase.replace(/^(with|and)\s+/i, "").trim() || phrase;
    pushFreeText(ctx.freeText, "side", value);
    return settle({
      phrase,
      kind,
      placed: "freeText",
      freeText: { label: "side", value },
      attempts,
    });
  }

  if (isCategoryMember(ctx.descriptionKind, kind)) {
    if (onMiss === "drop") {
      return settle({ phrase, kind, placed: "dropped", reason: "category_member", attempts });
    }
    pushFreeText(ctx.freeText, "member", phrase);
    return settle({
      phrase,
      kind,
      placed: "freeText",
      reason: "category_member",
      freeText: { label: "member", value: phrase },
      attempts,
    });
  }

  if (kind === "unsorted") {
    const picked = await pickFacets(ctx.cat, phrase, facetDimensions(ctx.cat), ORIGIN_PICKS, {
      model: ctx.model,
      accept: walkAccept,
      food,
      country: ctx.country,
    });
    attempts.push(picked.detail);
    let droppedRaw = false;
    for (const code of picked.codes) {
      if (code === "made_from" || code === "added") {
        if (isCategoryMember(ctx.descriptionKind, code)) pass.member = true;
        else pass.originKinds.push(code);
        continue;
      }
      pass.walkedHeaders.push(code);
      const walked = await resolveFacetWalk(ctx.cat, phrase, [code], {
        model: ctx.model,
        accept: walkAccept,
        food,
        country: ctx.country,
      });
      attempts.push(walked.detail);
      for (const facet of walked.facets) {
        if (rawNoHeatOnRawCommodity(ctx.baseTermType, facet)) {
          droppedRaw = true;
          continue;
        }
        if (addFacet(ctx, facet)) pass.placed.push(facet);
      }
    }
    if (claimedByRole(pass) && pass.originKinds.length > 0) {
      attempts.push({ via: "origin_skipped", reason: "role_facet", originKinds: pass.originKinds });
      pass.originKinds = [];
    }
    if (droppedRaw && pass.placed.length === 0 && pass.originKinds.length === 0 && !pass.member) {
      return settle({ phrase, kind, placed: "none", reason: "raw_on_rpc", attempts });
    }
    return pass;
  }

  if (kind === "ingredient" || kind === "source" || kind === "made_from" || kind === "added") {
    pass.originKinds.push(kind);
    return pass;
  }

  if (kind === "process") {
    const process = await resolveFacetWalk(ctx.cat, lookup, [F28], {
      model: ctx.model,
      accept: walkAccept,
      food,
      country: ctx.country,
    });
    attempts.push(process.detail);
    const recordedProcess = process.facets.filter((facet) => addFacet(ctx, facet));
    if (recordedProcess.length > 0) {
      return settle({
        phrase,
        kind,
        placed: "facet",
        facet: recordedProcess[0],
        ...(recordedProcess.length > 1 ? { facets: recordedProcess } : {}),
        attempts,
      });
    }
    if (process.facets.some((facet) => rawNoHeatOnRawCommodity(ctx.baseTermType, facet))) {
      return settle({ phrase, kind, placed: "none", reason: "raw_on_rpc", attempts });
    }
  } else if (kind === "other") {
    const dimensions = facetDimensions(ctx.cat);
    const opened = await openFacetDimensions(ctx.cat, lookup, dimensions, {
      model: ctx.model,
      accept: walkAccept,
      food,
      country: ctx.country,
    });
    attempts.push(opened.detail);
    const walked = await resolveFacetWalk(ctx.cat, lookup, opened.headers, {
      model: ctx.model,
      accept: walkAccept,
      food,
      country: ctx.country,
    });
    attempts.push(walked.detail);
    const recorded = walked.facets.filter((facet) => addFacet(ctx, facet));
    if (recorded.length > 0) {
      return settle({
        phrase,
        kind,
        header: recorded[0]!.header,
        placed: "facet",
        facet: recorded[0],
        ...(recorded.length > 1 ? { facets: recorded } : {}),
        attempts,
      });
    }
    if (walked.facets.some((facet) => rawNoHeatOnRawCommodity(ctx.baseTermType, facet))) {
      return settle({ phrase, kind, placed: "none", reason: "raw_on_rpc", attempts });
    }
    if (opened.headers.length === 1) {
      pass.otherLabel =
        ctx.cat.facetCategory(opened.headers[0]!)?.label ?? opened.headers[0]!;
    }
  }
  return pass;
}

/**
 * Origin facets for a property after its Facets pass, then the miss path.
 * `skipOrigin`: the origin question or essence already placed this food, so
 * the input's own origin wording is not placed again.
 */
async function finishPlacement(
  ctx: PlaceContext,
  pass: FacetsPass,
  skipOrigin = false
): Promise<Record<string, unknown>> {
  if (pass.result !== null) return pass.result;
  const { property, onMiss, attempts, placed } = pass;
  const { phrase, kind } = property;
  const lookup = property.name ?? phrase;
  let originRole: OriginRole | null = null;
  let otherLabel = pass.otherLabel;
  const skipped = skipOrigin && pass.originKinds.length > 0;

  if (skipped) {
    attempts.push({ via: "origin_skipped", reason: "origin_already_placed", phrase: lookup });
  } else {
    for (const originKind of pass.originKinds) {
      const origin = await placeOrigin(ctx, lookup, originKind, pass.rejectUnderImplied, attempts);
      originRole ??= origin.role;
      placed.push(...origin.facets);
    }
  }

  if (kind === "unsorted") {
    if (placed.length > 0) {
      return { phrase, kind, placed: "facet", facet: placed[0], facets: placed, attempts };
    }
    if (pass.member) {
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
    if (originRole === null && pass.walkedHeaders.length === 1) {
      const header = pass.walkedHeaders[0]!;
      otherLabel = ctx.cat.facetCategory(header)?.label ?? header;
    }
  } else if (placed.length > 0) {
    return {
      phrase,
      kind,
      originRole,
      placed: "facet",
      facet: placed[0],
      ...(placed.length > 1 ? { facets: placed } : {}),
      attempts,
    };
  }

  if (skipped) {
    return { phrase, kind, placed: "dropped", reason: "origin_already_placed", attempts };
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

/** How the input relates to the base's children (systemF26Relation). */
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
  options: { model: string; country?: string | null }
): Promise<{ facet: FacetDescriptorRef | null; detail: Record<string, unknown> }> {
  if ([...impliedKeys(cat, baseCode)].some((key) => key.startsWith(`${F26}.`))) {
    return { facet: null, detail: { reason: "already_implied" } };
  }
  const baseTerm = cat.term(baseCode);
  const baseDetailLevel = baseTerm?.detailLevel ?? null;
  const children = siblingChildrenForF26(cat, baseCode);

  let relation: F26Relation | null = null;
  let model: string | undefined;
  const country = options.country ?? null;
  if (children.length > 0) {
    const answered = await chatJson({
      model: options.model,
      system: systemF26Relation(country !== null),
      user: JSON.stringify(
        {
          input,
          ...(country !== null ? { country } : {}),
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
    const f26 = await chooseF26(ctx.cat, ctx.input, ctx.baseCode, {
      model: ctx.model,
      country: ctx.country,
    });
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

  const included = await askIncludedFacets(ctx, cleaned.facets);
  if (included !== null) {
    audit.push({ step: "residuals_economize", detail: included.detail });
  }
  const sorted = sortFacets(included?.facets ?? cleaned.facets);
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

function facetSelectTerms(
  cat: Catalogue,
  facets: FacetDescriptorRef[]
): Array<{ code: string; name: string; list: string; note?: string; single: boolean }> {
  return facets.map((facet) => {
    const note = cat.term(facet.code)?.scopeNote?.trim();
    const list = cat.facetCategory(facet.header)?.label ?? facet.header;
    return {
      code: `${facet.header}.${facet.code}`,
      name: facet.name,
      list,
      single: facetCardinality(facet.header)?.flag !== "repeatable",
      ...(note ? { note } : {}),
    };
  });
}

/**
 * Codes the gate returned, in that order, dropping anything not offered.
 * A single facet keeps the first of its codes. A repeatable facet keeps each.
 */
export function limitFacetSelection(
  codes: string[],
  candidates: FacetDescriptorRef[]
): FacetDescriptorRef[] {
  const out: FacetDescriptorRef[] = [];
  const singleUsed = new Set<string>();
  for (const code of codes) {
    const matches = candidates.filter((facet) => `${facet.header}.${facet.code}` === code);
    const facet =
      matches[0] ??
      (candidates.filter((item) => item.code === code).length === 1
        ? candidates.find((item) => item.code === code)
        : undefined);
    if (facet === undefined) continue;
    if (out.some((kept) => kept.header === facet.header && kept.code === facet.code)) continue;
    if (facetCardinality(facet.header)?.flag !== "repeatable") {
      if (singleUsed.has(facet.header)) continue;
      singleUsed.add(facet.header);
    }
    out.push(facet);
  }
  return out;
}

/**
 * Origin follows the base term's type (`origin`, from a `made_from` lookup).
 * The same class found again as an ingredient is that origin, not a second
 * statement. A different class is something the food contains, and stays.
 */
export function settleOriginCandidates(
  origin: readonly FacetDescriptorRef[],
  added: readonly FacetDescriptorRef[]
): FacetDescriptorRef[] {
  const originCodes = new Set(origin.map((facet) => facet.code));
  const out: FacetDescriptorRef[] = [];
  for (const facet of origin) {
    if (out.some((kept) => kept.header === facet.header && kept.code === facet.code)) continue;
    out.push(facet);
  }
  for (const facet of added) {
    if (originCodes.has(facet.code)) continue;
    if (out.some((kept) => kept.header === facet.header && kept.code === facet.code)) continue;
    out.push(facet);
  }
  return out;
}

function keepFacetCandidate(
  ctx: PlaceContext,
  facet: FacetDescriptorRef | null,
  into: FacetDescriptorRef[]
): void {
  if (facet === null) return;
  if (into.some((f) => f.header === facet.header && f.code === facet.code)) return;
  if (redundantCommoditySource(ctx, facet)) return;
  if (acceptClosedDescriptor(ctx.cat, facet.header, facet.code, ctx.implied) !== "keep") return;
  into.push(facet);
}

/**
 * Whether `phrase` names something added to the food. The plant, animal, or
 * commodity the food comes from is not an addition, so it is not an ingredient.
 */
export function systemAddedIngredient(withCountry: boolean): string {
  return `You are an expert in food classification.

Does \`phrase\` name something added to the food?

Given:
- \`description\`: the food.
- \`baseTerm\`: the food group already chosen, with its name.
- \`phrase\`: words from the description.
${countryParagraph(withCountry, "description")}
Something added is put into the food or onto it. The plant, animal, or commodity the food comes from is not something added.

Reply with JSON only:
{"added":true|false}
`;
}

/** True only when the reply explicitly says the phrase names an addition. */
export function parseAddedClaim(content: unknown): boolean {
  if (content === null || typeof content !== "object") return false;
  return (content as { added?: unknown }).added === true;
}

async function askAddedIngredient(
  ctx: PlaceContext,
  phrase: string
): Promise<{ added: boolean; detail: Record<string, unknown> }> {
  const withCountry = ctx.country !== null && ctx.country !== "";
  const answered = await chatJson({
    model: ctx.model,
    system: systemAddedIngredient(withCountry),
    user: JSON.stringify(
      {
        description: ctx.input,
        ...(withCountry ? { country: ctx.country } : {}),
        baseTerm: { name: ctx.baseName },
        phrase,
      },
      null,
      2
    ),
  });
  const added = parseAddedClaim(answered.content);
  return {
    added,
    detail: { via: "added_ingredient", model: answered.model, phrase, added },
  };
}

/**
 * Every route may propose one candidate for this attribute, or none.
 * Nothing is recorded until the gate chooses.
 */
async function collectSlotCandidates(
  ctx: PlaceContext,
  phrase: string
): Promise<{ candidates: FacetDescriptorRef[]; attempts: Record<string, unknown>[] }> {
  const attempts: Record<string, unknown>[] = [];
  const candidates: FacetDescriptorRef[] = [];
  const food = walkFood(ctx);
  const walkAccept = (header: string, code: string): boolean =>
    acceptClosedDescriptor(ctx.cat, header, code, ctx.implied) === "keep";

  const dimensions = facetDimensions(ctx.cat).filter(
    (dimension) => ctx.named === null || (dimension.header !== F28 && dimension.header !== F20)
  );
  const picked = await pickFacets(ctx.cat, phrase, dimensions, [], {
    model: ctx.model,
    accept: walkAccept,
    food,
    country: ctx.country,
  });
  attempts.push(picked.detail);
  for (const header of picked.codes) {
    const walked = await resolveFacetWalk(ctx.cat, phrase, [header], {
      model: ctx.model,
      accept: walkAccept,
      food,
      country: ctx.country,
    });
    attempts.push(walked.detail);
    for (const facet of walked.facets) keepFacetCandidate(ctx, facet, candidates);
  }

  const origin = await placeOrigin(ctx, phrase, "made_from", false, attempts, false);
  const addition = await askAddedIngredient(ctx, phrase);
  attempts.push(addition.detail);
  const added = addition.added
    ? await placeOrigin(ctx, phrase, "added", false, attempts, false)
    : { facets: [] as FacetDescriptorRef[] };
  for (const facet of settleOriginCandidates(origin.facets, added.facets)) {
    keepFacetCandidate(ctx, facet, candidates);
  }

  const fortification = await askFortification(ctx, phrase);
  attempts.push(fortification.detail);
  if (fortification.claim.status === "bare") {
    keepFacetCandidate(ctx, bareFortifiedFacet(ctx.cat, ctx.implied), candidates);
  } else if (fortification.claim.status === "agents") {
    for (const agent of fortification.claim.agents) {
      const resolved = await resolveClosedFacetPhrase(ctx.cat, agent, F09, ctx.implied, {
        model: ctx.model,
        allowRootFallback: false,
        country: ctx.country,
      });
      attempts.push(resolved.detail);
      keepFacetCandidate(ctx, resolved.facet, candidates);
    }
  }

  const numeric = await askNumericContent(ctx, phrase);
  attempts.push(numeric.detail);
  if (numeric.claim.fatPercent !== null) {
    keepFacetCandidate(ctx, nearestFatFacet(ctx.cat, numeric.claim.fatPercent), candidates);
  }
  if (numeric.claim.alcoholPercent !== null) {
    keepFacetCandidate(ctx, nearestAlcoholFacet(ctx.cat, numeric.claim.alcoholPercent), candidates);
  }

  return { candidates, attempts };
}

function namedPhrases(ctx: PlaceContext): string[] {
  if (ctx.named === null) return [];
  return [...ctx.named.processes, ...ctx.named.parts]
    .map((item) => item.phrase)
    .filter((phrase): phrase is string => phrase !== null && phrase.trim() !== "");
}

/** An attribute no facet records. Words that share a named process or part are not repeated as free text. */
function unplacedAttribute(ctx: PlaceContext, phrase: string): void {
  const overlaps = namedPhrases(ctx).some(
    (named) => wordsWithin(named, phrase) || wordsWithin(phrase, named)
  );
  if (!overlaps) pushFreeText(ctx.freeText, "attribute", phrase);
}

/**
 * Places the processes and parts named before placement. A descriptor the
 * base term already carries, or one broader than it, is not added.
 */
function placeNamedFacets(ctx: PlaceContext, audit: AuditEntry[]): void {
  if (ctx.named === null) return;
  const placed: FacetDescriptorRef[] = [];
  const skipped: Array<{ header: string; code: string; reason: string }> = [];
  const items = [
    ...ctx.named.processes.map((item) => ({ header: F28, code: item.code })),
    ...ctx.named.parts.map((item) => ({ header: F20, code: item.code })),
  ];
  for (const { header, code } of items) {
    const verdict = acceptClosedDescriptor(ctx.cat, header, code, ctx.implied);
    if (verdict !== "keep") {
      skipped.push({ header, code, reason: verdict });
      continue;
    }
    const facet = { header, code, name: ctx.cat.term(code)?.name ?? code };
    if (addFacet(ctx, facet)) placed.push(facet);
    else skipped.push({ header, code, reason: "not_added" });
  }
  audit.push({
    step: "residuals_named",
    detail: { named: ctx.named, placed, ...(skipped.length > 0 ? { skipped } : {}) },
  });
}

async function placeAttributeSlot(
  ctx: PlaceContext,
  phrase: string,
  prepared?: { candidates: FacetDescriptorRef[]; attempts: Record<string, unknown>[] }
): Promise<Record<string, unknown>> {
  if (originCoversPhrase(phrase, ctx.originCovered)) {
    return { phrase, placed: "covered" };
  }
  const { candidates, attempts } = prepared ?? (await collectSlotCandidates(ctx, phrase));
  const listed = candidates.map((f) => ({ header: f.header, code: f.code, name: f.name }));
  if (candidates.length === 0) {
    unplacedAttribute(ctx, phrase);
    return { phrase, placed: "freeText", candidates: listed, attempts };
  }
  const onlyHeader = candidates[0]!.header;
  const oneRepeatableList =
    candidates.every((facet) => facet.header === onlyHeader) &&
    facetCardinality(onlyHeader)?.flag === "repeatable";
  let model: string | undefined;
  let chosen: FacetDescriptorRef[];
  if (!oneRepeatableList && candidates.length > 1) {
    const picked = await selectStatedFacet(phrase, facetSelectTerms(ctx.cat, candidates), {
      model: ctx.model,
      description: ctx.input,
      country: ctx.country,
    });
    model = picked.model;
    chosen = limitFacetSelection(picked.codes, candidates);
    if (chosen.length === 0) {
      unplacedAttribute(ctx, phrase);
      return { phrase, placed: "none", pick: picked.codes, candidates: listed, attempts, model };
    }
  } else {
    chosen = candidates;
  }
  const choice = orChoiceFacets(ctx, phrase);
  if (choice !== null) {
    attempts.push(choice.detail);
    chosen =
      choice.facets.length >= 2
        ? [...chosen.filter((facet) => facet.header !== F04), ...choice.facets]
        : chosen.filter((facet) => facet.header !== F04);
  }
  if (chosen.length === 0) {
    unplacedAttribute(ctx, phrase);
    return { phrase, placed: "none", candidates: listed, attempts, ...(model !== undefined ? { model } : {}) };
  }
  const settled = await settlePhraseChoice(
    ctx,
    phrase,
    chosen,
    attempts,
    choice !== null && choice.facets.length >= 2 ? F04 : null
  );
  if (settled.length === 0) {
    unplacedAttribute(ctx, phrase);
    return { phrase, placed: "none", candidates: listed, attempts, ...(model !== undefined ? { model } : {}) };
  }
  const reportable = settled.filter((facet) => !rawNoHeatOnRawCommodity(ctx.baseTermType, facet));
  if (reportable.length === 0) {
    return {
      phrase,
      placed: "none",
      reason: "raw_on_rpc",
      candidates: listed,
      attempts,
      ...(model !== undefined ? { model } : {}),
    };
  }
  const recorded: FacetDescriptorRef[] = [];
  for (const facet of reportable) {
    if (addFacet(ctx, facet)) recorded.push(facet);
  }
  return {
    phrase,
    placed: recorded.length > 0 ? "facet" : "duplicate",
    ...(recorded.length > 0
      ? {
          facet: recorded[0],
          ...(recorded.length > 1 ? { facets: recorded } : {}),
        }
      : {}),
    candidates: listed,
    attempts,
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * A derivative is made from a raw commodity. Ask for that commodity and search
 * the source-commodities list. A core or extended commodity stands. A hierarchy,
 * generic, or non-specific commodity does not: ask for the natural source, and
 * when that source is core or extended, it replaces the commodity. When the
 * commodity search places nothing, ask for the natural source anyway.
 * The phrase that was placed covers a later attribute that only restates it.
 */

/** Core (C) and extended (E) terms stand over hierarchy, generic, and non-specific terms. */
export function isPreferredDetail(detailLevel: string | null): boolean {
  return detailLevel === "C" || detailLevel === "E";
}

/**
 * A core or extended natural source replaces a commodity that is not one.
 * An empty commodity list means the source search is the only result.
 */
export function sourceReplacesCommodity(
  commodityLevels: readonly (string | null)[],
  sourceLevels: readonly (string | null)[]
): boolean {
  if (commodityLevels.length === 0) return false;
  if (commodityLevels.some((level) => isPreferredDetail(level))) return false;
  return sourceLevels.some((level) => isPreferredDetail(level));
}

/**
 * True when the plant or animal `sourceCode` says more than the commodities
 * already imply: it lies below the organism one of them implies, or none of
 * them implies an organism. Crustaceans implies Crustaceans (as animal), so
 * that animal adds nothing and the commodity stands.
 */
export function sourceNarrowsCommodities(
  cat: Catalogue,
  commodityCodes: readonly string[],
  sourceCode: string
): boolean {
  const hierarchy = cat.facetCategory(F01)?.hierarchyCode;
  const organisms = commodityCodes.flatMap((code) =>
    cat
      .impliedFacets(code)
      .filter((key) => key.startsWith(`${F01}.`))
      .map((key) => key.slice(F01.length + 1))
  );
  if (organisms.length === 0 || hierarchy === undefined) return true;
  return organisms.some(
    (organism) => organism !== sourceCode && cat.isAncestor(organism, sourceCode, hierarchy)
  );
}

/**
 * Plants and animals already named by the source commodities a base denotes.
 * A derivative that implies Grapefruits already implies Grapefruit (as plant),
 * one step further on, even though the juice's own implicit list stops at the fruit.
 */
function commoditySourceCodes(cat: Catalogue, baseCode: string): string[] {
  const out: string[] = [];
  for (const key of cat.impliedFacets(baseCode)) {
    if (!key.startsWith(`${F27}.`)) continue;
    const commodity = key.slice(F27.length + 1);
    for (const implied of cat.impliedFacets(commodity)) {
      if (implied.startsWith(`${F01}.`)) out.push(implied.slice(F01.length + 1));
    }
  }
  return out;
}

/**
 * True when `sourceCode` is the plant or animal one of the base's source
 * commodities already implies, or a broader group above that organism.
 * A child of that organism is a tighter source and is not redundant.
 */
export function sourceRestatesCommodity(
  cat: Catalogue,
  baseCode: string,
  sourceCode: string
): boolean {
  const hierarchy = cat.facetCategory(F01)?.hierarchyCode;
  for (const plant of commoditySourceCodes(cat, baseCode)) {
    if (sourceCode === plant) return true;
    if (hierarchy !== undefined && cat.isAncestor(sourceCode, plant, hierarchy)) return true;
  }
  return false;
}

/** A derivative does not record the source its commodity already implies. */
function redundantCommoditySource(ctx: PlaceContext, facet: FacetDescriptorRef): boolean {
  return (
    ctx.baseTermType === "d" &&
    facet.header === F01 &&
    sourceRestatesCommodity(ctx.cat, ctx.baseCode, facet.code)
  );
}
export function systemRawCommodity(withCountry: boolean): string {
  return `You are an expert in food classification.

Task: name the raw commodity this food is made from, when the description names a more specific commodity than the one the base term already denotes.

Given:
- \`description\`: the food.
- \`baseTerm\`: the food group already chosen, with its \`name\` and its \`scope\`.
- \`sourceCommodities\`: the raw commodities the base term already denotes.
${countryParagraph(withCountry, "description")}
Name the commodity by narrowing one of those to the kind the description states. When the description names nothing more specific, return null.

Reply with JSON only:
{"commodity":"<phrase>"|null}
`;
}

export function systemNaturalSource(withCountry: boolean): string {
  return `You are an expert in food classification.

Task: name the natural source this food comes from, when the description names a more specific one than the base term already denotes.

Given:
- \`description\`: the food.
- \`baseTerm\`: the food group already chosen, with its \`name\` and its \`scope\`.
${countryParagraph(withCountry, "description")}
When the description names nothing more specific, return null.

Reply with JSON only:
{"source":"<phrase>"|null}
`;
}

function parseNamedPhrase(content: unknown, key: "commodity" | "source"): string | null {
  if (content === null || typeof content !== "object") return null;
  const raw = (content as Record<string, unknown>)[key];
  if (typeof raw !== "string") return null;
  const phrase = raw.trim();
  return phrase === "" ? null : phrase;
}

export function parseRawCommodity(content: unknown): string | null {
  return parseNamedPhrase(content, "commodity");
}

export function parseNaturalSource(content: unknown): string | null {
  return parseNamedPhrase(content, "source");
}

/** True when every content word of `phrase` sits inside an origin already placed. */
export function originCoversPhrase(phrase: string, origins: readonly string[]): boolean {
  return origins.some((origin) => wordsWithin(phrase, origin));
}

function impliedCommodityNames(ctx: PlaceContext): string[] {
  return [...ctx.implied]
    .filter((key) => key.startsWith(`${F27}.`))
    .map((key) => ctx.cat.term(key.slice(F27.length + 1))?.name ?? key.slice(F27.length + 1));
}

async function placeDerivativeCommodity(ctx: PlaceContext, audit: AuditEntry[]): Promise<void> {
  if (ctx.baseTermType !== "d") return;
  const withCountry = ctx.country !== null && ctx.country !== "";
  const baseTerm = {
    name: ctx.baseName,
    scope: genusScope(ctx.cat.term(ctx.baseCode)?.scopeNote),
  };
  const asked = await chatJson({
    model: ctx.model,
    system: systemRawCommodity(withCountry),
    user: JSON.stringify(
      {
        description: ctx.input,
        ...(withCountry ? { country: ctx.country } : {}),
        baseTerm,
        sourceCommodities: impliedCommodityNames(ctx),
      },
      null,
      2
    ),
  });
  const commodity = parseRawCommodity(asked.content);
  const recorded: FacetDescriptorRef[] = [];
  const attempts: Record<string, unknown>[] = [];
  if (commodity !== null) {
    const resolved = await resolveF27Phrase(ctx, commodity);
    for (const facet of await settleCategorySources(ctx, commodity, resolved.facets, attempts)) {
      if (addFacet(ctx, facet)) recorded.push(facet);
    }
    if (recorded.length > 0) ctx.originCovered.push(commodity);
  }

  const commodityStands = recorded.some((facet) => isPreferredDetail(facetDetail(ctx, facet)));
  let source: string | null = null;
  const sourceRecorded: FacetDescriptorRef[] = [];
  const redundantSource: FacetDescriptorRef[] = [];
  if (!commodityStands) {
    const named = await chatJson({
      model: ctx.model,
      system: systemNaturalSource(withCountry),
      user: JSON.stringify(
        {
          description: ctx.input,
          ...(withCountry ? { country: ctx.country } : {}),
          baseTerm,
        },
        null,
        2
      ),
    });
    source = parseNaturalSource(named.content);
    if (source !== null) {
      const resolved = await resolveSourcePhrase(ctx, source);
      for (const facet of await settleCategorySources(ctx, source, resolved.facets, attempts)) {
        if (redundantCommoditySource(ctx, facet)) {
          redundantSource.push(facet);
          continue;
        }
        if (addFacet(ctx, facet)) sourceRecorded.push(facet);
      }
    }
  }

  const replaced =
    sourceReplacesCommodity(
      recorded.map((facet) => facetDetail(ctx, facet)),
      sourceRecorded.map((facet) => facetDetail(ctx, facet))
    ) &&
    sourceRecorded.some((facet) =>
      sourceNarrowsCommodities(
        ctx.cat,
        recorded.map((commodity) => commodity.code),
        facet.code
      )
    );
  if (replaced) {
    for (const facet of recorded) removeFacet(ctx, facet);
  } else if (recorded.length > 0) {
    for (const facet of sourceRecorded) removeFacet(ctx, facet);
    sourceRecorded.length = 0;
  }
  if (source !== null && sourceRecorded.length > 0) ctx.originCovered.push(source);
  if (
    ctx.descriptionKind === "category" &&
    commodity !== null &&
    recorded.length === 0 &&
    sourceRecorded.length === 0 &&
    wordsWithin(commodity, ctx.input) &&
    !wordsWithin(commodity, ctx.baseName)
  ) {
    pushFreeText(ctx.freeText, "member", commodity);
  }

  let narrowed: FacetDescriptorRef | null = null;
  let narrowedDetail: Record<string, unknown> | null = null;
  const sole = !replaced && recorded.length === 1 ? recorded[0]! : null;
  const impliedSource = sole !== null && commodityStands ? impliedSourceOf(ctx.cat, sole.code) : null;
  if (sole !== null && impliedSource !== null && commodity !== null) {
    const country = ctx.country?.trim() || europeanUnionName();
    const matched = await matchCommoditySource(ctx.cat, commodity, impliedSource, {
      model: ctx.model,
      country,
    });
    narrowedDetail = matched.detail;
    if (matched.facet !== null && addFacet(ctx, matched.facet)) {
      narrowed = matched.facet;
      ctx.protectedFacets.add(`${sole.header}.${sole.code}`);
    }
  }

  audit.push({
    step: "residuals_commodity",
    detail: {
      commodity,
      recorded: replaced ? [] : recorded,
      ...(replaced ? { droppedCommodity: recorded } : {}),
      ...(source !== null || sourceRecorded.length > 0 ? { source, sourceRecorded } : {}),
      ...(redundantSource.length > 0 ? { redundantSource } : {}),
      ...(narrowed !== null ? { narrowed } : {}),
      ...(narrowedDetail !== null ? { narrowedDetail } : {}),
      replaced,
      covered: [...ctx.originCovered],
      ...(attempts.length > 0 ? { attempts } : {}),
    },
  });
}

/** The one animal or plant a commodity implies, when it implies exactly one. */
function impliedSourceOf(cat: Catalogue, code: string): string | null {
  const sources = cat
    .impliedFacets(code)
    .filter((key) => key.startsWith(`${F01}.`))
    .map((key) => key.slice(F01.length + 1));
  return sources.length === 1 ? sources[0]! : null;
}

function europeanUnionName(): string {
  const resolved = resolveCountry(DEFAULT_COUNTRY_CODE);
  return resolved.ok ? resolved.name : "European Union";
}

/** Attributes the description still states, given a locked base term. */
export async function listAttributeSlots(
  input: string,
  baseTerm: BaseTermRef,
  options: { model?: string; country?: string | null } = {}
): Promise<{ model: string; attributes: string[]; omitted: GapOmitted[] }> {
  const cat = Catalogue.load();
  const model = options.model?.trim() || defaultModel();
  const country = options.country ?? null;
  const implicits = impliedNamed(cat, baseTerm.code).map(({ key, name }) => {
    const header = key.split(".")[0] ?? key;
    return `${cat.facetCategory(header)?.label ?? header}: ${name}`;
  });
  const listed = await chatJson({
    model,
    system: systemAttributeSlots(country !== null && country !== ""),
    user: JSON.stringify(
      {
        description: input,
        ...(country !== null && country !== "" ? { country } : {}),
        baseTerm: { code: baseTerm.code, name: cat.term(baseTerm.code)?.name ?? baseTerm.name },
        implicits,
      },
      null,
      2
    ),
  });
  const parsed = parseAttributeSlots(listed.content);
  const attributes: string[] = [];
  const omitted = [...parsed.omitted];
  for (const phrase of parsed.attributes) {
    if (!queryTokensInText(phrase, input)) {
      omitted.push({ phrase, reason: "not_in_input" });
      continue;
    }
    attributes.push(phrase);
  }
  return { model: listed.model, attributes, omitted };
}

/**
 * The legacy leftover list, for comparison. `called` is the whole description,
 * and nothing is covered yet, so the difference from the slot list is the split.
 */
export async function listLegacyInputProperties(
  input: string,
  baseTerm: BaseTermRef,
  options: { model?: string; country?: string | null } = {}
): Promise<{ model: string; properties: string[]; omitted: GapOmitted[] }> {
  const cat = Catalogue.load();
  const model = options.model?.trim() || defaultModel();
  const country = options.country ?? null;
  const implicits = impliedNamed(cat, baseTerm.code).map(({ key, name }) => {
    const header = key.split(".")[0] ?? key;
    return `${cat.facetCategory(header)?.label ?? header}: ${name}`;
  });
  const listed = await chatJson({
    model,
    system: systemFoodstuffInput(country !== null && country !== ""),
    user: JSON.stringify(
      {
        input,
        ...(country !== null && country !== "" ? { country } : {}),
        called: input,
        baseTerm: { code: baseTerm.code, name: cat.term(baseTerm.code)?.name ?? baseTerm.name },
        implicits,
        covered: { facets: [], freeText: [] },
      },
      null,
      2
    ),
  });
  const raw = asUnsorted(parseGapProperties(listed.content));
  const filtered = filterPropertiesToInput(raw, input);
  return {
    model: listed.model,
    properties: filtered.kept.map((p) => p.phrase),
    omitted: [
      ...parseGapOmitted(listed.content),
      ...filtered.dropped.map((d) => ({ phrase: d.phrase, reason: d.reason })),
    ],
  };
}

/**
 * Differentiae of this foodstuff within its genus. Each phrase is placed as a
 * facet. Empty when the genus already denotes the food.
 */
async function askFoodOrigin(
  ctx: PlaceContext,
  description: string,
  implicit: string[],
  audit: AuditEntry[]
): Promise<{ name: string; from: GapProperty[] }> {
  const country = ctx.country;
  const asked = await chatJson({
    model: ctx.model,
    system: systemDifferentiae(country !== null),
    user: JSON.stringify(
      {
        description,
        ...(country !== null ? { country } : {}),
        genus: {
          name: ctx.baseName,
          descriptors: implicit,
          scope: genusScope(ctx.cat.term(ctx.baseCode)?.scopeNote),
        },
      },
      null,
      2
    ),
  });
  const differentiae = parseDifferentiae(asked.content);
  const filtered = dropEarlyClaimRestatements(
    differentiae.map((entry): GapProperty => ({ phrase: entry, kind: "other", name: entry })),
    ctx.fortificationClaim,
    ctx.numericClaim
  );
  audit.push({
    step: "residuals_origin",
    detail: {
      model: asked.model,
      description,
      differentiae,
      fit: ctx.fit,
      ...(filtered.dropped.length > 0 ? { droppedEarlyClaims: filtered.dropped } : {}),
    },
  });
  return { name: description, from: filtered.kept };
}

async function assignResidualSlots(
  ctx: PlaceContext,
  input: string,
  audit: AuditEntry[]
): Promise<AssignResidualsOk> {
  const baseTerm = { code: ctx.baseCode, name: ctx.baseName };
  const listed = await listAttributeSlots(input, baseTerm, {
    model: ctx.model,
    country: ctx.country,
  });
  ctx.food = stripAttributePhrases(input, [...listed.attributes, ...namedPhrases(ctx)]);
  audit.push({
    step: "residuals_slots",
    detail: {
      model: listed.model,
      food: ctx.food,
      attributes: listed.attributes,
      ...(listed.omitted.length > 0 ? { omitted: listed.omitted } : {}),
    },
  });

  placeNamedFacets(ctx, audit);
  await placeDerivativeCommodity(ctx, audit);

  const drafts = [];
  for (const phrase of listed.attributes) {
    if (originCoversPhrase(phrase, ctx.originCovered)) {
      drafts.push({
        phrase,
        candidates: [],
        attempts: [{ via: "covered_origin" }],
        roleClaim: false,
      });
      continue;
    }
    const collected = await collectSlotCandidates(ctx, phrase);
    drafts.push({
      phrase,
      candidates: collected.candidates,
      attempts: collected.attempts,
      roleClaim: collected.candidates.some((facet) => ROLE_FACET_HEADERS.has(facet.header)),
    });
  }

  const originResolutions = [];
  if (ctx.descriptionKind === "foodstuff") {
    const implicit = impliedNamed(ctx.cat, ctx.baseCode).map(({ key, name }) => {
      const header = key.split(".")[0] ?? key;
      return `${ctx.cat.facetCategory(header)?.label ?? header}: ${name}`;
    });
    const origin = await askFoodOrigin(ctx, ctx.food, implicit, audit);
    for (const property of origin.from) {
      const entry = property.name ?? property.phrase;
      if (originCoversPhrase(entry, ctx.originCovered)) {
        originResolutions.push({ phrase: entry, placed: "covered" });
        continue;
      }
      const matched = matchOriginEntry(entry, drafts);
      if (matched.match === "role") {
        originResolutions.push({ phrase: entry, placed: "dropped", reason: "role_facet", slot: matched.phrase });
        continue;
      }
      const collected = await collectSlotCandidates(ctx, entry);
      if (matched.match === "slot") {
        const draft = drafts.find((slot) => slot.phrase === matched.phrase);
        if (draft !== undefined) {
          draft.attempts.push(...collected.attempts, { via: "differentia", phrase: entry });
          for (const facet of collected.candidates) keepFacetCandidate(ctx, facet, draft.candidates);
        }
        originResolutions.push({
          phrase: entry,
          placed: "joined",
          slot: matched.phrase,
          attempts: collected.attempts,
        });
        continue;
      }
      if (collected.candidates.length === 0) {
        originResolutions.push({
          phrase: entry,
          placed: "dropped",
          reason: "no_facet",
          attempts: collected.attempts,
        });
        continue;
      }
      originResolutions.push(await placeAttributeSlot(ctx, entry, collected));
    }
  }

  const resolutions: Record<string, unknown>[] = [];
  for (const draft of drafts) {
    resolutions.push(
      await placeAttributeSlot(ctx, draft.phrase, {
        candidates: draft.candidates,
        attempts: draft.attempts,
      })
    );
  }
  return finishResiduals(ctx, audit, {
    from: "slots",
    resolutions,
    ...(originResolutions.length > 0 ? { origin: originResolutions } : {}),
  });
}

/**
 * A composite dish: the dish name in text when the shelf does not name it, the
 * principal characterising ingredients, one descriptor choice per facet, and a
 * gate that keeps the chosen descriptors that narrow the code towards the
 * described food.
 */
async function assignDishRoute(
  ctx: PlaceContext,
  input: string,
  dishPhrase: string,
  audit: AuditEntry[]
): Promise<AssignResidualsResult> {
  const span = findDishSpan(input, dishPhrase);
  if (span === null) {
    audit.push({
      step: "residuals_essence_ungrounded",
      detail: { reason: "name_not_in_input", name: dishPhrase, descriptionKind: ctx.descriptionKind },
    });
    return {
      status: "rejected",
      reason: "named_dish_ungrounded",
      message: `Dish name ${JSON.stringify(dishPhrase)} is not a substring of the input`,
      audit,
    };
  }
  if (!foodMatchesBaseTerm(span.span, ctx.baseCode, ctx.baseName)) {
    pushFreeText(ctx.freeText, "dish", span.span);
  }

  const country = ctx.country !== null && ctx.country !== "" ? ctx.country : null;
  const withCountry = country !== null;
  const countryField = country !== null ? { country } : {};
  const shelf = { name: ctx.baseName, scope: genusScope(ctx.cat.term(ctx.baseCode)?.scopeNote) };
  const ask = (system: string, user: Record<string, unknown>) =>
    chatJson({
      model: ctx.model,
      system,
      user: JSON.stringify({ description: input, ...user, ...countryField }, null, 2),
    });

  const [ingredientsAnswer, selections] = await Promise.all([
    ask(systemDishIngredients(withCountry), { group: shelf }),
    Promise.all(
      dishFacets(ctx.baseTermType).map(async (facet) => {
        const terms = dishFacetTerms(ctx.cat, ctx.baseCode, facet);
        if (terms.length === 0) return { facet, codes: [] as string[] };
        const answered = await ask(systemDishFacetSelect(withCountry), {
          genus: shelf,
          facet: dishFacetInfo(ctx.cat, facet),
          descriptors: terms,
        });
        return { facet, codes: parseOfferedCodes(answered.content, new Set(terms.map((t) => t.code))) };
      })
    ),
  ]);

  const ingredients = parseDishIngredients(ingredientsAnswer.content);
  const ingredientResolutions = [];
  for (const phrase of ingredients) {
    ingredientResolutions.push(await placeByKind(ctx, { phrase, kind: "ingredient" }, "drop"));
  }
  audit.push({
    step: "residuals_dish_ingredients",
    detail: { model: ingredientsAnswer.model, ingredients, resolutions: ingredientResolutions },
  });

  const selected: FacetDescriptorRef[] = [];
  for (const { facet, codes } of selections) {
    for (const code of codes) {
      const ref = { header: facet, code, name: ctx.cat.term(code)?.name ?? code };
      if (addFacet(ctx, ref)) selected.push(ref);
    }
  }
  audit.push({
    step: "residuals_dish_facets",
    detail: {
      selected: selections.filter((s) => s.codes.length > 0),
      added: selected.map((f) => ({ header: f.header, code: f.code, name: f.name })),
    },
  });

  if (selected.length > 0) {
    const gate = await ask(systemDishGate(withCountry), {
      genus: dishGateShelf(ctx.cat, ctx.baseCode, shelf),
      differentiae: ctx.facets.map((f) => dishGateDescriptor(ctx.cat, f.header, f.code)),
    });
    const keep = parseOfferedCodes(gate.content, new Set(selected.map((f) => `${f.header}.${f.code}`)));
    const dropped: string[] = [];
    for (const facet of selected) {
      const key = `${facet.header}.${facet.code}`;
      if (keep.includes(key)) continue;
      removeFacet(ctx, facet);
      dropped.push(key);
    }
    audit.push({ step: "residuals_dish_gate", detail: { model: gate.model, kept: keep, dropped } });
  }

  return await finishResiduals(ctx, audit, { from: "dish" });
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
    food: input,
    country: options.country ?? null,
    fit: options.fit ?? null,
    fortificationClaim: { status: "none" },
    numericClaim: { fatPercent: null, alcoholPercent: null },
    originCovered: [],
    minorFoods: options.minorFoods ?? [],
    protectedFacets: new Set(),
    named: options.named ?? null,
  };

  if (options.facetSlots !== false && !isDishKind(ctx.descriptionKind)) {
    return assignResidualSlots(ctx, input, audit);
  }

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

  if (isDishKind(ctx.descriptionKind)) {
    return await assignDishRoute(ctx, input, (options.food?.trim() || input).trim(), audit);
  }

  // --- 1. Foodstuff name meaning ---
  const descriptionKind = ctx.descriptionKind;
  /** Foodstuff: the name already resolved. */
  let called: string | null = null;
  /** World knowledge from the origin question, placed after the input's Facets pass. */
  const known: Array<{ property: GapProperty; origin: boolean }> = [];
  let knownFrom: "origin" | null = null;

  if (descriptionKind !== "foodstuff") {
    audit.push({
      step: "residuals_essence",
      detail: {
        skipped: descriptionKind === null ? "no_route_kind" : "not_dish_kind",
        descriptionKind,
      },
    });
  } else {
    const description = (options.food?.trim() || input).trim();
    const implicit = implicits.map(({ key, name }) => {
      const header = key.split(".")[0] ?? key;
      return `${cat.facetCategory(header)?.label ?? header}: ${name}`;
    });
    const origin = await askFoodOrigin(ctx, description, implicit, audit);
    knownFrom = "origin";
    called = origin.name;
    for (const property of origin.from) known.push({ property, origin: true });
  }

  // --- 2. Input vs base ---
  const gapInput = input;
  const properties = await listInputProperties();
  ctx.food = stripAttributePhrases(input, [
    ...properties.map((property) => property.phrase),
    ...namedPhrases(ctx),
  ]);

  const passes: FacetsPass[] = [];
  for (const property of properties) passes.push(await placeFacetsPass(ctx, property, "freeText"));

  const roleClaims = passes
    .filter(claimedByRole)
    .flatMap((p) => [p.property.phrase, ...(p.property.name !== undefined ? [p.property.name] : [])]);
  const knownResolutions = [];
  const knownPlaced: string[] = [];
  const claimedDropped: string[] = [];
  for (const { property, origin } of known) {
    const lookup = property.name ?? property.phrase;
    if (roleClaims.some((claim) => wordsWithin(lookup, claim))) {
      claimedDropped.push(lookup);
      continue;
    }
    if (origin) {
      const attempts: Record<string, unknown>[] = [];
      const placed = await placeOrigin(ctx, lookup, property.kind, true, attempts);
      if (placed.facets.length > 0) knownPlaced.push(lookup);
      knownResolutions.push({
        phrase: lookup,
        placed: placed.facets.length > 0 ? "facet" : "dropped",
        ...(placed.facets[0] !== undefined
          ? {
              facet: placed.facets[0],
              ...(placed.facets.length > 1 ? { facets: placed.facets } : {}),
            }
          : {}),
        attempts,
      });
    } else {
      const resolution = await placeByKind(ctx, property, "drop");
      if (resolution.placed === "facet" && isOriginKind(property.kind)) knownPlaced.push(lookup);
      knownResolutions.push(resolution);
    }
  }
  if (knownFrom !== null) {
    audit.push({
      step: "residuals_place",
      detail: {
        from: knownFrom,
        resolutions: knownResolutions,
        ...(claimedDropped.length > 0 ? { droppedClaimedByRole: claimedDropped } : {}),
        facets: [...ctx.facets],
        freeText: [...ctx.freeText],
      },
    });
  }

  const inputResolutions = [];
  for (const pass of passes) {
    const lookup = pass.property.name ?? pass.property.phrase;
    const alreadyPlaced = knownPlaced.some((k) => wordsWithin(lookup, k) || wordsWithin(k, lookup));
    inputResolutions.push(await finishPlacement(ctx, pass, alreadyPlaced));
  }
  return await finishResiduals(ctx, audit, { from: "input", resolutions: inputResolutions });

  async function listInputProperties(): Promise<GapProperty[]> {
    if (gapInput.trim() === "") {
      audit.push({
        step: "residuals_input",
        detail: { skipped: "empty_gap_input", properties: [] },
      });
      return [];
    }

    if (foodMatchesBaseTerm(gapInput, baseTerm.code, baseTerm.name)) {
      audit.push({
        step: "residuals_input",
        detail: { skipped: "identical_wording", properties: [] },
      });
      return [];
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

    const country = options.country ?? null;
    const listed = await chatJson({
      model,
      system: systemInputRelations(descriptionKind, country !== null),
      user: JSON.stringify(
        {
          input: gapInput,
          ...(country !== null ? { country } : {}),
          ...(called !== null ? { called } : {}),
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
    const { kept: inInput, dropped } = filterPropertiesToInput(asUnsorted(listedRaw), gapInput);
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
        ...(called !== null ? { called } : {}),
        properties,
        ...(omitted.length > 0 ? { omitted } : {}),
        ...(droppedAll.length > 0 ? { dropped: droppedAll, raw: listedRaw } : {}),
      },
    });
    return properties;
  }
}

function isOriginKind(kind: GapPropertyKind): boolean {
  return kind === "ingredient" || kind === "source" || kind === "made_from" || kind === "added";
}
