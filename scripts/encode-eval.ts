/**
 * Run end-to-end encode eval on eval/encode-base-term.yaml.
 *
 *   npm run encode-eval
 *
 * Needs a configured model (see README Setup).
 * On a complete run (no early infra stop), writes eval/results/encode-base-term.json.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Catalogue } from "../src/catalogue.js";
import { codeList, list, loadCaseRecords, oneOf, requiredText, text } from "../src/eval/cases.js";
import {
  evaluateEncodeCase,
  formatExpected,
  type EncodeCaseResult,
  type EncodeEvalCase,
} from "../src/eval/encode.js";
import { loadEnv } from "../src/env.js";
import { defaultModel } from "../src/llm.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_PATH = join(ROOT, "eval", "results", "encode-base-term.json");

function loadCases(path: string): EncodeEvalCase[] {
  return loadCaseRecords(path).map((rec) => {
    const expected = codeList(rec, "expected");
    if (!expected || expected.length === 0) {
      throw new Error(`case ${String(rec.id)}: expected must list at least one code`);
    }
    return {
      id: requiredText(rec, "id"),
      input: requiredText(rec, "input"),
      expected,
      capability: requiredText(rec, "capability"),
      method: oneOf(rec, "method", ["lexical", "traversal"]),
      tags: list(rec, "tags"),
      note: text(rec, "note"),
      forbid_pick: codeList(rec, "forbid_pick"),
      forbid_facets: codeList(rec, "forbid_facets"),
      require_facets: codeList(rec, "require_facets"),
      require_f04_under: codeList(rec, "require_f04_under"),
      free_text_includes: text(rec, "free_text_includes"),
    };
  });
}

function isSoft(r: EncodeCaseResult): boolean {
  return r.tags.includes("soft");
}

const RULE = "-".repeat(100);

function usd(cost: number | null): string {
  return cost === null ? "—" : cost.toFixed(3);
}

function gitCommit(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function printTable(results: EncodeCaseResult[]): void {
  console.log(
    ["id", "pass", "ms", "calls", "usd", "pick", "method", "expected"]
      .map((h) => h.padEnd(h === "id" ? 28 : h === "ms" ? 8 : h === "calls" ? 6 : h === "usd" ? 7 : 10))
      .join("")
  );
  console.log(RULE);
  for (const r of results) {
    const soft = isSoft(r);
    const mark = r.infra
      ? "INFRA"
      : r.pass
        ? "PASS"
        : soft
          ? "SOFT"
          : "FAIL";
    console.log(
      [
        r.id.padEnd(28),
        mark.padEnd(10),
        String(r.elapsedMs).padEnd(8),
        String(r.usage.calls).padEnd(6),
        usd(r.usage.costUsd).padEnd(7),
        String(r.pick ?? r.status).padEnd(10),
        String(r.method ?? "—").padEnd(10),
        formatExpected(r.expectedSet).padEnd(10),
      ].join("")
    );
    if (r.infra) {
      console.log(`    input: ${r.input}`);
      if (r.reason) console.log(`    reason: ${r.reason}`);
      if (r.note) console.log(`    note: ${r.note}`);
    } else if (!r.pass) {
      console.log(`    input: ${r.input}`);
      console.log(`    capability: ${r.capability}`);
      if (r.pickName) console.log(`    pick:  ${r.pick} ${r.pickName}`);
      if (r.reason) console.log(`    reason: ${r.reason}`);
      if (!r.methodPass) console.log(`    method mismatch (got ${r.method ?? "—"})`);
      if (r.forbidHit) console.log(`    forbid_pick hit`);
      if (!r.facetsPass && r.facetDetail) console.log(`    facets: ${r.facetDetail}`);
      if (!r.freeTextPass) {
        console.log(`    freeText missing expected substring (got ${JSON.stringify(r.freeText)})`);
      }
      if (r.note) console.log(`    note: ${r.note}`);
    } else if (r.facets.length > 0 || r.freeText) {
      console.log(`    code: ${r.code ?? "—"}`);
      if (r.facets.length > 0) console.log(`    facets: ${r.facets.join(", ")}`);
      if (r.freeText) console.log(`    freeText: ${r.freeText}`);
    }
  }
}

function summarize(results: EncodeCaseResult[]): void {
  const infra = results.filter((r) => r.infra);
  const quality = results.filter((r) => !r.infra);
  const hard = quality.filter((r) => !isSoft(r));
  const soft = quality.filter(isSoft);
  const hardPass = hard.filter((r) => r.pass).length;
  const softPass = soft.filter((r) => r.pass).length;
  console.log(RULE);
  console.log(
    `Hard: ${hardPass}/${hard.length} pass` +
      (soft.length > 0 ? `; soft: ${softPass}/${soft.length} pass (non-blocking)` : "") +
      (infra.length > 0 ? `; infra: ${infra.length} (credits/rate/unavailable)` : "")
  );
  if (infra.length > 0) {
    const byReason = new Map<string, number>();
    for (const r of infra) {
      const key = r.reason ?? "unknown";
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
    console.log(
      `Infra breakdown: ${[...byReason.entries()].map(([k, n]) => `${k}=${n}`).join(", ")}`
    );
  }
  if (quality.length > 0) {
    const times = quality.map((r) => r.elapsedMs).sort((a, b) => a - b);
    const sum = times.reduce((a, b) => a + b, 0);
    const p50 = times[Math.floor((times.length - 1) * 0.5)] ?? 0;
    const p90 = times[Math.floor((times.length - 1) * 0.9)] ?? 0;
    const slowest = quality.reduce((a, b) => (b.elapsedMs > a.elapsedMs ? b : a));
    console.log(
      `Time: median ${p50} ms; p90 ${p90} ms; max ${times[times.length - 1]} ms` +
        ` (${slowest.id}); mean ${Math.round(sum / times.length)} ms`
    );
    const byMethod = new Map<string, number[]>();
    for (const r of quality) {
      const key = r.method ?? r.status;
      const list = byMethod.get(key) ?? [];
      list.push(r.elapsedMs);
      byMethod.set(key, list);
    }
    for (const [method, ms] of [...byMethod.entries()].sort()) {
      const mSum = ms.reduce((a, b) => a + b, 0);
      console.log(
        `  ${method}: n=${ms.length}; mean ${Math.round(mSum / ms.length)} ms;` +
          ` max ${Math.max(...ms)} ms`
      );
    }
    summarizeCost(quality);
  }
}

/** Model calls, tokens and dollars per encode — the number the hosted pricing rests on. */
function summarizeCost(quality: EncodeCaseResult[]): void {
  const calls = quality.reduce((a, r) => a + r.usage.calls, 0);
  const prompt = quality.reduce((a, r) => a + r.usage.promptTokens, 0);
  const completion = quality.reduce((a, r) => a + r.usage.completionTokens, 0);
  console.log(
    `Model: ${calls} calls; ${prompt} prompt + ${completion} completion tokens` +
      ` (mean ${Math.round(calls / quality.length)} calls, ${Math.round((prompt + completion) / quality.length)} tokens per encode)`
  );

  const priced = quality.filter((r) => r.usage.costUsd !== null);
  if (priced.length === 0) {
    console.log("Cost: endpoint reports no per-call cost (OpenRouter does)");
    return;
  }
  const costs = priced.map((r) => r.usage.costUsd as number).sort((a, b) => a - b);
  const total = costs.reduce((a, b) => a + b, 0);
  const p50 = costs[Math.floor((costs.length - 1) * 0.5)] ?? 0;
  const p90 = costs[Math.floor((costs.length - 1) * 0.9)] ?? 0;
  const dearest = priced.reduce((a, b) =>
    (b.usage.costUsd as number) > (a.usage.costUsd as number) ? b : a
  );
  console.log(
    `Cost: total $${total.toFixed(2)} over ${priced.length} encodes;` +
      ` median $${usd(p50)}; p90 $${usd(p90)}; max $${usd(costs[costs.length - 1] ?? 0)} (${dearest.id});` +
      ` mean $${usd(total / priced.length)}`
  );
  const byMethod = new Map<string, number[]>();
  for (const r of priced) {
    const key = r.method ?? r.status;
    const list = byMethod.get(key) ?? [];
    list.push(r.usage.costUsd as number);
    byMethod.set(key, list);
  }
  for (const [method, cs] of [...byMethod.entries()].sort()) {
    const sum = cs.reduce((a, b) => a + b, 0);
    console.log(
      `  ${method}: n=${cs.length}; mean $${usd(sum / cs.length)}; max $${usd(Math.max(...cs))};` +
        ` per 1,000 encodes $${((1000 * sum) / cs.length).toFixed(0)}`
    );
  }
}

function writeResultsArtifact(
  results: EncodeCaseResult[],
  model: string,
  mtxVersion: string
): void {
  const quality = results.filter((r) => !r.infra);
  const hard = quality.filter((r) => !isSoft(r));
  const soft = quality.filter(isSoft);
  const times = quality.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const priced = quality.filter((r) => r.usage.costUsd !== null);
  const totalCost = priced.reduce((a, r) => a + (r.usage.costUsd as number), 0);

  const payload = {
    _provenance: {
      generated_by: "scripts/encode-eval.ts",
      generated_at: new Date().toISOString(),
      model,
      mtx_version: mtxVersion,
      git_commit: gitCommit(),
    },
    summary: {
      hard_pass: hard.filter((r) => r.pass).length,
      hard_total: hard.length,
      soft_pass: soft.filter((r) => r.pass).length,
      soft_total: soft.length,
      total_cost_usd: priced.length > 0 ? Number(totalCost.toFixed(4)) : null,
      median_ms: times[Math.floor((times.length - 1) * 0.5)] ?? null,
    },
    cases: results.map((r) => ({
      id: r.id,
      capability: r.capability,
      input: r.input,
      expected: r.expectedSet,
      pick: r.pick,
      pick_name: r.pickName,
      code: r.code,
      facets: r.facets,
      free_text: r.freeText,
      pass: r.pass,
      soft: isSoft(r),
      ms: r.elapsedMs,
      calls: r.usage.calls,
      cost_usd: r.usage.costUsd,
    })),
  };

  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${RESULTS_PATH}`);
}

async function main(): Promise<void> {
  loadEnv();
  const path = join(ROOT, "eval", "encode-base-term.yaml");
  const cases = loadCases(path);
  if (cases.length === 0) {
    throw new Error(`No cases loaded from ${path}`);
  }

  const cat = Catalogue.load();
  const model = defaultModel();
  console.log(`Encode eval (${cases.length} cases, MTX v${cat.version}, model ${model})\n`);

  const results: EncodeCaseResult[] = [];
  let stoppedForInfra = false;
  for (const c of cases) {
    console.log(`${c.id}…`);
    const result = await evaluateEncodeCase(c);
    results.push(result);
    console.log(`  → ${result.elapsedMs} ms; ${result.usage.calls} calls; $${usd(result.usage.costUsd)}`);
    if (result.infra) {
      console.log(`  → ${result.reason ?? "provider error"}; stopping eval early`);
      stoppedForInfra = true;
      break;
    }
  }

  console.log("");
  printTable(results);
  summarize(results);
  if (stoppedForInfra) {
    console.log("Stopped early after provider infrastructure error.");
  } else {
    writeResultsArtifact(results, model, cat.version);
  }

  const qualityFail = results.some((r) => !r.infra && !r.pass && !isSoft(r));
  if (qualityFail || stoppedForInfra) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
