/**
 * Encode every coded food in the FoodEx2 reference set and score the full code.
 *
 *   npm run reference-eval [-- --concurrency 8] [--source nevo-online-2025] [--only nevo-online-2025/819,...]
 *
 * Each food is scored against the set's code (the proposed code, else the
 * published one) on the base term and on the full code, facets included, and
 * against the source's own code where it published one.
 * Needs a configured model (see README Setup). A complete run over the whole
 * set writes eval/results/reference-set.json.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Catalogue } from "../src/catalogue.js";
import { evaluateReferenceFood, type CodeComparison, type ReferenceCaseResult } from "../src/eval/reference.js";
import { loadReferenceSet, REFERENCE_SET_DIR, type ReferenceFood } from "../src/eval/reference-set.js";
import { loadEnv } from "../src/env.js";
import { defaultModel } from "../src/llm.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_PATH = join(ROOT, "eval", "results", "reference-set.json");
const RULE = "-".repeat(100);

function gitDescribe(cwd: string): string | null {
  try {
    return execSync("git describe --tags --always --dirty", { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]): { concurrency: number; source?: string; only?: Set<string> } {
  const out: { concurrency: number; source?: string; only?: Set<string> } = { concurrency: 8 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--concurrency") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error("--concurrency needs a whole number of at least 1");
      out.concurrency = n;
    } else if (arg === "--source" && value) out.source = value;
    else if (arg === "--only" && value) out.only = new Set(value.split(",").map((s) => s.trim()));
    else throw new Error(`unexpected argument: ${arg}`);
    i++;
  }
  return out;
}

function select(foods: ReferenceFood[], args: ReturnType<typeof parseArgs>): ReferenceFood[] {
  let picked = foods;
  if (args.source) picked = picked.filter((f) => f.sourceId === args.source);
  if (args.only) {
    const unknown = [...args.only].filter((id) => !foods.some((f) => f.id === id));
    if (unknown.length > 0) throw new Error(`--only: unknown ids ${unknown.join(", ")}`);
    picked = picked.filter((f) => args.only!.has(f.id));
  }
  return picked;
}

function rate(results: ReferenceCaseResult[], pick: (r: ReferenceCaseResult) => CodeComparison | null): string {
  const scored = results.filter((r) => !r.infra);
  if (scored.length === 0) return "—";
  const base = scored.filter((r) => pick(r)?.base === true).length;
  const full = scored.filter((r) => pick(r)?.full === true).length;
  return `base ${base}/${scored.length}, full ${full}/${scored.length}`;
}

function groupBy<K>(results: ReferenceCaseResult[], key: (r: ReferenceCaseResult) => K): Map<K, ReferenceCaseResult[]> {
  const out = new Map<K, ReferenceCaseResult[]>();
  for (const r of results) out.set(key(r), [...(out.get(key(r)) ?? []), r]);
  return out;
}

function printMisses(results: ReferenceCaseResult[]): void {
  for (const r of results) {
    if (r.vsCode?.full === true) continue;
    const mark = r.infra ? "INFRA" : r.vsCode === null ? "NO CODE" : r.vsCode.base ? "FACETS" : "BASE";
    console.log(`${mark.padEnd(8)} ${r.food.id}  ${r.food.description} (${r.food.country}, ${r.food.status})`);
    console.log(`         expected ${r.food.code}`);
    console.log(`         got      ${r.code ?? r.reason ?? r.status}${r.baseName ? ` (${r.baseName})` : ""}`);
    if (r.vsCode && r.vsCode.base) {
      if (r.vsCode.missing.length > 0) console.log(`         missing  ${r.vsCode.missing.join(", ")}`);
      if (r.vsCode.extra.length > 0) console.log(`         extra    ${r.vsCode.extra.join(", ")}`);
    }
  }
}

function summarize(results: ReferenceCaseResult[]): void {
  console.log(RULE);
  console.log(`All: ${rate(results, (r) => r.vsCode)}`);
  for (const [status, rs] of [...groupBy(results, (r) => r.food.status)].sort()) {
    console.log(`  ${status}: ${rate(rs, (r) => r.vsCode)}`);
  }
  for (const [source, rs] of [...groupBy(results, (r) => r.food.sourceId)].sort()) {
    console.log(`  ${source}: ${rate(rs, (r) => r.vsCode)}`);
  }
  const published = results.filter((r) => r.food.publishedCode !== null);
  if (published.length > 0) {
    console.log(`Against the source's own code: ${rate(published, (r) => r.vsPublished)}`);
  }
  const infra = results.filter((r) => r.infra).length;
  if (infra > 0) console.log(`Infra (not scored): ${infra}`);
  const priced = results.filter((r) => r.usage.costUsd !== null);
  const total = priced.reduce((a, r) => a + (r.usage.costUsd as number), 0);
  const times = results.map((r) => r.elapsedMs).sort((a, b) => a - b);
  console.log(
    `Cost: $${total.toFixed(2)} over ${priced.length} encodes` +
      (priced.length > 0 ? ` (mean $${(total / priced.length).toFixed(3)})` : "") +
      `; median ${times[Math.floor((times.length - 1) / 2)] ?? 0} ms`
  );
}

function comparison(c: CodeComparison | null): object | null {
  return c === null ? null : { base: c.base, full: c.full, missing: c.missing, extra: c.extra };
}

function writeResults(results: ReferenceCaseResult[], model: string, mtxVersion: string): void {
  const scored = results.filter((r) => !r.infra);
  const payload = {
    _provenance: {
      generated_by: "scripts/reference-eval.ts",
      generated_at: new Date().toISOString(),
      model,
      mtx_version: mtxVersion,
      git_commit: gitDescribe(ROOT),
      reference_set: gitDescribe(REFERENCE_SET_DIR),
    },
    summary: {
      foods: results.length,
      scored: scored.length,
      base_pass: scored.filter((r) => r.vsCode?.base === true).length,
      full_pass: scored.filter((r) => r.vsCode?.full === true).length,
      total_cost_usd: Number(
        results.reduce((a, r) => a + (r.usage.costUsd ?? 0), 0).toFixed(4)
      ),
    },
    cases: results.map((r) => ({
      id: r.food.id,
      description: r.food.description,
      country: r.food.country,
      status: r.food.status,
      expected: r.food.code,
      published: r.food.publishedCode,
      code: r.code,
      base_name: r.baseName,
      free_text: r.freeText,
      vs_code: comparison(r.vsCode),
      vs_published: comparison(r.vsPublished),
      infra: r.infra,
      reason: r.reason ?? null,
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
  const args = parseArgs(process.argv.slice(2));
  const all = loadReferenceSet();
  const foods = select(all, args);
  if (foods.length === 0) throw new Error("no foods selected");
  const cat = Catalogue.load();
  const model = defaultModel();
  console.log(
    `Reference eval (${foods.length} foods, reference set ${gitDescribe(REFERENCE_SET_DIR) ?? "?"}, MTX v${cat.version}, model ${model})\n`
  );

  const slots: Array<ReferenceCaseResult | undefined> = new Array(foods.length);
  let stoppedForInfra = false;
  let next = 0;
  async function worker(): Promise<void> {
    while (!stoppedForInfra && next < foods.length) {
      const i = next++;
      const result = await evaluateReferenceFood(foods[i]!);
      slots[i] = result;
      const mark = result.infra ? "infra" : result.vsCode?.full ? "full" : result.vsCode?.base ? "base" : "miss";
      console.log(`${result.food.id} → ${mark}; ${result.elapsedMs} ms; $${(result.usage.costUsd ?? 0).toFixed(3)}`);
      if (result.infra) {
        console.log(`  → ${result.reason ?? "provider error"}; stopping early`);
        stoppedForInfra = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.concurrency, foods.length) }, worker));
  const results = slots.filter((r): r is ReferenceCaseResult => r !== undefined);

  console.log("");
  printMisses(results);
  summarize(results);
  if (stoppedForInfra) console.log("Stopped early after a provider infrastructure error.");
  else if (foods.length === all.length) writeResults(results, model, cat.version);
  if (stoppedForInfra) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
