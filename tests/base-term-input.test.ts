import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeBaseTerm, MAX_ENCODE_INPUT_CHARS } from "../src/encode/base-term.js";
import { toUserEncodeResult } from "../src/encode/user-result.js";

describe("encodeBaseTerm input bounds", () => {
  it("rejects empty input before any catalogue work", async () => {
    const result = await encodeBaseTerm("   ");
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "empty_input");
    assert.equal(result.audit[0]?.detail.country, "EU");
  });

  it("uses a given country, and rejects one that is not a country code", async () => {
    const given = await encodeBaseTerm(" ", { country: "nl" });
    assert.equal(given.status, "rejected");
    assert.equal(given.audit[0]?.detail.country, "NL");

    const invalid = await encodeBaseTerm("milk", { country: "ZZ" });
    assert.equal(invalid.status, "rejected");
    assert.equal(invalid.reason, "invalid_country");
  });

  it("rejects descriptions longer than the character cap", async () => {
    const input = "a".repeat(MAX_ENCODE_INPUT_CHARS + 1);
    const result = await encodeBaseTerm(input);
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "input_too_long");
    assert.match(result.message, new RegExp(String(MAX_ENCODE_INPUT_CHARS)));
    assert.match(result.message, new RegExp(String(MAX_ENCODE_INPUT_CHARS + 1)));
    assert.deepEqual(toUserEncodeResult(result), {
      status: "rejected",
      message: result.message,
    });
  });

  it("accepts a description at the character cap as far as the length check", async () => {
    const input = "a".repeat(MAX_ENCODE_INPUT_CHARS);
    // Lexical-only avoids model calls; still exercises the length gate.
    const result = await encodeBaseTerm(input, { lexicalOnly: true });
    if (result.status === "rejected") {
      assert.notEqual(result.reason, "input_too_long");
      assert.notEqual(result.reason, "empty_input");
    } else {
      assert.equal(result.status, "ok");
    }
  });
});
