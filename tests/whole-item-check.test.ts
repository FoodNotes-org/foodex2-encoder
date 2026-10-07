/**
 * Whole-item check helpers (no LLM).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import {
  isWholeItemChecked,
  parseWholeItemVerdicts,
  wholeItemPayload,
} from "../src/encode/whole-item-check.js";
import type { FacetDescriptorRef } from "../src/encode/types.js";

const cat = Catalogue.load();

const freezing: FacetDescriptorRef = { header: "F28", code: "A07KQ", name: "Freezing" };
const fresh: FacetDescriptorRef = { header: "F10", code: "A166Y", name: "Fresh" };
const unspecified: FacetDescriptorRef = { header: "F26", code: "A07XD", name: "Unspecified" };

describe("parseWholeItemVerdicts", () => {
  it("reads verdicts keyed by header.code", () => {
    const verdicts = parseWholeItemVerdicts(
      {
        verdicts: [
          { facet: "F28.A07KQ", statement: "The food is frozen.", true: false },
          { facet: "F10.A166Y", statement: "The food is fresh.", true: true },
        ],
      },
      [freezing, fresh]
    );
    assert.deepEqual(
      verdicts.map((v) => v.holds),
      [false, true]
    );
    assert.equal(verdicts[0]!.statement, "The food is frozen.");
  });

  it("falls back to the descriptor code when the header is replaced by the category label", () => {
    const verdicts = parseWholeItemVerdicts(
      { verdicts: [{ facet: "Process.A07KQ", true: false }] },
      [freezing]
    );
    assert.equal(verdicts[0]!.holds, false);
  });

  it("leaves a facet unjudged when the reply omits it or is malformed", () => {
    assert.equal(parseWholeItemVerdicts({ verdicts: [] }, [freezing])[0]!.holds, null);
    assert.equal(parseWholeItemVerdicts("nope", [freezing])[0]!.holds, null);
    assert.equal(
      parseWholeItemVerdicts({ verdicts: [{ facet: "F28.A07KQ", true: "no" }] }, [freezing])[0]!
        .holds,
      null
    );
  });
});

describe("isWholeItemChecked", () => {
  it("skips Generic-term, which is not a property of the food", () => {
    assert.equal(isWholeItemChecked(unspecified), false);
    assert.equal(isWholeItemChecked(freezing), true);
  });
});

describe("wholeItemPayload", () => {
  it("names the base term and each facet's category", () => {
    const body = JSON.parse(
      wholeItemPayload(cat, "fresh and frozen shellfish", "A026T", [freezing])
    ) as { input: string; code: { baseTerm: string; facets: Array<{ category: string }> } };
    assert.equal(body.input, "fresh and frozen shellfish");
    assert.equal(body.code.baseTerm, "Fish and seafood");
    assert.equal(body.code.facets[0]!.category, "Process");
  });
});
