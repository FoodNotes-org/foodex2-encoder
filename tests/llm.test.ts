/**
 * Deterministic LLM client helpers (no network).
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chatJson,
  classifyHttpError,
  diffUsage,
  isProviderInfraReason,
  LlmError,
  parseUsage,
} from "../src/llm.js";

async function withReplies<T>(replies: string[], fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; calls: number }> {
  const realFetch = globalThis.fetch;
  const savedModel = process.env.FOODEX2_MODEL;
  const savedBase = process.env.FOODEX2_LLM_BASE_URL;
  process.env.FOODEX2_MODEL = "test-model";
  process.env.FOODEX2_LLM_BASE_URL = "http://llm.test";
  let calls = 0;
  globalThis.fetch = (async () => {
    const content = replies[Math.min(calls, replies.length - 1)];
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    return { result: await fn(), calls };
  } catch (error) {
    return { error, calls };
  } finally {
    globalThis.fetch = realFetch;
    if (savedModel === undefined) delete process.env.FOODEX2_MODEL;
    else process.env.FOODEX2_MODEL = savedModel;
    if (savedBase === undefined) delete process.env.FOODEX2_LLM_BASE_URL;
    else process.env.FOODEX2_LLM_BASE_URL = savedBase;
  }
}

describe("invalid model replies", () => {
  it("asks again once after an empty or non-JSON reply", async () => {
    const run = await withReplies(["not json", '{"ok":true}'], () => chatJson({ system: "s", user: "u" }));
    assert.equal(run.calls, 2);
    assert.deepEqual(run.result?.content, { ok: true });
  });

  it("gives up after the second invalid reply", async () => {
    const run = await withReplies(["", "still not json"], () => chatJson({ system: "s", user: "u" }));
    assert.equal(run.calls, 2);
    assert.ok(run.error instanceof LlmError);
    assert.equal((run.error as LlmError).kind, "model_response_invalid");
  });
});

describe("LlmError / infra reasons", () => {
  it("flags credits, rate limit, unavailable as infra", () => {
    assert.equal(isProviderInfraReason("provider_credits"), true);
    assert.equal(isProviderInfraReason("provider_rate_limit"), true);
    assert.equal(isProviderInfraReason("provider_unavailable"), true);
    assert.equal(isProviderInfraReason("model_response_invalid"), false);
    assert.equal(isProviderInfraReason("traversal_error"), false);
  });

  it("reads a spending limit on the key as credits", () => {
    const body = '{"error":{"message":"Key limit exceeded (monthly limit).","code":403}}';
    assert.equal(classifyHttpError(403, body), "provider_credits");
    assert.equal(classifyHttpError(403, '{"error":{"message":"Forbidden"}}'), "provider_error");
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
