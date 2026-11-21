/**
 * Classify ladder helpers (no LLM).
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import {
  COMPOSITE_DISHES,
  classifyScopeNote,
} from "../src/encode/classify-ladder.js";

describe("classifyScopeNote", () => {
  const cat = Catalogue.load();

  it("omits the Composite dishes scope note", () => {
    assert.ok(cat.term(COMPOSITE_DISHES)?.scopeNote?.trim());
    assert.equal(classifyScopeNote(cat, COMPOSITE_DISHES), undefined);
  });

  it("keeps other terms' scope notes", () => {
    const meat = "A01QR";
    const note = cat.term(meat)?.scopeNote?.trim();
    assert.ok(note);
    assert.equal(classifyScopeNote(cat, meat), note);
  });
});
