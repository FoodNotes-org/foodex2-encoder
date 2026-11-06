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
 * `parent` and `directSubcategories`, which the selection payload does not carry.
 */
export function classifySystemPrompt(options: {
  answerKey: "match" | "fit";
  readSubcategories?: boolean;
  /** The payload carries `country` next to `item`. */
  withCountry?: boolean;
}): string {
  const { answerKey, readSubcategories = false, withCountry = false } = options;
  const item = withCountry
    ? "- `item`: the food description, to be understood in the food nomenclature in: `country`."
    : "- `item`: the food description.";
  const givens = [
    item,
    "- `descriptionKind`: which kind of description `item` is: a foodstuff, a category, a dish, a dish type, or a mix.",
    ...(readSubcategories ? ["- `parent`: the catalogue term these terms sit under."] : []),
    readSubcategories
      ? "- `terms`: the catalogue terms to judge. Each has a `code` and a `name`. A term that has children also has `directSubcategories`: the names of the terms directly under it. A term that has a scope note also has `note`. Those names and notes show what the term covers. They are catalogue structure, not ingredients of `item`."
      : "- `terms`: the catalogue terms to judge. Each has a `code` and a `name`. A term that has a scope note also has `note`. A term whose `name` contains the word \"other\" also has `parent`, the term it sits under, and `siblings`, the other terms directly under that parent. Those names and notes are catalogue structure, not ingredients of `item`.",
  ];
  // The walk lists one parent's children as `terms`. Selection mixes branches,
  // so there "other" is defined by fields on that term, not by the whole list.
  const other = readSubcategories
    ? `When a term's name contains the word "other", the term denotes the members of \`parent\` that are not members of the sibling terms in \`terms\`.`
    : `When a term's name contains the word "other", the term denotes the members of that term's \`parent\` that are not members of that term's \`siblings\`.`;
  const choice = [
    "Compare `item` with the class the term denotes. Use the term's name and, when present, its `directSubcategories` and its `note`. Do not forget to consider the `country`'s nomenclature for correct understanding of the `item`.",
    `For each term, assign one ${answerKey}.`,
    [
      "- exact: `item` and the term denote the same class",
      "- broad: the term is a hypernym of `item`",
      "- narrow: the term is a hyponym of `item`",
      "- related: associated, and neither is a hypernym or a hyponym of the other",
      "- none: none of these",
    ].join("\n"),
  ].join("\n\n");
  const opening = withCountry
    ? "You are an expert in food classification. \n\nYour task is to match a food description in the food nomenclature in `country` against terms in a food catalogue."
    : "You are an expert in food classification.\n\nYour task is to match a food description against terms in a food catalogue.";
  return [
    opening,
    `You are given:\n${givens.join("\n")}`,
    `${choice}\n\n${other}`,
    `Reply with JSON only:\n{"classifications":[{"code":"<code>","${answerKey}":"exact|broad|narrow|related|none"}, ...]}\n`,
  ].join("\n\n");
}

