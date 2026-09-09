/**
 * Pluggable data source (registry + disk fallback).
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dataFileAvailable,
  provideDataFile,
  readDataBytes,
  readDataText,
  RUNTIME_DATA_FILES,
} from "../src/data.js";

describe("provideDataFile registry", () => {
  it("lists the six runtime files the Worker will stage", () => {
    assert.deepEqual([...RUNTIME_DATA_FILES], [
      "catalogue.json",
      "search-names.json",
      "embeddings-base.json",
      "embeddings-base.f32",
      "embeddings-facets.json",
      "embeddings-facets.f32",
    ]);
  });

  it("serves a registered text file without touching disk", () => {
    const name = `__test_registry_${Date.now()}.json`;
    assert.equal(dataFileAvailable(name), false);
    provideDataFile(name, '{"ok":true}');
    assert.equal(dataFileAvailable(name), true);
    assert.equal(readDataText(name), '{"ok":true}');
  });

  it("serves registered bytes and decodes them as text", () => {
    const name = `__test_registry_bytes_${Date.now()}.bin`;
    provideDataFile(name, new TextEncoder().encode("abc"));
    assert.deepEqual([...readDataBytes(name)], [...new TextEncoder().encode("abc")]);
    assert.equal(readDataText(name), "abc");
  });
});

describe("disk fallback", () => {
  it("still reads catalogue.json from data/", () => {
    assert.equal(dataFileAvailable("catalogue.json"), true);
    const raw = readDataText("catalogue.json");
    assert.ok(raw.startsWith("{"));
    assert.ok(raw.includes("terms"));
  });
});
