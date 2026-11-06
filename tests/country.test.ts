/**
 * Country code validation (no LLM).
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countryContextLine, countryParagraph, resolveCountry } from "../src/country.js";

describe("resolveCountry", () => {
  it("resolves an ISO code to its English name, case-insensitively", () => {
    assert.deepEqual(resolveCountry("US"), { ok: true, code: "US", name: "United States" });
    assert.deepEqual(resolveCountry(" it "), { ok: true, code: "IT", name: "Italy" });
  });

  it("points UK to GB", () => {
    const result = resolveCountry("UK");
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.message : "", /For United Kingdom, use GB\./);
  });

  it("accepts EU for the European Union", () => {
    assert.deepEqual(resolveCountry("eu"), { ok: true, code: "EU", name: "European Union" });
  });

  it("reads food names in the sense they have in that country's nomenclature", () => {
    assert.equal(
      countryContextLine("item"),
      "Read the food names in `item` in the sense they have in `country`'s food nomenclature."
    );
  });

  it("keeps the country sentence as its own paragraph", () => {
    assert.equal(countryParagraph(false, "name"), "");
    assert.equal(countryParagraph(true, "name"), `\n${countryContextLine("name")}\n`);
  });

  it("rejects codes ISO 3166-1 does not assign to a country", () => {
    for (const code of ["XX", "ZZ", "USA", ""]) {
      assert.equal(resolveCountry(code).ok, false, code);
    }
  });
});
