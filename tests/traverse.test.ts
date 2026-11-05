/**
 * Deterministic traversal helpers (no LLM).
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import { classifySystemPrompt } from "../src/encode/classify-ladder.js";
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

describe("classifySystemPrompt", () => {
  const walkOther =
    'When a term\'s name contains the word "other", the term denotes the members of `parent` that are not members of the sibling terms in `terms`.';
  const pickOther =
    'When a term\'s name contains the word "other", the term denotes the members of that term\'s `parent` that are not members of that term\'s `siblings`.';

  it("asks once for one relation, in hypernym and hyponym terms", () => {
    const prompt = classifySystemPrompt({
      answerKey: "match",
      readSubcategories: true,
    });
    assert.equal(prompt.includes("A hypernym is the broader class."), false);
    assert.ok(
      prompt.includes(
        "Compare `item` with the class the term denotes. Use the term's name and, when present, its `directSubcategories` and its `note`."
      )
    );
    assert.ok(prompt.includes("- broad: the term is a hypernym of `item`"));
    assert.ok(prompt.includes("- narrow: the term is a hyponym of `item`"));
    assert.equal(prompt.includes("in order"), false);
    assert.equal(prompt.includes("skip the other"), false);
    assert.equal(prompt.includes("strict sense"), false);
  });

  it("defines other from the sibling list when the terms are one parent's children", () => {
    const prompt = classifySystemPrompt({
      answerKey: "match",
      readSubcategories: true,
    });
    assert.ok(prompt.includes(walkOther));
    assert.equal(prompt.includes(pickOther), false);
  });

  it("defines other from each term's own parent and siblings in a mixed pool", () => {
    const prompt = classifySystemPrompt({
      answerKey: "fit",
    });
    assert.ok(prompt.includes(pickOther));
    assert.ok(prompt.includes("`siblings`"));
    assert.equal(prompt.includes(walkOther), false);
  });

  it("reads the food description in the country's nomenclature", () => {
    const prompt = classifySystemPrompt({
      answerKey: "match",
      readSubcategories: true,
      withCountry: true,
    });
    const line =
      "- `item`: the food description, to be understood in the food nomenclature of the country `country`.";
    assert.equal(prompt.split(line).length - 1, 1);
    assert.ok(prompt.startsWith("You are an expert in food classification. Read `item` in the food nomenclature of `country`."));
    assert.equal(prompt.includes("not an inferred more specific kind"), false);
  });
});
