/**
 * SKOS-style classify ladder shared by recall (traverse.ts) and selection
 * (select-classify.ts). Owned by neither stage: the ladder defines the relation
 * between one food and one catalogue term (exact | broad | narrow | related |
 * none). What each stage does with the labels — descend and collect, or gate
 * and pick — lives in that stage.
 */

import type { DescriptionKind, LadderLabel } from "./types.js";

export const LADDER_LABELS: ReadonlySet<LadderLabel> = new Set<LadderLabel>([
  "exact",
  "broad",
  "narrow",
  "related",
  "none",
]);

export function quote(value: string): string {
  return `"${value.replace(/"/g, "'")}"`;
}

/**
 * System prompt for one classify call. `framing` says what the item is and what
 * it is matched against; `answerKey` is the JSON key the model answers under
 * (recall: match, selection: fit). Recall walks also describe `parent` and
 * `directSubcategories`, which the selection payload does not carry.
 */
export function classifySystemPrompt(options: {
  framing: string;
  answerKey: "match" | "fit";
  readSubcategories?: boolean;
  /** The payload carries `country` next to `item`. */
  withCountry?: boolean;
}): string {
  const { framing, answerKey, readSubcategories = false, withCountry = false } = options;
  const givens = [
    "- `item`: the food or drink as described.",
    ...(withCountry ? ["- `country`: where `item` was reported."] : []),
    "- `descriptionKind`: which kind of description `item` is: a foodstuff, a category, a dish, a dish type, or a mix.",
    ...(readSubcategories ? ["- `parent`: the catalogue term these terms sit under."] : []),
    readSubcategories
      ? "- `terms`: the catalogue terms to judge. Each has a `code`, a `name` and `questions`. A term that has children also has `directSubcategories`: the names of the terms directly under it. Those names show what the term covers. They are catalogue structure, not ingredients of `item`."
      : "- `terms`: the catalogue terms to judge. Each has a `code`, a `name` and `questions`.",
  ];
  const opening = withCountry
    ? `${framing}\n\`item\` is reported from this country: \`country\`.`
    : framing;
  return [
    opening,
    `You are given:\n${givens.join("\n")}`,
    `For each term, answer its questions in order and assign ${answerKey}, at the level of detail the description itself states, not an inferred more specific kind.`,
    `Reply with JSON only:\n{"classifications":[{"code":"<code>","${answerKey}":"exact|broad|narrow|related|none"}, ...]}\n`,
  ].join("\n\n");
}

/**
 * Per-term ladder questions. Item / term names only — subcategories live on the
 * term row. Related is always offered (SKOS-style association when neither
 * kind-of fits); with directSubcategories the cue is siblinghood under the term.
 *
 * Questions always name the actual item text so we don't abstract it into
 * "this food with additions".
 *
 * Catalogue-default qualifiers (*Deer fresh meat* for *venison*): literal ≠
 * conventional exact, and either reading is accepted (lenient, by decision;
 * see WORK_DOC). Do not paper over with example-heavy prompt wording.
 */
export function classifyQuestions(
  itemQ: string,
  termQ: string,
  subcategoryQs: string[] | null
): string[] {
  const questions: string[] = [
    `1. Are ${itemQ} and ${termQ} the same item, at the same level of detail? If yes: assign "exact" and skip the other options in this evaluation.`,
    `2. Is ${itemQ} a kind of ${termQ}, in the strict sense? If yes: assign "broad" and skip the other options in this evaluation.`,
    `3. Is ${termQ} a kind of ${itemQ}, in the strict sense? If yes: assign "narrow" and skip the other options in this evaluation.`,
  ];

  if (subcategoryQs !== null && subcategoryQs.length > 0) {
    const elements = subcategoryQs.join(", ");
    questions.push(
      `4. Would ${itemQ} be a natural sibling of ${elements} under ${termQ}? If yes: assign "related" and skip the other options in this evaluation.`
    );
  } else {
    questions.push(
      `4. Are ${itemQ} and ${termQ} similar, with neither being a kind of the other? If yes: assign "related" and skip the other options in this evaluation.`
    );
  }

  questions.push(`5. Otherwise: assign "none".`);
  return questions;
}

/** Noun used to frame the item in a classify system prompt. */
export function descriptionKindNoun(kind: DescriptionKind | null): string {
  switch (kind) {
    case "dish":
      return "dish";
    case "dish_type":
      return "dish type";
    case "mix":
      return "mix";
    case "category":
      return "food category";
    case "foodstuff":
    case null:
      return "food or drink";
  }
}
