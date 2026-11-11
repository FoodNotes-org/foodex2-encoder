import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chooseCommoditySourceLevel,
  chooseSourceLevel,
  systemSourceMatch,
} from "../src/encode/source-walk.js";
import { parseAddedClaim, systemAddedIngredient } from "../src/encode/residuals.js";

describe("chooseSourceLevel", () => {
  it("takes the one exact child and does not open a broad sibling", () => {
    const choice = chooseSourceLevel("broad", true, [
      { code: "species", match: "exact" },
      { code: "family", match: "broad" },
    ]);
    assert.deepEqual(choice.exact, ["species"]);
    assert.deepEqual(choice.descend, []);
    assert.equal(choice.useNode, false);
  });

  it("opens broad children when none is exact", () => {
    const choice = chooseSourceLevel("broad", true, [
      { code: "genus", match: "broad" },
      { code: "other", match: "none" },
    ]);
    assert.deepEqual(choice.exact, []);
    assert.deepEqual(choice.descend, ["genus"]);
    assert.equal(choice.useNode, false);
  });

  it("keeps a broad group when its children are only narrower kinds", () => {
    const choice = chooseSourceLevel("broad", true, [
      { code: "golden", match: "narrow" },
      { code: "bald", match: "narrow" },
    ]);
    assert.deepEqual(choice.exact, []);
    assert.deepEqual(choice.descend, []);
    assert.equal(choice.useNode, true);
  });

  it("does not keep a root, or a seed that is not a hypernym", () => {
    const children = [{ code: "golden", match: "narrow" as const }];
    assert.equal(chooseSourceLevel("root", true, children).useNode, false);
    assert.equal(chooseSourceLevel("seed", false, children).useNode, false);
  });

  it("reports every exact child when several match", () => {
    const choice = chooseSourceLevel("broad", true, [
      { code: "a", match: "exact" },
      { code: "b", match: "exact" },
    ]);
    assert.deepEqual(choice.exact, ["a", "b"]);
    assert.equal(choice.useNode, false);
  });
});

describe("chooseCommoditySourceLevel", () => {
  it("takes the one exact child and does not open a broad sibling", () => {
    const choice = chooseCommoditySourceLevel([
      { code: "A0884", match: "exact" },
      { code: "A04XT", match: "broad" },
    ]);
    assert.equal(choice.exact, "A0884");
    assert.deepEqual(choice.descend, []);
    assert.equal(choice.ambiguous, false);
  });

  it("opens broad children when none is exact", () => {
    const choice = chooseCommoditySourceLevel([
      { code: "A04XT", match: "broad" },
      { code: "A0GMV", match: "none" },
    ]);
    assert.equal(choice.exact, null);
    assert.deepEqual(choice.descend, ["A04XT"]);
    assert.equal(choice.ambiguous, false);
  });

  it("makes no choice when several children are exact", () => {
    const choice = chooseCommoditySourceLevel([
      { code: "a", match: "exact" },
      { code: "b", match: "exact" },
    ]);
    assert.equal(choice.exact, null);
    assert.equal(choice.ambiguous, true);
    assert.deepEqual(choice.descend, []);
  });

  it("adds nothing when every child is only a narrower kind", () => {
    const choice = chooseCommoditySourceLevel([
      { code: "A0884", match: "narrow" },
      { code: "A04XT", match: "narrow" },
    ]);
    assert.equal(choice.exact, null);
    assert.deepEqual(choice.descend, []);
    assert.equal(choice.ambiguous, false);
  });
});

describe("systemSourceMatch", () => {
  it("names the country with the food when a country is given", () => {
    const prompt = systemSourceMatch(true);
    assert.match(prompt, /hypernym of `lookingFor`/);
    assert.match(prompt, /food nomenclature of: `country`/);
  });

  it("omits the country when none is given", () => {
    assert.equal(systemSourceMatch(false).includes("`country`"), false);
  });
});

describe("parseAddedClaim", () => {
  it("accepts an explicit addition and nothing else", () => {
    assert.equal(parseAddedClaim({ added: true }), true);
    assert.equal(parseAddedClaim({ added: false }), false);
    assert.equal(parseAddedClaim({ added: "true" }), false);
    assert.equal(parseAddedClaim(null), false);
  });

  it("says the source of the food is not an addition", () => {
    const prompt = systemAddedIngredient(true);
    assert.match(prompt, /not something added/);
    assert.match(prompt, /\{"added":true\|false\}/);
  });
});
