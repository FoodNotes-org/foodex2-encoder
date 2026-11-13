/**
 * Table 22 process lookup and the parsers around it. No model call.
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import {
  natureProcessCodes,
  parseProcessGroup,
  parseStatedProcesses,
  processesToSetAside,
  removePhrases,
  table22ProcessCodes,
  termsImplyingProcess,
  type StatedProcess,
} from "../src/encode/base-compare.js";

const cat = Catalogue.load();
const allowed = table22ProcessCodes(cat);

describe("table 22 processes", () => {
  it("includes chocolate coating and stir-frying, and not drying or grain milling", () => {
    assert.equal(allowed.has("A07HP"), true);
    assert.equal(allowed.has("A07GT"), true);
    assert.equal(allowed.has("A07KG"), false);
    assert.equal(allowed.has("A0C03"), false);
  });

  it("finds the groups that already imply chocolate coating", () => {
    const codes = termsImplyingProcess(cat, "A07HP").map((group) => group.code);
    assert.deepEqual(codes, ["A01QQ", "A034R"]);
  });

  it("finds no group that already implies stir-frying", () => {
    assert.deepEqual(termsImplyingProcess(cat, "A07GT"), []);
  });
});

describe("nature-changing processes", () => {
  const nature = natureProcessCodes(cat);

  it("includes puffing and drying, and not a table 22 process", () => {
    assert.equal(nature.has("A07LL"), true);
    assert.equal(nature.has("A07KG"), true);
    assert.equal(nature.has("A07HP"), false);
    assert.equal(allowed.has("A07LL"), false);
  });

  it("lists separation in liquid phase under today's code", () => {
    assert.equal(nature.has("A0EKQ"), true);
    assert.equal(nature.has("A0EJP"), false);
  });

  it("finds Popped cereals among the groups that already imply puffing", () => {
    const groups = termsImplyingProcess(cat, "A07LL");
    assert.ok(groups.some((group) => group.code === "A04LL"));
    assert.ok(groups.length > 0 && groups.length <= 15);
  });
});

describe("processesToSetAside", () => {
  const freezing: StatedProcess = { code: "A07KQ", phrase: "frozen" };
  const pasteurisation: StatedProcess = { code: "A07HV", phrase: "pasteurized" };

  it("takes out a table 22 treatment the chosen group does not cover", () => {
    assert.deepEqual(processesToSetAside([freezing, pasteurisation], []), [
      freezing,
      pasteurisation,
    ]);
  });

  it("keeps a treatment the chosen group already covers", () => {
    assert.deepEqual(processesToSetAside([freezing, pasteurisation], ["A07KQ"]), [pasteurisation]);
  });
});

describe("removePhrases", () => {
  it("cuts each phrase and the empty comma parts it leaves", () => {
    assert.deepEqual(removePhrases("Egg, whole, raw, frozen, pasteurized", ["frozen", "pasteurized"]), {
      text: "Egg, whole, raw",
      removed: ["frozen", "pasteurized"],
    });
    assert.deepEqual(removePhrases("Courgette, fried in corn oil", ["fried in corn oil"]), {
      text: "Courgette",
      removed: ["fried in corn oil"],
    });
    assert.deepEqual(removePhrases("Kabeljauw gekookt", ["Gekookt"]), {
      text: "Kabeljauw",
      removed: ["gekookt"],
    });
  });

  it("leaves a phrase that is not in the description", () => {
    assert.deepEqual(removePhrases("tuna in brine, canned", ["tinned"]), {
      text: "tuna in brine, canned",
      removed: [],
    });
  });

  it("keeps the description whole when nothing would remain", () => {
    assert.deepEqual(removePhrases("Quinoa flour", ["Quinoa flour"]), { text: "Quinoa flour", removed: [] });
  });
});

describe("parseStatedProcesses", () => {
  it("keeps a listed process and the words that state it", () => {
    assert.deepEqual(
      parseStatedProcesses(
        { processes: [{ code: "a07hp", phrase: " chocolate-coated " }, { code: "A07GT" }] },
        allowed
      ),
      [
        { code: "A07HP", phrase: "chocolate-coated" },
        { code: "A07GT", phrase: null },
      ]
    );
  });

  it("drops a process that is not in the table and an empty list is none", () => {
    assert.deepEqual(
      parseStatedProcesses({ processes: [{ code: "A07KG", phrase: "dried" }] }, allowed),
      []
    );
    assert.deepEqual(parseStatedProcesses({ processes: [] }, allowed), []);
    assert.equal(parseStatedProcesses(null, allowed), null);
  });
});

describe("parseProcessGroup", () => {
  const groups = new Set(["A034R", "A01QQ"]);

  it("reads the chosen term or none", () => {
    assert.deepEqual(parseProcessGroup({ code: "a034r" }, groups), { code: "A034R" });
    assert.deepEqual(parseProcessGroup({ code: null }, groups), { code: null });
  });

  it("rejects a term that was not offered", () => {
    assert.equal(parseProcessGroup({ code: "A01PS" }, groups), null);
    assert.equal(parseProcessGroup(null, groups), null);
  });
});


describe("groups offered for a treatment", () => {
  it("never offers a term that is not reportable (Potato boiled)", () => {
    const codes = termsImplyingProcess(cat, "A07GL").map((group) => group.code);
    assert.equal(codes.includes("A011P"), false);
  });
});
