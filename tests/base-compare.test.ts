/**
 * Table 22 process lookup and the parsers around it. No model call.
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import {
  newFoodCandidates,
  partCodes,
  partPhrasesToRemove,
  parseProcessGroup,
  parseStatedProcesses,
  processesToSetAside,
  removePhrases,
  processCodes,
  termsImplyingProcess,
  type StatedProcess,
} from "../src/encode/base-compare.js";

const cat = Catalogue.load();
const allowed = processCodes(cat);

describe("process list", () => {
  it("includes every kind of process: coating, polishing, grain milling, puffing", () => {
    for (const code of ["A07HP", "A0BZV", "A0C03", "A07LL", "A07MR"]) {
      assert.equal(allowed.has(code), true, code);
    }
  });

  it("holds only process terms", () => {
    assert.equal(allowed.has("A001Q"), false);
  });

  it("finds the groups that already imply chocolate coating", () => {
    const codes = termsImplyingProcess(cat, "A07HP").map((group) => group.code);
    assert.deepEqual(codes, ["A01QQ", "A034R"]);
  });

  it("finds no group that already implies stir-frying", () => {
    assert.deepEqual(termsImplyingProcess(cat, "A07GT"), []);
  });

  it("finds Popped cereals among the groups that already imply puffing", () => {
    const groups = termsImplyingProcess(cat, "A07LL");
    assert.ok(groups.some((group) => group.code === "A04LL"));
    assert.ok(groups.length > 0 && groups.length <= 15);
  });
});

describe("newFoodCandidates", () => {
  const stated = (code: string): StatedProcess => ({ code, phrase: null });

  it("passes on a Tables 4 and 5 process with that row's foods and outcomes", () => {
    const [puffing] = newFoodCandidates(cat, [stated("A07LL")]);
    assert.equal(puffing?.code, "A07LL");
    assert.equal(puffing?.applied_to, "Cereals");
  });

  it("passes on a process that sits under a Tables 4 and 5 process", () => {
    const codes = newFoodCandidates(cat, [stated("A0C0A")]).map((c) => c.code);
    assert.deepEqual(codes, ["A0C0A"]);
  });

  it("leaves out polishing, coating and reconstitution", () => {
    assert.deepEqual(newFoodCandidates(cat, [stated("A0BZV"), stated("A07HP"), stated("A07MR")]), []);
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

  it("drops a code that is not a process and an empty list is none", () => {
    assert.deepEqual(
      parseStatedProcesses({ processes: [{ code: "A001Q", phrase: "farro" }] }, allowed),
      []
    );
    assert.deepEqual(parseStatedProcesses({ processes: [] }, allowed), []);
    assert.equal(parseStatedProcesses(null, allowed), null);
  });

  it("reads parts under their own key and drops a process there", () => {
    assert.deepEqual(
      parseStatedProcesses(
        { parts: [{ code: "A07QQ", phrase: "fat and skin" }, { code: "A07HP", phrase: "coated" }] },
        partCodes(cat),
        "parts"
      ),
      [{ code: "A07QQ", phrase: "fat and skin" }]
    );
  });
});

describe("partPhrasesToRemove", () => {
  it("cuts a shared phrase once", () => {
    const parts: StatedProcess[] = [
      { code: "A07QQ", phrase: "meat, fat and skin" },
      { code: "A0F4T", phrase: "meat, fat and skin" },
    ];
    assert.deepEqual(partPhrasesToRemove(parts, []), ["meat, fat and skin"]);
  });

  it("keeps words that state a process the description keeps", () => {
    const parts: StatedProcess[] = [{ code: "A0F1R", phrase: "chocolate-coated" }];
    assert.deepEqual(partPhrasesToRemove(parts, ["chocolate-coated"]), []);
  });
});

describe("part list", () => {
  const parts = partCodes(cat);

  it("includes parts the food comes with or without: with skin, visible fat, drained", () => {
    for (const code of ["A07QQ", "A0F4T", "A0F2X", "A07QM"]) {
      assert.equal(parts.has(code), true, code);
    }
  });

  it("leaves out headings and the parts a food is only", () => {
    for (const code of ["A0F1Q", "A0F1P", "A0F7Q", "A0F7P", "A0F1K", "A0F2V"]) {
      assert.equal(parts.has(code), false, code);
    }
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
