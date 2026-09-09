/**
 * Query-embedder seam (no network / no transformers.js).
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_EMBEDDING_MODEL_ID,
  EMBEDDING_MODELS,
  embedQuery,
  setQueryEmbedder,
} from "../src/search/embeddings.js";

describe("setQueryEmbedder", () => {
  it("points the default model at Workers AI weights", () => {
    const spec = EMBEDDING_MODELS[DEFAULT_EMBEDDING_MODEL_ID]!;
    assert.equal(spec.workersAiModel, "@cf/baai/bge-small-en-v1.5");
  });

  it("routes embedQuery through the installed embedder with the BGE prefix", async () => {
    const seen: string[] = [];
    setQueryEmbedder(async (prefixed) => {
      seen.push(prefixed);
      return Float32Array.from([1, 0, 0]);
    });
    try {
      const v = await embedQuery("scrambled eggs");
      assert.deepEqual([...v], [1, 0, 0]);
      assert.equal(seen.length, 1);
      assert.equal(
        seen[0],
        "Represent this sentence for searching relevant passages: scrambled eggs"
      );
    } finally {
      setQueryEmbedder(null);
    }
  });
});
