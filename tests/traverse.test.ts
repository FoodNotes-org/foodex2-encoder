/**
 * Deterministic traversal helpers (no LLM).
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import { classifyQuestions } from "../src/encode/classify-ladder.js";
import {
  embeddingHitWalkSeed,
  parseDescriptionKind,
  parseRoute,
  resolveEmbeddingWalkSeeds,
} from "../src/encode/traverse.js";

describe("parseRoute", () => {
  it("reads wholeItem and descriptionKind", () => {
    const route = parseRoute(
      {
        wholeItem: "multi",
        descriptionKind: "dish",
        // Legacy densify fields — ignored
        heterogenous: true,
        baseItem: "fried rice",
      },
      "fried rice with chicken"
    );
    assert.equal(route.wholeItem, "multi");
    assert.equal(route.descriptionKind, "dish");
  });

  it("defaults unknown wholeItem to single", () => {
    const route = parseRoute(
      { wholeItem: "single", descriptionKind: "foodstuff" },
      "apple"
    );
    assert.equal(route.wholeItem, "single");
    assert.equal(route.descriptionKind, "foodstuff");
  });

  it("rejects food_with_additions as a descriptionKind", () => {
    const route = parseRoute(
      {
        wholeItem: "multi",
        descriptionKind: "food_with_additions",
        baseItem: "yogurt",
      },
      "yogurt with cereals and fruits"
    );
    assert.equal(route.descriptionKind, null);
  });
});

describe("parseDescriptionKind", () => {
  it("accepts foodstuff for single-item inputs", () => {
    assert.equal(parseDescriptionKind("foodstuff"), "foodstuff");
  });

  it("accepts all multi-item kinds", () => {
    for (const kind of ["dish", "dish_type", "mix", "ingredients"]) {
      assert.equal(parseDescriptionKind(kind), kind);
    }
  });

  it("rejects unknown values", () => {
    assert.equal(parseDescriptionKind("single_food"), null);
    assert.equal(parseDescriptionKind("food_with_additions"), null);
    assert.equal(parseDescriptionKind(null), null);
  });
});

describe("classifyQuestions", () => {
  it("always offers related, with sibling cue when subcategories exist", () => {
    const withKids = classifyQuestions('"venison"', '"Mammals meat"', [
      '"Deer fresh meat"',
      '"Cattle meat"',
    ]);
    assert.ok(withKids.some((q) => q.includes('"related"') && q.includes("natural sibling")));
    assert.equal(withKids.at(-1), `5. Otherwise: assign "none".`);

    const leaf = classifyQuestions('"venison"', '"Deer fresh meat"', null);
    assert.ok(
      leaf.some(
        (q) =>
          q.includes('"related"') &&
          q.includes("similar, with neither being a kind of the other")
      )
    );
    assert.ok(!leaf.some((q) => q.includes("natural sibling")));
    assert.equal(leaf.at(-1), `5. Otherwise: assign "none".`);
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
