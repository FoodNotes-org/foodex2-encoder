/**
 * SKOS-style classify ladder shared by recall (traverse.ts) and selection
 * (select-classify.ts). Owned by neither stage: the ladder defines the relation
 * between one food and one catalogue term (exact | broad | narrow | related |
 * none). What each stage does with the labels — descend and collect, or gate
 * and pick — lives in that stage.
 */

import type { LadderLabel } from "./types.js";

export const LADDER_LABELS: ReadonlySet<LadderLabel> = new Set<LadderLabel>([
  "exact",
  "broad",
  "narrow",
  "related",
  "none",
]);

/**
 * System prompt for one classify call. `answerKey` is the JSON key the model
 * answers under (recall: match, selection: fit). Recall walks also describe
 * `parent` and `directSubcategories`. Both stages may include `properties`,
 * the characteristics the class entails. Selection does not carry `parent`
 * or `directSubcategories`.
 */
export function classifySystemPrompt(options: {
  answerKey: "match" | "fit";
  readSubcategories?: boolean;
  /** The payload carries `country` next to `item`. */
  withCountry?: boolean;
}): string {
  const { answerKey, readSubcategories = false, withCountry = false } = options;
  const item = withCountry
    ? readSubcategories
      ? "- `item`: the food description, as understood in the food nomenclature of: `country`."
      : "- `item`: the food description, to be understood in the food nomenclature in: `country`."
    : "- `item`: the food description.";
  const descriptionKind = readSubcategories
    ? "- `descriptionKind`: which kind of description `item` is: a foodstuff, a food category, a dish, a dish type, or a mix of foods."
    : "- `descriptionKind`: which kind of description `item` is: a foodstuff, a category, a dish, a dish type, or a mix.";
  const givens = [
    item,
    descriptionKind,
    ...(readSubcategories ? ["- `parent`: the catalogue term these terms sit under."] : []),
    readSubcategories
      ? "- `terms`: the catalogue terms to judge. Each has a `code` and a `name`. `directSubcategories`, if included, are the names of the terms that sit directly under that term. `note`, if included, is the scope note, which says what that term covers. `properties`, if included, are characteristics entailed by the class. Each has a `kind` and a `name`."
      : "- `terms`: the catalogue terms to judge. Each has a `code` and a `name`. `note`, if included, is the scope note, which says what that term covers. `properties`, if included, are characteristics entailed by the class. Each has a `kind` and a `name`. A term whose `name` contains the word \"other\" also has `parent`, the term it sits under, and `siblings`, the other terms directly under that parent.",
  ];
  // The walk lists one parent's children as `terms`. Selection mixes branches,
  // so there "other" is defined by fields on that term, not by the whole list.
  const other = readSubcategories
    ? `When a term's name contains the word "other" or "not separately listed", the term denotes all members of \`parent\` that are not members of its sibling terms in \`terms\`.`
    : `When a term's name contains the word "other", the term denotes the members of that term's \`parent\` that are not members of that term's \`siblings\`.`;
  const compare =
    "Compare `item` with the class each term denotes, using the term's `name`, any `directSubcategories`, any `note`, and any `properties` to decide its exact scope.";
  const ladder = [
    "- exact: `item` and the term denote the same class",
    "- broad: the term is a hypernym of `item`",
    "- narrow: the term is a hyponym of `item`",
    "- related: associated, and neither is a hypernym or a hyponym of the other",
    "- none: none of the above",
  ].join("\n");
  const choice = readSubcategories
    ? `${compare}\n\nFor each term, assign one ${answerKey}.\n${ladder}`
    : [compare, `For each term, assign one ${answerKey}.`, ladder].join("\n\n");
  const opening =
    "You are an expert in food classification.\n\nYour task is to match a food description against terms in a food catalogue.";
  return [
    opening,
    `You are given:\n${givens.join("\n")}`,
    `${choice}\n\n${other}`,
    `Reply with JSON only:\n{"classifications":[{"code":"<code>","${answerKey}":"exact|broad|narrow|related|none"}, ...]}\n`,
  ].join("\n\n");
}

