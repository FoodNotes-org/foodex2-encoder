/**
 * Deterministic traversal helpers (no LLM).
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import { classifySystemPrompt } from "../src/encode/classify-ladder.js";
import { entailedProperties } from "../src/encode/entailed-properties.js";
import {
  embeddingHitWalkSeed,
  parseDescriptionKind,
  parseRoute,
  resolveEmbeddingWalkSeeds,
} from "../src/encode/traverse.js";

describe("parseRoute", () => {
  it("reads descriptionKind", () => {
    const route = parseRoute(
      {
        descriptionKind: "dish",
        // Legacy densify / wholeItem fields — ignored
        wholeItem: "multi",
        heterogenous: true,
        baseItem: "fried rice",
      },
      "fried rice with chicken"
    );
    assert.equal(route.descriptionKind, "dish");
  });

  it("accepts foodstuff", () => {
    const route = parseRoute(
      { descriptionKind: "foodstuff" },
      "apple"
    );
    assert.equal(route.descriptionKind, "foodstuff");
  });

  it("accepts mix for a peer blend", () => {
    const route = parseRoute(
      { descriptionKind: "mix" },
      "mixed nuts (almonds, walnuts and hazelnuts)"
    );
    assert.equal(route.descriptionKind, "mix");
  });

  it("rejects food_with_additions as a descriptionKind", () => {
    const route = parseRoute(
      {
        descriptionKind: "food_with_additions",
        baseItem: "yogurt",
      },
      "yogurt with cereals and fruits"
    );
    assert.equal(route.descriptionKind, null);
  });
});

describe("parseDescriptionKind", () => {
  it("accepts all description kinds", () => {
    for (const kind of ["foodstuff", "category", "dish", "dish_type", "mix"]) {
      assert.equal(parseDescriptionKind(kind), kind);
    }
  });

  it("rejects unknown values", () => {
    assert.equal(parseDescriptionKind("single_food"), null);
    assert.equal(parseDescriptionKind("food_with_additions"), null);
    assert.equal(parseDescriptionKind(null), null);
  });
});

describe("embeddingHitWalkSeed", () => {
  const cat = Catalogue.load();

  it("maps a leaf hit to its expo parent", () => {
    // Kangaroo fresh meat → Mammals meat
    assert.equal(embeddingHitWalkSeed(cat, "A01RS"), "A0EYF");
  });

  it("keeps a parent hit as its own seed", () => {
    assert.equal(embeddingHitWalkSeed(cat, "A0EYF"), "A0EYF");
  });

  it("dedupes parents across sibling hits", () => {
    // Kangaroo fresh meat + Dog meat both seed Mammals meat; parent hit adds nothing new
    const seeds = resolveEmbeddingWalkSeeds(cat, ["A01RS", "A0F6A", "A0EYF"]);
    assert.deepEqual(seeds, ["A0EYF"]);
  });
});

describe("entailedProperties", () => {
  const cat = Catalogue.load();

  it("names the processes a liquid whole egg already entails", () => {
    const properties = entailedProperties(cat, "A031R");
    assert.ok(
      properties.some(
        (property) => property.kind === "Process" && property.name === "Removal of external layer"
      )
    );
    assert.ok(
      properties.some((property) => property.kind === "Process" && property.name === "Stirring")
    );
  });

  it("is empty when the term is unknown", () => {
    assert.deepEqual(entailedProperties(cat, "NOPE"), []);
  });
});

describe("classifySystemPrompt", () => {
  const compare =
    "Compare `item` with the class each term denotes, using the term's `name`, any `directSubcategories`, any `note`, and any `properties` to decide its exact scope.";
  const remainder =
    'When a term\'s name contains the word "other" or "not separately listed", the term denotes the members of that term\'s `parent` that are not members of that term\'s `siblings`.';
  const terms =
    '- `terms`: the catalogue terms to judge. Each has a `code` and a `name`. `directSubcategories`, if included, are the names of the terms that sit directly under that term. `note`, if included, is the scope note, which says what that term covers. `properties`, if included, are characteristics entailed by the class. Each has a `kind` and a `name`. A term whose `name` contains "other" or "not separately listed" also has `parent`, the term it sits under, and `siblings`, the other terms directly under that parent.';
  it("asks once for one relation, in hypernym and hyponym terms", () => {
    const prompt = classifySystemPrompt({
      answerKey: "match",
      readSubcategories: true,
    });
    assert.equal(prompt.includes("A hypernym is the broader class."), false);
    assert.ok(prompt.includes(compare));
    assert.ok(
      prompt.includes(
        "`properties`, if included, are characteristics entailed by the class. Each has a `kind` and a `name`."
      )
    );
    assert.equal(prompt.includes("catalogue structure"), false);
    assert.ok(prompt.includes("- exact: `item` and the term denote the same class"));
    assert.ok(prompt.includes("- broad: the term is a hypernym of `item`"));
    assert.ok(prompt.includes("- narrow: the term is a hyponym of `item`"));
    assert.equal(prompt.includes("in order"), false);
    assert.equal(prompt.includes("skip the other"), false);
    assert.equal(prompt.includes("strict sense"), false);
  });

  it("uses one wording for the walk and the final pick", () => {
    const walk = classifySystemPrompt({ answerKey: "match", readSubcategories: true });
    const pick = classifySystemPrompt({ answerKey: "fit" });
    const same = (prompt: string) =>
      prompt
        .replaceAll('"match"', '"fit"')
        .replaceAll("assign one match", "assign one fit")
        .replace("\n- `parent`: the catalogue term these terms sit under.", "");
    assert.equal(same(walk), same(pick));
    assert.equal(walk.includes(remainder), true);
    assert.equal(walk.includes(terms), true);
    assert.equal(walk.includes("descriptionKind"), false);
  });

  it("reads the food description in the country's nomenclature", () => {
    const prompt = classifySystemPrompt({
      answerKey: "match",
      readSubcategories: true,
      withCountry: true,
    });
    const line =
      "- `item`: the food description. It denotes the class that name has in the food nomenclature of `country`.";
    assert.equal(prompt.split(line).length - 1, 1);
    const select = classifySystemPrompt({ answerKey: "fit", withCountry: true });
    assert.equal(select.split(line).length - 1, 1);
    assert.ok(
      prompt.startsWith(
        "You are an expert in food classification.\n\nYour task is to match a food description against terms in a food catalogue."
      )
    );
    assert.equal(prompt.includes("Do not forget to consider"), false);
    assert.equal(prompt.includes("not an inferred more specific kind"), false);
  });
});
