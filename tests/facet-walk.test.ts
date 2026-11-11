/**
 * Facet-walk helpers (no LLM).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import {
  FACET_WALK_SKIP_HEADERS,
  nearestFacetSeeds,
  systemOriginPick,
  systemSourceCommodityPick,
  walkableDimensions,
} from "../src/encode/facet-walk.js";
import { facetDimensions } from "../src/encode/residuals.js";

const cat = Catalogue.load();

describe("FACET_WALK_SKIP_HEADERS", () => {
  it("excludes numeric, fortification-agent and generic-term headers", () => {
    assert.ok(FACET_WALK_SKIP_HEADERS.has("F07"));
    assert.ok(FACET_WALK_SKIP_HEADERS.has("F09"));
    assert.ok(FACET_WALK_SKIP_HEADERS.has("F11"));
    assert.ok(FACET_WALK_SKIP_HEADERS.has("F26"));
    assert.equal(FACET_WALK_SKIP_HEADERS.has("F28"), false);
    assert.equal(FACET_WALK_SKIP_HEADERS.has("F10"), false);
  });
});

describe("systemOriginPick", () => {
  it("keeps a term only when the chosen class does not already denote it", () => {
    const prompt = systemOriginPick("source", true, false);
    assert.match(prompt, /that `baseTerm` does not already denote/);
    assert.match(prompt, /with its `name` and its `scope`/);
    assert.match(prompt, /including under another name/);
    assert.match(prompt, /\{"code":"<code>"\|null\}/);
  });

  it("asks the same of every term when the list allows several", () => {
    const prompt = systemOriginPick("ingredient", false, true);
    assert.match(prompt, /characterising ingredient/);
    assert.match(prompt, /that `baseTerm` does not already denote/);
    assert.match(prompt, /\{"codes":\["<code>",\.\.\.\]\}/);
    assert.doesNotMatch(prompt, /fresh denotes the raw commodity/);
  });
});

describe("systemSourceCommodityPick", () => {
  it("asks for the raw commodity, and treats fresh as that commodity", () => {
    const prompt = systemSourceCommodityPick(true, true);
    assert.match(prompt, /raw commodities `food` is made from/);
    assert.match(prompt, /fresh denotes the raw commodity, not a further detail/);
    assert.match(prompt, /narrowest remainder/);
    assert.match(prompt, /European Union|food nomenclature/);
    assert.match(prompt, /\{"codes":\["<code>",\.\.\.\]\}/);
    assert.doesNotMatch(prompt, /does not name/);
  });
});

describe("nearestFacetSeeds", () => {
  it("keeps the nearest five process terms and skips other facets", () => {
    const hits = [
      { code: "A01QE", similarity: 0.9 },
      { code: "A07JR", similarity: 0.8 },
      { code: "A067G", similarity: 0.79 },
      { code: "A07JQ", similarity: 0.7 },
      { code: "A0C0N", similarity: 0.65 },
      { code: "A07JV", similarity: 0.6 },
      { code: "A0CER", similarity: 0.55 },
      { code: "A07JS", similarity: 0.5 },
    ];
    const seeds = nearestFacetSeeds(cat, "F28", hits, undefined, 5);
    assert.deepEqual(
      seeds.map((seed) => seed.code),
      ["A07JR", "A07JQ", "A0C0N", "A07JV", "A0CER"]
    );
    assert.ok(seeds.every((seed) => seed.header === "F28"));
  });

  it("skips a process term the walk would not record", () => {
    const hits = [
      { code: "A07JR", similarity: 0.8 },
      { code: "A07JQ", similarity: 0.7 },
    ];
    const seeds = nearestFacetSeeds(cat, "F28", hits, (_header, code) => code !== "A07JR", 5);
    assert.deepEqual(
      seeds.map((seed) => seed.code),
      ["A07JQ"]
    );
  });
});

describe("walkableDimensions", () => {
  it("drops Fat-content, Alcohol-content, and Generic-term", () => {
    const dims = facetDimensions(cat);
    const walkable = walkableDimensions(dims);
    assert.ok(dims.some((d) => d.header === "F07"));
    assert.ok(dims.some((d) => d.header === "F11"));
    assert.equal(
      walkable.some((d) => FACET_WALK_SKIP_HEADERS.has(d.header)),
      false
    );
    assert.ok(walkable.some((d) => d.header === "F28"));
    assert.ok(walkable.some((d) => d.header === "F10"));
  });
});
