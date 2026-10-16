import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import { catalogueLookup } from "../src/rules/catalogue-lookup.js";
import { checkCode, parseCode } from "../src/rules/index.js";

const lookup = catalogueLookup(Catalogue.load());

function rules(code: string): string[] {
  return checkCode(code, lookup).findings.map((f) => `${f.severity}:${f.rule}`);
}

describe("parseCode", () => {
  it("splits base and facets", () => {
    const p = parseCode(" a03vv#F04.A01SP$F28.A07GZ ");
    assert.equal(p.base, "A03VV");
    assert.deepEqual(p.facets, [
      { facet: "F04", code: "A01SP" },
      { facet: "F28", code: "A07GZ" },
    ]);
    assert.deepEqual(p.problems, []);
  });

  it("reports malformed parts without throwing", () => {
    const p = parseCode("#F28.A07GZ$junk");
    assert.equal(p.base, null);
    assert.equal(p.problems.length, 2);
  });
});

describe("checkCode: EFSA's own rule-sheet examples", () => {
  const cases: Array<[string, string]> = [
    ["A065H#F01.A057E", "error:BR03"],
    ["A065H#F27.A02LX", "error:BR04"],
    ["A00FT", "warning:BR10"],
    ["A00JA#F28.A07JP", "error:BR19"],
    ["A00ZQ#F28.A0C0R", "warning:BR11"],
    ["A00TQ#F04.A042P", "warning:BR12"],
    ["A0EJM", "error:BR17"],
    ["A002D", "error:BR20"],
    ["A00FJ", "warning:BR23"],
    ["A015E", "error:BR24"],
    ["A039M#F01.A05YH$F01.A05YG", "error:BR25"],
    ["A03BP#F28.A07MR", "error:BR28"],
  ];
  for (const [code, expected] of cases) {
    it(`${code} -> ${expected}`, () => assert.ok(rules(code).includes(expected), rules(code).join(" ")));
  }
});

describe("checkCode: structure", () => {
  it("BR16 a process broader than the implied one, in an EFSA warn group", () => {
    // Candied fruits implies "Preserving with sugars"; its parent is less detailed.
    assert.deepEqual(rules("A01PS#F28.A0C0N"), ["error:BR16"]);
  });
  it("BR13 powder state on a raw commodity", () => {
    assert.ok(rules("A00JA#F03.A06JD").includes("error:BR13"));
  });
  it("BR29 unknown term, BR30 unknown facet, BR31 descriptor in the wrong facet", () => {
    assert.ok(rules("A040Z#F28.ZZZZZ").includes("error:BR29"));
    assert.deepEqual(rules("A040Z#F99.A001D"), ["error:BR30"]);
    assert.deepEqual(rules("A040Z#F28.A001D"), ["error:BR31"]);
  });
  it("accepts a clean code from the encoder", () => {
    assert.deepEqual(rules("A03VV#F04.A01SP$F28.A07GZ"), []);
  });
});

describe("checkCode: cardinality", () => {
  it("BR25 on two F01 sources carries the conflict with the facet description", () => {
    const finding = checkCode("A039M#F01.A05YH$F01.A05YG", lookup).findings.find((f) => f.rule === "BR25");
    assert.equal(finding?.conflict?.id, "cardinality-F01-F30-F32");
  });
  it("two F17 descriptors warn; the burned-spots exception does not count", () => {
    assert.deepEqual(rules("A03VV#F17.A07NA$F17.A07NB"), ["warning:facet-allows-one"]);
    assert.deepEqual(rules("A03VV#F17.A07NA$F17.A07ND"), []);
  });
  it("two F33 classes from the same legislation warn, as our reading", () => {
    const [finding] = checkCode("A03VV#F33.A163T$F33.A163V", lookup).findings;
    assert.equal(finding?.rule, "facet-allows-one");
    assert.equal(finding?.by, "FoodNotes");
  });
});

describe("checkCode: implied facets", () => {
  it("warns when a stated facet repeats an implied one", () => {
    assert.deepEqual(rules("A040Z#F04.A001D"), ["warning:repeats-implied"]);
  });
  it("warns when a single-descriptor facet contradicts the implied one", () => {
    assert.deepEqual(rules("A03VV#F02.A06GV"), ["warning:implied-contradiction"]);
  });
});
