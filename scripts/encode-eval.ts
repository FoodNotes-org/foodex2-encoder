/**
 * Run end-to-end encode eval on eval/encode-base-term.yaml.
 *
 *   npm run encode-eval
 *
 * Needs a configured model (see README Setup).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Catalogue } from "../src/catalogue.js";
import { codeList, list, loadCaseRecords, oneOf, requiredText, text } from "../src/eval/cases.js";
import {
  evaluateEncodeCase,
  type EncodeCaseResult,
  type EncodeEvalCase,
} from "../src/eval/encode.js";
import { loadEnv } from "../src/env.js";

function loadCases(path: string): EncodeEvalCase[] {
  return loadCaseRecords(path).map((rec) => ({
    id: requiredText(rec, "id"),
    input: requiredText(rec, "input"),
    expected: requiredText(rec, "expected").toUpperCase(),
    method: oneOf(rec, "method", ["lexical", "traversal"]),
    tags: list(rec, "tags"),
    note: text(rec, "note"),
    forbid_pick: codeList(rec, "forbid_pick"),
    forbid_facets: codeList(rec, "forbid_facets"),
    require_facets: codeList(rec, "require_facets"),
    require_f04_under: codeList(rec, "require_f04_under"),
    free_text_includes: text(rec, "free_text_includes"),
  }));
}

function isSoft(r: EncodeCaseResult): boolean {
  return r.tags.includes("soft");
}

function printTable(results: EncodeCaseResult[]): void {
  console.log(
    ["id", "pass", "ms", "pick", "method", "expected"]
      .map((h) => h.padEnd(h === "id" ? 28 : h === "ms" ? 8 : 10))
      .join("")
  );
  console.log("-".repeat(86));
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
        String(r.pick ?? r.status).padEnd(10),
        String(r.method ?? "—").padEnd(10),
        r.expected.padEnd(10),
      ].join("")
    );
    if (r.infra) {
      console.log(`    input: ${r.input}`);
      if (r.reason) console.log(`    reason: ${r.reason}`);
      if (r.note) console.log(`    note: ${r.note}`);
    } else if (!r.pass) {
      console.log(`    input: ${r.input}`);
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
  console.log("-".repeat(86));
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
  }
}

async function main(): Promise<void> {
  loadEnv();
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "eval",
    "encode-base-term.yaml"
  );
  const cases = loadCases(path);
  if (cases.length === 0) {
    throw new Error(`No cases loaded from ${path}`);
  }

  const cat = Catalogue.load();
  console.log(`Encode eval (${cases.length} cases, MTX v${cat.version})\n`);

  const results: EncodeCaseResult[] = [];
  let stoppedForInfra = false;
  for (const c of cases) {
    console.log(`${c.id}…`);
    const result = await evaluateEncodeCase(c);
    results.push(result);
    console.log(`  → ${result.elapsedMs} ms`);
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
  }

  const qualityFail = results.some((r) => !r.infra && !r.pass && !isSoft(r));
  if (qualityFail || stoppedForInfra) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
