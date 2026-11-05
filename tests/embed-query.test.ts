/**
 * Embedding-query rendering (no LLM).
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  embeddingQuerySystem,
  embeddingQueryUser,
  embeddingSearchText,
  parseEmbeddingEnglish,
} from "../src/encode/embed-query.js";

describe("embeddingQuerySystem", () => {
  it("asks for an English name and leaves a name English already uses", () => {
    assert.equal(
      embeddingQuerySystem(),
      `You are rendering a food description in English, so it can be compared with English names of foods.

You are given:
- \`description\`: the food as reported.
- \`country\`: where it was reported. Present only when the user supplied it.

State the food in English, without adding unstated detail.

If \`description\` is already how that food is named in English, \`english\` is null.
Reply with JSON only:
{"english":"<text>"|null}
`
    );
  });
});

describe("embeddingQueryUser", () => {
  it("includes the country only when one was supplied", () => {
    assert.equal(
      embeddingQueryUser("Rundertong rauw", "Netherlands"),
      `{
  "description": "Rundertong rauw",
  "country": "Netherlands"
}`
    );
    assert.equal(
      embeddingQueryUser("raw beef tongue", null),
      `{
  "description": "raw beef tongue"
}`
    );
    assert.equal(
      embeddingQueryUser("raw beef tongue", "  "),
      `{
  "description": "raw beef tongue"
}`
    );
  });
});

describe("parseEmbeddingEnglish", () => {
  it("reads a rendering or null", () => {
    assert.equal(parseEmbeddingEnglish({ english: "Raw beef tongue" }), "Raw beef tongue");
    assert.equal(parseEmbeddingEnglish({ english: null }), null);
    assert.equal(parseEmbeddingEnglish({ english: "  " }), null);
  });

  it("rejects a reply that is not the agreed shape", () => {
    assert.throws(() => parseEmbeddingEnglish(null), /non-object/);
    assert.throws(() => parseEmbeddingEnglish(["Raw beef tongue"]), /non-object/);
    assert.throws(() => parseEmbeddingEnglish({ english: 1 }), /non-string/);
  });
});

describe("embeddingSearchText", () => {
  it("keeps the description when there is no rendering", () => {
    assert.equal(embeddingSearchText("Rundertong rauw", null), "Rundertong rauw");
    assert.equal(embeddingSearchText("Rundertong rauw", "  "), "Rundertong rauw");
  });

  it("searches the rendering and leaves the description for the caller to keep", () => {
    const description = "Rundertong rauw";
    assert.equal(embeddingSearchText(description, "Raw beef tongue"), "Raw beef tongue");
    assert.equal(description, "Rundertong rauw");
  });
});
