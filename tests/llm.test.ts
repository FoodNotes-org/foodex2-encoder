/**
 * Deterministic LLM client helpers (no network).
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffUsage, isProviderInfraReason, LlmError, parseUsage } from "../src/llm.js";

describe("LlmError / infra reasons", () => {
  it("flags credits, rate limit, unavailable as infra", () => {
    assert.equal(isProviderInfraReason("provider_credits"), true);
    assert.equal(isProviderInfraReason("provider_rate_limit"), true);
    assert.equal(isProviderInfraReason("provider_unavailable"), true);
    assert.equal(isProviderInfraReason("model_response_invalid"), false);
    assert.equal(isProviderInfraReason("traversal_error"), false);
  });

  it("carries kind and status", () => {
    const err = new LlmError("provider_credits", "out of credits", 402);
    assert.equal(err.kind, "provider_credits");
    assert.equal(err.status, 402);
    assert.equal(err.name, "LlmError");
  });
});

describe("usage accounting", () => {
  it("reads tokens and cost from an OpenRouter usage object", () => {
    assert.deepEqual(
      parseUsage({ prompt_tokens: 194, completion_tokens: 2, total_tokens: 196, cost: 0.0012 }),
      { calls: 1, promptTokens: 194, completionTokens: 2, costUsd: 0.0012 }
    );
  });

  it("keeps tokens and leaves cost null when the endpoint does not price the call", () => {
    assert.deepEqual(parseUsage({ prompt_tokens: 10, completion_tokens: 5 }), {
      calls: 1,
      promptTokens: 10,
      completionTokens: 5,
      costUsd: null,
    });
  });

  it("returns null for a missing or malformed usage object", () => {
    assert.equal(parseUsage(undefined), null);
    assert.equal(parseUsage({ prompt_tokens: "10" }), null);
  });

  it("diffs two snapshots and propagates unknown cost", () => {
    const before = { calls: 3, promptTokens: 100, completionTokens: 20, costUsd: 0.01 };
    const after = { calls: 5, promptTokens: 400, completionTokens: 60, costUsd: 0.04 };
    assert.deepEqual(diffUsage(before, after), {
      calls: 2,
      promptTokens: 300,
      completionTokens: 40,
      costUsd: 0.03,
    });
    assert.equal(diffUsage(before, { ...after, costUsd: null }).costUsd, null);
  });
});
