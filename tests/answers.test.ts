/**
 * Model-answer parsers: every code is checked against the offered set.
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseClassifications,
  pickAllowedCode,
  pickAllowedCodes,
} from "../src/encode/answers.js";
import { LADDER_LABELS } from "../src/encode/classify-ladder.js";

const allowed = new Set(["A0B93", "A0B9A", "A0B95"]);

describe("pickAllowedCode", () => {
  it("accepts one offered code, normalising case and whitespace", () => {
    assert.equal(pickAllowedCode({ code: "A0B93" }, allowed), "A0B93");
    assert.equal(pickAllowedCode({ code: " a0b9a " }, allowed), "A0B9A");
  });

  it("reads null, unknown codes and malformed replies as no pick", () => {
    assert.equal(pickAllowedCode({ code: null }, allowed), null);
    assert.equal(pickAllowedCode({ code: "A0B92" }, allowed), null);
    assert.equal(pickAllowedCode({ code: 42 }, allowed), null);
    assert.equal(pickAllowedCode("A0B93", allowed), null);
    assert.equal(pickAllowedCode(null, allowed), null);
  });
});

describe("pickAllowedCodes", () => {
  it("accepts a codes list or a single code", () => {
    assert.deepEqual(pickAllowedCodes({ code: "A0B93" }, allowed), ["A0B93"]);
    assert.deepEqual(pickAllowedCodes({ codes: ["A0B95", "A0B9A"] }, allowed), ["A0B95", "A0B9A"]);
  });

  it("drops null, unknown and repeated codes", () => {
    assert.deepEqual(pickAllowedCodes({ code: null }, allowed), []);
    assert.deepEqual(pickAllowedCodes({ code: "A0B92" }, allowed), []);
    assert.deepEqual(pickAllowedCodes({ codes: ["A0B95", "A0B95", "nope"] }, allowed), ["A0B95"]);
    assert.deepEqual(pickAllowedCodes(null, allowed), []);
  });
});

describe("parseClassifications", () => {
  it("maps offered codes to ladder labels under the given key", () => {
    const content = {
      classifications: [
        { code: "a0b93", fit: "exact" },
        { code: "A0B9A", fit: "none" },
        { code: "A0B95", fit: "sideways" },
        { code: "A0B92", fit: "exact" },
        "junk",
      ],
    };
    const out = parseClassifications(content, allowed, "fit", LADDER_LABELS);
    assert.deepEqual(
      [...(out ?? [])],
      [
        ["A0B93", "exact"],
        ["A0B9A", "none"],
      ]
    );
  });

  it("returns null when the reply has no classifications array", () => {
    assert.equal(parseClassifications({}, allowed, "match", LADDER_LABELS), null);
    assert.equal(parseClassifications(null, allowed, "match", LADDER_LABELS), null);
    assert.equal(
      parseClassifications({ classifications: "A0B93" }, allowed, "match", LADDER_LABELS),
      null
    );
  });
});
