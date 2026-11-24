/**
 * Dish route prompts and inputs (no LLM).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import { countryContextLine } from "../src/country.js";
import {
  dishFacetInfo,
  dishFacets,
  dishFacetTerms,
  dishDifferentia,
  dishSelectionGenus,
  parseDishIngredients,
  parseOfferedCodes,
  systemDishRecall,
  systemDishSelection,
  systemDishIngredients,
} from "../src/encode/dish-route.js";

const cat = Catalogue.load();

describe("dish route prompts", () => {
  const prompts = [systemDishIngredients, systemDishRecall, systemDishSelection];

  it("reads the description in the country's nomenclature only when a country is given", () => {
    const line = countryContextLine("description");
    const descriptionLine = "- `description`: the food, as understood in the food nomenclature of: `country`.";
    for (const prompt of prompts) {
      assert.equal(prompt(true).includes(line), false);
      assert.equal(prompt(false).includes("`country`"), false);
      assert.equal(prompt(true).split(descriptionLine).length - 1, 1);
    }
    for (const prompt of prompts) {
      assert.equal(prompt(false).includes("\n\n\n"), false);
      assert.equal(prompt(true).includes("\n\n\n"), false);
    }
  });

  it("asks each prompt for its own answer key", () => {
    assert.match(systemDishIngredients(false), /\{"ingredients":\["<phrase>",\.\.\.\]\}/);
    assert.match(systemDishRecall(false), /\{"codes":\["<code>",\.\.\.\]\}/);
    assert.match(systemDishSelection(false), /\{"codes":\["<code>",\.\.\.\]\}/);
  });

  it("tells selection that each candidate's facet comes with its catalogue note", () => {
    assert.match(systemDishSelection(true), /- `facets`: the facets of the differentiae, each with its `name` and its `description`\./);
  });
});

describe("dishFacets", () => {
  it("offers surrounding medium only to a simple composite", () => {
    assert.equal(dishFacets("s").includes("F06"), true);
    assert.equal(dishFacets("c").includes("F06"), false);
    assert.equal(dishFacets("c").includes("F28"), true);
  });

  it("never offers the facets other steps or rules handle", () => {
    for (const facet of ["F01", "F02", "F03", "F04", "F07", "F09", "F11", "F21", "F26", "F27"]) {
      assert.equal(dishFacets("s").includes(facet), false, facet);
    }
  });
});

describe("dishFacetTerms", () => {
  it("leaves out the process the shelf implies and keeps the others, with scope notes", () => {
    // Meat stew implies Stewing.
    assert.ok(cat.impliedFacets("A03VY").includes("F28.A07GM"));
    const terms = dishFacetTerms(cat, "A03VY", "F28");
    const codes = new Set(terms.map((term) => term.code));
    assert.equal(codes.has("A07GM"), false);
    assert.equal(codes.has("A07GR"), true);
    assert.equal(codes.has("A07HL"), true);
    assert.ok(terms.every((term) => term.scope !== ""));
  });

  it("has no deprecated descriptors and no repeats", () => {
    const terms = dishFacetTerms(cat, "A03XX", "F28");
    assert.equal(new Set(terms.map((term) => term.code)).size, terms.length);
    assert.ok(terms.every((term) => !cat.isDeprecated(term.code)));
  });
});

describe("dish selection inputs", () => {
  it("labels the genus's implied descriptors with their facet", () => {
    const genus = dishSelectionGenus(cat, "A03YJ", { name: "Egg based dishes", scope: "" });
    assert.ok(genus.implies.some((line) => line.startsWith("Ingredient: ")));
  });

  it("lists the classes above the genus, broadest first", () => {
    const genus = dishSelectionGenus(cat, "A03XX", { name: "Vegetable based dishes", scope: "" });
    assert.deepEqual(genus.broader, [
      "Composite dishes",
      "Dishes, incl. Ready to eat meals (excluding soups and salads)",
      "Dishes excluding pasta or rice dishes, sandwiches and pizza",
    ]);
  });

  it("keys a candidate descriptor by facet, so one descriptor in two facets stays apart", () => {
    const quality = dishDifferentia(cat, "F10", "A07VP");
    const use = dishDifferentia(cat, "F24", "A07VP");
    assert.equal(quality.code, "F10.A07VP");
    assert.equal(use.code, "F24.A07VP");
    assert.notEqual(quality.name, use.name);
  });

  it("gives the facet's catalogue description", () => {
    const info = dishFacetInfo(cat, "F22");
    assert.equal(info.name, "Preparation-production-place");
    assert.notEqual(info.description, "");
  });
});

describe("dish route parsers", () => {
  it("reads ingredient phrases without blanks or repeats", () => {
    assert.deepEqual(parseDishIngredients({ ingredients: ["corn", " ", "corn", 3] }), ["corn"]);
    assert.deepEqual(parseDishIngredients({}), []);
  });

  it("keeps only offered codes, in answer order", () => {
    const offered = new Set(["A07HL", "A07GR"]);
    assert.deepEqual(parseOfferedCodes({ codes: ["A07GR", "XXXXX", "A07HL", "A07GR"] }, offered), [
      "A07GR",
      "A07HL",
    ]);
    assert.deepEqual(parseOfferedCodes(null, offered), []);
  });
});
