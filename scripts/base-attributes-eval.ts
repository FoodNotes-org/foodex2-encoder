/**
 * Run the base-term attribute eval on eval/base-attributes.yaml: base-only
 * encodes, several runs per case, scored on the treatment judgements and the
 * base picked.
 *
 *   npm run base-eval [-- --runs 3 --concurrency 12 --only id,id]
 *
 * Needs a configured model (see README Setup).
 * On a complete run of every case, writes eval/results/base-attributes.json.
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { Catalogue } from "../src/catalogue.js";
import { encodeBaseTerm } from "../src/encode/base-term.js";
import {
  caseCodes,
  checkRun,
  factsFromEncode,
  loadBaseAttributeCases,
  type BaseAttributeCase,
  type BaseAttributeCheck,
  type BaseAttributeFacts,
} from "../src/eval/base-attributes.js";
import { loadEnv } from "../src/env.js";
import { defaultModel, isProviderInfraReason, withUsageScope } from "../src/llm.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CASES_PATH = join(ROOT, "eval", "base-attributes.yaml");
const RULES_PATH = join(ROOT, "rules", "base-term.yaml");
const RESULTS_PATH = join(ROOT, "eval", "results", "base-attributes.json");
const RULE = "-".repeat(100);

interface RunResult extends BaseAttributeFacts, BaseAttributeCheck {
  run: number;
  ms: number;
  costUsd: number | null;
  infra: boolean;
}

function arg(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
}

function positiveInt(argv: string[], flag: string, fallback: number): number {
  const raw = arg(argv, flag);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a whole number of at least 1`);
  return n;
}

function gitState(): { commit: string | null; dirty: string[] } {
  try {
    const commit = execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain -- src", { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((line) => line !== "");
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: [] };
  }
}

/** Every code exists, every rule and family is in the rulebook. */
function validate(cat: Catalogue, cases: BaseAttributeCase[]): void {
  const book = parse(readFileSync(RULES_PATH, "utf8")) as {
    rules: Array<{ id: string }>;
    families: Array<{ id: string }>;
  };
  const rules = new Set(book.rules.map((r) => r.id));
  const families = new Set(book.families.map((f) => f.id));
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) problems.push(`${c.id}: duplicate id`);
    ids.add(c.id);
    for (const code of caseCodes(c)) {
      if (cat.term(code) === undefined) problems.push(`${c.id}: unknown code ${code}`);
    }
    for (const r of c.rules) if (!rules.has(r)) problems.push(`${c.id}: unknown rule ${r}`);
    for (const f of c.families) if (!families.has(f)) problems.push(`${c.id}: unknown family ${f}`);
  }
  if (problems.length > 0) throw new Error(`Fixture problems:\n  ${problems.join("\n  ")}`);
}

async function runOnce(cat: Catalogue, c: BaseAttributeCase, run: number): Promise<RunResult> {
  const started = performance.now();
  const { result, usage } = await withUsageScope(() =>
    encodeBaseTerm(c.input, { baseOnly: true, country: c.country })
  );
  const facts = factsFromEncode(result);
  return {
    run,
    ms: Math.round(performance.now() - started),
    costUsd: usage.costUsd,
    infra: facts.reason !== null && isProviderInfraReason(facts.reason),
    ...facts,
    ...checkRun(cat, c, facts),
  };
}

function tally(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([v, n]) => (n > 1 ? `${v}×${n}` : v))
    .join(" ");
}

function ratio(runs: RunResult[], key: "basePass" | "treatmentsPass"): string {
  const judged = runs.filter((r) => r[key] !== null);
  if (judged.length === 0) return "n/a";
  return `${judged.filter((r) => r[key] === true).length}/${judged.length}`;
}

function printCase(c: BaseAttributeCase, runs: RunResult[]): void {
  const mark = c.open ? "OPEN" : runs.every((r) => r.basePass) ? "PASS" : "FAIL";
  console.log(
    [
      c.id.padEnd(36),
      mark.padEnd(6),
      `base ${ratio(runs, "basePass")}`.padEnd(11),
      `treat ${ratio(runs, "treatmentsPass")}`.padEnd(12),
      `picks ${tally(runs.map((r) => r.pick ?? r.reason ?? r.status))}`,
    ].join("")
  );
  const quiet = !c.open && runs.every((r) => r.basePass && r.treatmentsPass !== false);
  if (quiet) return;
  console.log(`    input: ${c.input} (${c.country}); expected ${c.base.join("|")}`);
  const missing = tally(runs.flatMap((r) => r.newFoodMissing));
  const wrong = tally(runs.flatMap((r) => r.wronglyNewFood));
  const lost = tally(runs.flatMap((r) => r.formLost));
  if (missing) console.log(`    new food not found: ${missing}`);
  if (wrong) console.log(`    judged new food, should not be: ${wrong}`);
  if (lost) console.log(`    form words dropped: ${lost}`);
  console.log(`    nature: ${tally(runs.map((r) => r.nature.join("+") || "—"))}`);
  console.log(`    group: ${tally(runs.map((r) => r.processGroup ?? "—"))}`);
  const rewrites = runs.map((r) => r.compareAs).filter((s): s is string => s !== null && s !== c.input);
  if (rewrites.length > 0) console.log(`    compared as: ${tally(rewrites.map((s) => JSON.stringify(s)))}`);
  if (c.note) console.log(`    note: ${c.note}`);
}

interface Score {
  basePass: number;
  baseRuns: number;
  stableCases: number;
  cases: number;
  treatPass: number;
  treatRuns: number;
}

function score(entries: Array<[BaseAttributeCase, RunResult[]]>): Score {
  const scored = entries.filter(([c]) => !c.open);
  const runs = scored.flatMap(([, rs]) => rs);
  const treated = runs.filter((r) => r.treatmentsPass !== null);
  return {
    basePass: runs.filter((r) => r.basePass).length,
    baseRuns: runs.length,
    stableCases: scored.filter(([, rs]) => rs.every((r) => r.basePass)).length,
    cases: scored.length,
    treatPass: treated.filter((r) => r.treatmentsPass === true).length,
    treatRuns: treated.length,
  };
}

function formatScore(s: Score): string {
  return (
    `base ${s.basePass}/${s.baseRuns} runs, ${s.stableCases}/${s.cases} cases every run;` +
    ` treatments ${s.treatPass}/${s.treatRuns} runs`
  );
}

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const runs = positiveInt(argv, "--runs", 3);
  const concurrency = positiveInt(argv, "--concurrency", 12);
  const only = arg(argv, "--only")?.split(",").map((s) => s.trim());

  const cat = Catalogue.load();
  const all = loadBaseAttributeCases(CASES_PATH);
  validate(cat, all);
  const cases = only ? all.filter((c) => only.includes(c.id)) : all;
  if (cases.length === 0) throw new Error("No cases selected");
  const model = defaultModel();
  console.log(
    `Base attribute eval (${cases.length} cases × ${runs} runs, MTX v${cat.version}, model ${model})\n`
  );

  const jobs = cases.flatMap((c) => Array.from({ length: runs }, (_, run) => ({ c, run })));
  const results = new Map<string, RunResult[]>(cases.map((c) => [c.id, []]));
  let stoppedForInfra = false;
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (!stoppedForInfra && next < jobs.length) {
      const { c, run } = jobs[next++]!;
      const r = await runOnce(cat, c, run);
      results.get(c.id)!.push(r);
      done += 1;
      console.log(`[${done}/${jobs.length}] ${c.id}#${run + 1} → ${r.pick ?? r.reason} (${r.ms} ms)`);
      if (r.infra && !stoppedForInfra) {
        console.log(`  → ${r.reason}; stopping eval early`);
        stoppedForInfra = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  const entries = cases.map((c) => [c, results.get(c.id)!.sort((a, b) => a.run - b.run)] as [
    BaseAttributeCase,
    RunResult[],
  ]);
  console.log("");
  for (const [c, rs] of entries) printCase(c, rs);
  console.log(RULE);
  const overall = score(entries);
  console.log(`Overall: ${formatScore(overall)}`);
  const familyIds = [...new Set(cases.flatMap((c) => c.families))].sort();
  const byFamily: Record<string, Score> = {};
  for (const f of familyIds) {
    byFamily[f] = score(entries.filter(([c]) => c.families.includes(f)));
    console.log(`  ${f}: ${formatScore(byFamily[f]!)}`);
  }
  const priced = entries.flatMap(([, rs]) => rs).filter((r) => r.costUsd !== null);
  const cost = priced.reduce((a, r) => a + (r.costUsd as number), 0);
  if (priced.length > 0) console.log(`Cost: $${cost.toFixed(2)} over ${priced.length} encodes`);

  if (stoppedForInfra) {
    console.log("Stopped early after provider infrastructure error; no results written.");
    process.exitCode = 1;
    return;
  }
  if (only) {
    console.log("Subset run (--only); no results written.");
    return;
  }

  const git = gitState();
  const payload = {
    _provenance: {
      generated_by: "scripts/base-attributes-eval.ts",
      generated_at: new Date().toISOString(),
      model,
      mtx_version: cat.version,
      git_commit: git.commit,
      uncommitted_src: git.dirty,
      runs,
    },
    summary: { overall, by_family: byFamily, total_cost_usd: priced.length > 0 ? Number(cost.toFixed(4)) : null },
    cases: entries.map(([c, rs]) => ({
      id: c.id,
      input: c.input,
      country: c.country,
      families: c.families,
      open: c.open,
      expected_base: c.base,
      runs: rs.map((r) => ({
        pick: r.pick,
        pick_name: r.pickName,
        status: r.status,
        reason: r.reason,
        route: r.route,
        nature: r.nature,
        stated: r.stated,
        process_group: r.processGroup,
        compare_as: r.compareAs,
        base_pass: r.basePass,
        treatments_pass: r.treatmentsPass,
        new_food_missing: r.newFoodMissing,
        wrongly_new_food: r.wronglyNewFood,
        form_lost: r.formLost,
        facet_seen: r.facetSeen,
        ms: r.ms,
        cost_usd: r.costUsd,
      })),
    })),
  };
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${RESULTS_PATH}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
