/**
 * Reference-set loader, against the pinned vendor/foodex2-reference-set.
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadReferenceSet, parseCsv } from "../src/eval/reference-set.js";

describe("parseCsv", () => {
  it("reads quoted commas, doubled quotes and line breaks inside a field", () => {
    const { header, rows } = parseCsv('a,b\n"x, y","say ""hi""\nthere"\n');
    assert.deepEqual(header, ["a", "b"]);
    assert.deepEqual(rows, [{ a: "x, y", b: 'say "hi"\nthere' }]);
  });
});

describe("loadReferenceSet", () => {
  const foods = loadReferenceSet();
  const byId = new Map(foods.map((f) => [f.id, f]));

  it("loads every coded row of v0.1.0", () => {
    assert.equal(foods.length, 107);
    assert.deepEqual(
      [...new Set(foods.map((f) => f.sourceId))].sort(),
      ["cofid-2021", "efsa-foodex2-guidance-2015", "nevo-online-2025", "usda-fdc-foundation"]
    );
  });

  it("keeps the source's code beside the set's own", () => {
    const cod = byId.get("nevo-online-2025/819");
    assert.equal(cod?.publishedCode, "A02BV#F26.A07XD$F28.A07GL");
    assert.equal(cod?.proposedCode, "A02BX#F26.A07XD$F28.A07GL");
    assert.equal(cod?.code, "A02BX#F26.A07XD$F28.A07GL");
    assert.equal(cod?.country, "NL");
  });

  it("falls back to the published code when nothing is proposed", () => {
    const anchovy = byId.get("nevo-online-2025/3199");
    assert.equal(anchovy?.proposedCode, null);
    assert.equal(anchovy?.code, "A02DD");
  });

  it("reads a quoted description and gives guidance examples the EU as country", () => {
    assert.equal(
      byId.get("usda-fdc-foundation/746781")?.description,
      "Sausage, pork, chorizo, link or ground, cooked, pan-fried"
    );
    assert.equal(byId.get("efsa-foodex2-guidance-2015/5.6.2")?.country, "EU");
  });
});
