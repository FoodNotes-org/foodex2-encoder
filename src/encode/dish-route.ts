/**
 * Composite dishes: the principal characterising ingredients, one descriptor
 * choice per facet, and a gate that removes what the rest of the code already
 * conveys.
 */

import type { Catalogue } from "../catalogue.js";
import { countryParagraph } from "../country.js";

/**
 * Facets offered to a dish. Ingredients, generic term, fat, alcohol and
 * fortification have their own steps. Source, source-commodity, physical
 * state, production method and part-nature are not used on composite food.
 */
export const DISH_FACETS: readonly string[] = [
  "F28",
  "F22",
  "F17",
  "F08",
  "F10",
  "F18",
  "F19",
  "F20",
  "F23",
  "F24",
  "F25",
  "F06",
];

/** The catalogue's surrounding-medium facet is not for an aggregated composite. */
const SIMPLE_COMPOSITE_ONLY = new Set(["F06"]);

export function dishFacets(termType: string | null): string[] {
  return DISH_FACETS.filter((facet) => !SIMPLE_COMPOSITE_ONLY.has(facet) || termType === "s");
}

export interface DishShelf {
  name: string;
  scope: string;
}

export interface DishTerm {
  code: string;
  name: string;
  scope: string;
}

export function systemDishIngredients(withCountry: boolean): string {
  return `You are an expert in food classification.

Context: a dish has been classified to a broader shelf in a food catalogue.

Goal: identify its principal characterising ingredients.

Given:
- \`description\`: the dish.
- \`group\`: the shelf, with its \`name\` and its \`scope\`.
${countryParagraph(withCountry, "description")}
Your task: list the principal characterising ingredients that distinguish the dish within the shelf. Leave out ingredients that the description attaches to a process rather than to the dish.

If none, leave \`ingredients\` empty.

Reply with JSON only:
{"ingredients":["<phrase>",...]}
`;
}

export function systemDishFacetSelect(withCountry: boolean): string {
  return `You are an expert in food classification.

Context: a food description is being expressed in the terms of a food catalogue, as a definition by genus and differentia. The genus is the shelf the food has been classified to; the differentiae are descriptors from the catalogue's facets.

Goal: select the differentiae from one facet.

Given:
- \`description\`: the food.
- \`genus\`: the shelf, with its \`name\` and its \`scope\`.
- \`facet\`: one facet, with its \`name\` and its \`description\`.
- \`terms\`: the facet's descriptors, each with a \`code\`, a \`name\`, and its \`scope\` note.
${countryParagraph(withCountry, "description")}
Your task: list the codes of the descriptors that an expert in dietary exposure assessment needs as differentiae in order to achieve a precise understanding of the described food.

If none, leave \`codes\` empty.

Reply with JSON only:
{"codes":["<code>",...]}
`;
}

export function systemDishGate(withCountry: boolean): string {
  return `You are an expert in food classification.

Context: a food description has been encoded in a food catalogue as a shelf plus descriptors from the catalogue's facets. The code is read by experts in dietary exposure assessment.

Goal: remove the descriptors that add no information to the code.

Given:
- \`description\`: the food.
- \`shelf\`: the shelf, with its \`name\`, its \`scope\`, and the descriptors it implies.
- \`descriptors\`: the descriptors added to the shelf, each with a \`code\`, a \`name\` preceded by its facet, and its \`scope\` note.
${countryParagraph(withCountry, "description")}
Your task: list the codes of the added descriptors that such an expert would infer from the rest of the code. When two descriptors convey the same information, keep the one the description denotes.

If none, leave \`codes\` empty.

Reply with JSON only:
{"codes":["<code>",...]}
`;
}

function facetLabel(cat: Catalogue, facet: string): string {
  return cat.facetCategory(facet)?.label ?? facet;
}

/** The facet's name and the catalogue's description of it. */
export function dishFacetInfo(cat: Catalogue, facet: string): { name: string; description: string } {
  const category = cat.facetCategory(facet);
  return { name: category?.label ?? facet, description: category?.scopeNote?.trim() ?? "" };
}

/**
 * Every current descriptor of `facet`, minus those the shelf already implies.
 */
export function dishFacetTerms(cat: Catalogue, baseCode: string, facet: string): DishTerm[] {
  const hierarchy = cat.facetCategory(facet)?.hierarchyCode;
  if (hierarchy === undefined) return [];
  const implied = new Set(
    cat
      .impliedFacets(baseCode)
      .filter((key) => key.startsWith(`${facet}.`))
      .map((key) => key.slice(facet.length + 1))
  );
  const out: DishTerm[] = [];
  const seen = new Set<string>();
  const queue = [...cat.children("root", hierarchy)];
  while (queue.length > 0) {
    const code = queue.shift() as string;
    if (seen.has(code) || cat.isDeprecated(code)) continue;
    seen.add(code);
    queue.push(...cat.children(code, hierarchy));
    if (implied.has(code)) continue;
    const term = cat.term(code);
    out.push({ code, name: term?.name ?? code, scope: term?.scopeNote?.trim() ?? "" });
  }
  return out;
}

/** The shelf as the gate sees it: name, scope, and its implied descriptors labelled by facet. */
export function dishGateShelf(
  cat: Catalogue,
  baseCode: string,
  shelf: DishShelf
): { name: string; scope: string; implies: string[] } {
  return {
    ...shelf,
    implies: cat.impliedFacets(baseCode).map((key) => {
      const dot = key.indexOf(".");
      const facet = key.slice(0, dot);
      const code = key.slice(dot + 1);
      return `${facetLabel(cat, facet)}: ${cat.term(code)?.name ?? code}`;
    }),
  };
}

/**
 * An added descriptor as the gate sees it. The code carries its facet, because
 * one descriptor can sit in two facets (Ready-to-eat is both a quality and an
 * intended use).
 */
export function dishGateDescriptor(
  cat: Catalogue,
  facet: string,
  code: string
): { code: string; name: string; scope: string } {
  const term = cat.term(code);
  return {
    code: `${facet}.${code}`,
    name: `${facetLabel(cat, facet)}: ${term?.name ?? code}`,
    scope: term?.scopeNote?.trim() ?? "",
  };
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x !== "")
    : [];
}

function body(content: unknown): Record<string, unknown> {
  return content !== null && typeof content === "object" ? (content as Record<string, unknown>) : {};
}

export function parseDishIngredients(content: unknown): string[] {
  return [...new Set(stringList(body(content).ingredients))];
}

/** Codes from a `codes` answer that were offered, in answer order, without repeats. */
export function parseOfferedCodes(content: unknown, offered: ReadonlySet<string>): string[] {
  return [...new Set(stringList(body(content).codes).filter((code) => offered.has(code)))];
}
