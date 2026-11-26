import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chooseCommoditySourceLevel,
  chooseSourceLevel,
  systemSourceMatch,
} from "../src/encode/source-walk.js";
import { parseAddedNames, systemAddedIngredient } from "../src/encode/residuals.js";

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
  it("treats a name that can denote more than one source as not exact", () => {
    const prompt = systemSourceMatch();
    assert.match(prompt, /denotes this term and no source outside it/);
    assert.match(prompt, /can also denote a source outside this term/);
    assert.match(prompt, /contains every source `lookingFor` can denote/);
    assert.equal(prompt.includes("`food`"), false);
  });
});

describe("parseAddedNames", () => {
  it("keeps non-empty names once and nothing else", () => {
    assert.deepEqual(parseAddedNames({ added: ["chocolate"] }), ["chocolate"]);
    assert.deepEqual(parseAddedNames({ added: [" raisins ", "Raisins", "", 3, "almonds"] }), ["raisins", "almonds"]);
    assert.deepEqual(parseAddedNames({ added: [] }), []);
    assert.deepEqual(parseAddedNames({ added: true }), []);
    assert.deepEqual(parseAddedNames(null), []);
  });

  it("asks for the things put in or on by name, not inferred from a process", () => {
    const prompt = systemAddedIngredient(true);
    assert.match(prompt, /do not infer one from a process/);
    assert.match(prompt, /not the food that results from putting it in or on/);
    assert.match(prompt, /The plant, animal, or commodity the food comes from is not put into or onto it\./);
    assert.match(prompt, /\{"added":\["<name>",\.\.\.\]\}/);
  });
});
