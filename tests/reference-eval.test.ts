/**
 * Full-code comparison for the reference-set eval.
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareCodes, parseFullCode } from "../src/eval/reference.js";

describe("parseFullCode", () => {
  it("splits the base term from its facets", () => {
    const { base, facets } = parseFullCode("A024G#F04.A01RG$F28.A07GS");
    assert.equal(base, "A024G");
    assert.deepEqual([...facets].sort(), ["F04.A01RG", "F28.A07GS"]);
  });

  it("reads a bare base term as having no facets", () => {
    assert.equal(parseFullCode("A02DD").facets.size, 0);
  });
});

describe("compareCodes", () => {
  it("ignores facet order", () => {
    const c = compareCodes("A024G#F28.A07GS$F04.A01RG", "A024G#F04.A01RG$F28.A07GS");
    assert.deepEqual(c, { base: true, full: true, missing: [], extra: [] });
  });

  it("lists missing and extra facets when the base matches", () => {
    const c = compareCodes("A008C#F28.A07HS", "A008C#F10.A06HR");
    assert.deepEqual(c, { base: true, full: false, missing: ["F10.A06HR"], extra: ["F28.A07HS"] });
  });

  it("fails both on a different base term", () => {
    const c = compareCodes("A024F#F28.A07GS", "A024G#F28.A07GS");
    assert.equal(c.base, false);
    assert.equal(c.full, false);
  });
});
