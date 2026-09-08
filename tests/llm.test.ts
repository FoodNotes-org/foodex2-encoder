/**
 * Deterministic LLM client helpers (no network).
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isProviderInfraReason, LlmError } from "../src/llm.js";

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
