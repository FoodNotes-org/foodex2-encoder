/**
 * Numeric facet bucket snap (F07 / F11) — no LLM.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import {
  alcoholContentBuckets,
  dropNumericRestatements,
  fatContentBuckets,
  nearestAlcoholFacet,
  nearestFatFacet,
  nearestNumericBucket,
  parseNumericContent,
  parseNumericLeafName,
  parsePercentField,
  phraseCoveredByNumeric,
  type NumericBucket,
} from "../src/encode/numeric-facets.js";

const cat = Catalogue.load();

describe("parseNumericLeafName", () => {
  it("parses ordinary and less-than leaves", () => {
    assert.deepEqual(parseNumericLeafName("1.5 % fat"), { value: 1.5, lessThan: false });
    assert.deepEqual(parseNumericLeafName("40 % alcohol v/v"), {
      value: 40,
      lessThan: false,
    });
    assert.deepEqual(parseNumericLeafName("< 0.1 % fat"), { value: 0.1, lessThan: true });
  });

  it("rejects non-percent names", () => {
    assert.equal(parseNumericLeafName("Low fat"), null);
  });
});

describe("nearestNumericBucket", () => {
  const buckets: NumericBucket[] = [
    { code: "LT", name: "< 0.1 % fat", value: 0.1, lessThan: true },
    { code: "A", name: "0.1 % fat", value: 0.1, lessThan: false },
    { code: "B", name: "1.5 % fat", value: 1.5, lessThan: false },
    { code: "C", name: "1.6 % fat", value: 1.6, lessThan: false },
    { code: "D", name: "40 % fat", value: 40, lessThan: false },
  ];

  it("uses the less-than leaf below the threshold", () => {
    assert.equal(nearestNumericBucket(buckets, 0.05)?.code, "LT");
    assert.equal(nearestNumericBucket(buckets, 0)?.code, "LT");
  });

  it("snaps to the nearest ordinary leaf", () => {
    assert.equal(nearestNumericBucket(buckets, 1.5)?.code, "B");
    assert.equal(nearestNumericBucket(buckets, 1.54)?.code, "B");
    assert.equal(nearestNumericBucket(buckets, 1.56)?.code, "C");
    assert.equal(nearestNumericBucket(buckets, 40)?.code, "D");
  });

  it("ties go to the lower bucket", () => {
    assert.equal(nearestNumericBucket(buckets, 1.55)?.code, "B");
  });
});

describe("catalogue F07 / F11 buckets", () => {
  it("loads real fat and alcohol leaves", () => {
    assert.ok(fatContentBuckets(cat).length > 100);
    assert.ok(alcoholContentBuckets(cat).length > 100);
  });

  it("maps 1.5% fat and 40% alcohol to known codes", () => {
    assert.equal(nearestFatFacet(cat, 1.5)?.code, "A06ZA");
    assert.equal(nearestAlcoholFacet(cat, 40)?.code, "A07DL");
  });

  it("maps very low fat to < 0.1 % fat", () => {
    assert.equal(nearestFatFacet(cat, 0.05)?.code, "A06YH");
  });
});

describe("parseNumericContent", () => {
  it("reads fat and alcohol fields", () => {
    assert.deepEqual(parseNumericContent({ fatPercent: 1.5, alcoholPercent: null }), {
      fatPercent: 1.5,
      alcoholPercent: null,
    });
    assert.deepEqual(parseNumericContent({ fatPercent: "1,5", alcoholPercent: 40 }), {
      fatPercent: 1.5,
      alcoholPercent: 40,
    });
    assert.deepEqual(parseNumericContent(null), {
      fatPercent: null,
      alcoholPercent: null,
    });
  });

  it("parsePercentField rejects junk", () => {
    assert.equal(parsePercentField("nope"), null);
    assert.equal(parsePercentField(Number.NaN), null);
  });
});

describe("phraseCoveredByNumeric", () => {
  const fat = { fatPercent: 1.5, alcoholPercent: null as number | null };
  const alc = { fatPercent: null as number | null, alcoholPercent: 40 };

  it("drops quantitative restatements only", () => {
    assert.equal(phraseCoveredByNumeric("1.5% fat", fat), true);
    assert.equal(phraseCoveredByNumeric("40% volume", alc), true);
    assert.equal(phraseCoveredByNumeric("low fat", fat), false);
    assert.equal(phraseCoveredByNumeric("organic", fat), false);
  });

  it("splits property lists", () => {
    const { kept, dropped } = dropNumericRestatements(
      [{ phrase: "1.5% fat" }, { phrase: "organic" }],
      fat
    );
    assert.deepEqual(
      kept.map((p) => p.phrase),
      ["organic"]
    );
    assert.deepEqual(
      dropped.map((p) => p.phrase),
      ["1.5% fat"]
    );
  });
});
