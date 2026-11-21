/**
 * SKOS-style classify ladder shared by recall (traverse.ts) and selection
 * (select-classify.ts). Owned by neither stage: the ladder defines the relation
 * between one food and one catalogue term (exact | broad | narrow | related |
 * none). What each stage does with the labels — descend and collect, or gate
 * and pick — lives in that stage.
 */

import type { Catalogue } from "../catalogue.js";
import type { LadderLabel } from "./types.js";

export const LADDER_LABELS: ReadonlySet<LadderLabel> = new Set<LadderLabel>([
  "exact",
  "broad",
  "narrow",
  "related",
  "none",
]);

/**
 * Composite dishes (A03VA). Its MTX scope note says the group is for dishes
 * whose ingredients are so diverse that no main category can be identified.
 * That contradicts its children (Meat based dishes, Egg based dishes, …) and
 * steers recipe dishes into commodity groups. Classify calls omit that note
 * (`conflicts.yaml`, `catalogue-A03VA-scope-note`).
 */
export const COMPOSITE_DISHES = "A03VA";

/** Scope note sent with a term in classify payloads; undefined when omitted. */
export function classifyScopeNote(cat: Catalogue, code: string): string | undefined {
  if (code === COMPOSITE_DISHES) return undefined;
  const note = cat.term(code)?.scopeNote?.trim();
  return note ? note : undefined;
}

/** The `item` line for any prompt that reads a food description against catalogue terms. */
export function itemGiven(withCountry: boolean): string {
  return withCountry
    ? "- `item`: the food description, in the food nomenclature of `country`."
    : "- `item`: the food description.";
}

export const TERM_FIELDS_GIVEN = "Each has a `code` and a `name`.";
export const TERM_NOTE_GIVEN = "`note`, if included, explains the term's scope and usage.";

/**
 * System prompt for one classify call. `answerKey` is the JSON key the model
 * answers under (recall: match, selection: fit). The walk also names the
 * parent of the whole list. Both calls may include `directSubcategories`,
 * `note`, `properties`, and, for a remainder term, that term's `parent` and
 * `siblings`.
 */
export function classifySystemPrompt(options: {
  answerKey: "match" | "fit";
  readSubcategories?: boolean;
  /** The payload carries `country` next to `item`. */
  withCountry?: boolean;
}): string {
  const { answerKey, readSubcategories = false, withCountry = false } = options;
  const item = itemGiven(withCountry);
  const givens = [
    item,
    ...(readSubcategories ? ["- `parent`: the catalogue term these terms sit under."] : []),
    `- \`terms\`: the catalogue terms to judge. ${TERM_FIELDS_GIVEN} \`directSubcategories\`, if included, are the names of the terms that sit directly under that term. ${TERM_NOTE_GIVEN} \`properties\`, if included, are characteristics entailed by the class. Each has a \`kind\` and a \`name\`. A term whose \`name\` contains "other" or "not separately listed" also has \`parent\`, the term it sits under, and \`siblings\`, the other terms directly under that parent.`,
  ];
  const other =
    "When a term's name contains the word \"other\" or \"not separately listed\", the term denotes the members of that term's `parent` that are not members of that term's `siblings`.";
  const compare =
    "Compare `item` with the class each term denotes, using the term's `name`, any `directSubcategories`, any `note`, and any `properties` to decide its scope.";
  const ladder = [
    "- exact: `item` and the term denote the same class",
    "- broad: the term is a hypernym of `item`",
    "- narrow: the term is a hyponym of `item`",
    "- related: associated, and neither is a hypernym or a hyponym of the other",
    "- none: none of the above",
  ].join("\n");
  const choice = [compare, `For each term, assign one ${answerKey}.`, ladder].join("\n\n");
  const opening =
    "You are an expert in food classification.\n\nYour task is to match a food description against terms in a food catalogue.";
  return [
    opening,
    `You are given:\n${givens.join("\n")}`,
    [choice, other].join("\n\n"),
    `Reply with JSON only:\n{"classifications":[{"code":"<code>","${answerKey}":"exact|broad|narrow|related|none"}, ...]}\n`,
  ].join("\n\n");
}

