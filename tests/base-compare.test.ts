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
  table22ProcessCodes,
  termsImplyingProcess,
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

  it("finds Popped cereals among the groups that already imply puffing", () => {
    const groups = termsImplyingProcess(cat, "A07LL");
    assert.ok(groups.some((group) => group.code === "A04LL"));
    assert.ok(groups.length > 0 && groups.length <= 15);
  });
});

describe("parseStatedProcesses", () => {
  it("keeps a listed process and its exception flag", () => {
    assert.deepEqual(
      parseStatedProcesses(
        { processes: [{ code: "a07hp", exception: false }, { code: "A07GT", exception: true }] },
        allowed
      ),
      [
        { code: "A07HP", exception: false },
        { code: "A07GT", exception: true },
      ]
    );
  });

  it("drops a process that is not in the table and an empty list is none", () => {
    assert.deepEqual(
      parseStatedProcesses({ processes: [{ code: "A07KG", exception: false }] }, allowed),
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

