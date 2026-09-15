/**
 * Content-token identity — function words count; accept gate is exact set match.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateLexicalAccept } from "../src/encode/lexical-accept.js";
import {
  contentTokens,
  sameContentTokenSet,
  sameContentTokenSetFuzzy,
} from "../src/search/content-match.js";
import { searchTerms } from "../src/search/lexical.js";

describe("contentTokens", () => {
  it("keeps load-bearing function words", () => {
    assert.deepEqual([...contentTokens("orange juice from concentrate")].sort(), [
      "concentrate",
      "from",
      "juice",
      "orange",
    ]);
  });
});

describe("sameContentTokenSet", () => {
  it("matches order-free names without dropping words", () => {
    assert.equal(sameContentTokenSet("orange juice", "Juice, orange"), true);
  });

  it("does not treat juice-from-concentrate as juice concentrate", () => {
    assert.equal(
      sameContentTokenSet("orange juice from concentrate", "Juice concentrate, orange"),
      false
    );
  });
});

describe("sameContentTokenSetFuzzy", () => {
  it("allows one edit per paired word", () => {
    assert.equal(sameContentTokenSetFuzzy("yoghurt", "Yogurt"), true);
  });
});

describe("evaluateLexicalAccept", () => {
  it("does not accept Juice concentrate for orange juice from concentrate", () => {
    const hits = searchTerms("orange juice from concentrate", {
      limit: 10,
      baseOnly: true,
      underFood: true,
    });
    assert.equal(evaluateLexicalAccept("orange juice from concentrate", hits), null);
  });

  it("still accepts order-free identical names", () => {
    const hits = searchTerms("orange juice", { limit: 10, baseOnly: true, underFood: true });
    const pick = evaluateLexicalAccept("orange juice", hits);
    assert.ok(pick);
    assert.equal(pick.hit.code, "A03AM");
  });
});
