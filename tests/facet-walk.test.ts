/**
 * Facet-walk helpers (no LLM).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import {
  FACET_WALK_SKIP_HEADERS,
  walkableDimensions,
} from "../src/encode/facet-walk.js";
import { facetDimensions } from "../src/encode/residuals.js";

const cat = Catalogue.load();

describe("FACET_WALK_SKIP_HEADERS", () => {
  it("excludes numeric and generic-term headers", () => {
    assert.ok(FACET_WALK_SKIP_HEADERS.has("F07"));
    assert.ok(FACET_WALK_SKIP_HEADERS.has("F11"));
    assert.ok(FACET_WALK_SKIP_HEADERS.has("F26"));
    assert.equal(FACET_WALK_SKIP_HEADERS.has("F28"), false);
    assert.equal(FACET_WALK_SKIP_HEADERS.has("F10"), false);
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
