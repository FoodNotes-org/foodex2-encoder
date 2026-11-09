/**
 * Parsing the raw-or-derivative decision. No model call.
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  baseTermTypesForTreatment,
  parseBaseCompare,
} from "../src/encode/base-compare.js";

describe("parseBaseCompare", () => {
  it("reads no treatment as the raw food", () => {
    assert.deepEqual(parseBaseCompare({ treatment: null, compareAs: "Beef" }), {
      treatment: null,
      compareAs: "Beef",
    });
    assert.deepEqual([...baseTermTypesForTreatment(null)], ["r"]);
  });

  it("reads a listed treatment as the derived food", () => {
    assert.deepEqual(
      parseBaseCompare({ treatment: "A07KG", compareAs: "dried beef" }),
      { treatment: "A07KG", compareAs: "dried beef" }
    );
    assert.deepEqual([...baseTermTypesForTreatment("A07KG")], ["d"]);
  });

  it("rejects an unknown treatment or an empty food", () => {
    assert.equal(parseBaseCompare({ treatment: "A07GT", compareAs: "Beef" }), null);
    assert.equal(parseBaseCompare({ treatment: null, compareAs: "  " }), null);
    assert.equal(parseBaseCompare(null), null);
  });
});
