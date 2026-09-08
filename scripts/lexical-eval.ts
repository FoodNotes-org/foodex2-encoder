/**
 * Run lexical recall@K and auto-accept precision on eval/lexical-base-term.yaml.
 *
 *   npm run lexical-eval
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Catalogue } from "../src/catalogue.js";
import {
  bool,
  codeList,
  int,
  list,
  loadCaseRecords,
  oneOf,
  requiredText,
  text,
} from "../src/eval/cases.js";
import {
  evaluateLexicalCase,
  type LexicalCaseResult,
  type LexicalEvalCase,
} from "../src/eval/lexical.js";

function loadCases(path: string): LexicalEvalCase[] {
  return loadCaseRecords(path).map((rec) => {
    const auto_accept = bool(rec, "auto_accept");
    if (auto_accept === undefined) {
      throw new Error(`case ${String(rec.id)}: auto_accept is required`);
    }
    return {
      id: requiredText(rec, "id"),
      input: requiredText(rec, "input"),
      expected: text(rec, "expected"),
      source: text(rec, "source"),
      tags: list(rec, "tags"),
      note: text(rec, "note"),
      expect: {
        recall_top: int(rec, "recall_top"),
        recall_expect: oneOf(rec, "recall_expect", ["hit", "miss"]),
        auto_accept,
        forbid_accept: codeList(rec, "forbid_accept"),
      },
    };
  });
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${Math.round((100 * n) / d)}% (${n}/${d})`;
}

function printTable(results: LexicalCaseResult[]): void {
  console.log(
    ["id", "pass", "recall", "accept", "rank", "expected"]
      .map((h) => h.padEnd(h === "id" ? 28 : 10))
      .join("")
  );
  console.log("-".repeat(88));
  for (const r of results) {
    const recall =
      r.recallPass === null ? "—" : r.recallPass ? `@${r.recallRank}` : "miss";
    const accept = r.autoAcceptCode ?? "—";
    console.log(
      [
        r.id.padEnd(28),
        (r.pass ? "PASS" : "FAIL").padEnd(10),
        String(recall).padEnd(10),
        accept.padEnd(10),
        String(r.recallRank ?? "—").padEnd(10),
        String(r.expected ?? "—").padEnd(10),
      ].join("")
    );
    if (!r.pass) {
      console.log(`    input: ${r.input}`);
      if (r.note) console.log(`    note: ${r.note}`);
    }
  }
}

function summarize(results: LexicalCaseResult[], cases: LexicalEvalCase[]): void {
  let recallScored = 0;
  let recallPassed = 0;
  let acceptPosScored = 0;
  let acceptPosPassed = 0;
  let acceptNegScored = 0;
  let acceptNegPassed = 0;

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const c = cases[i]!;
    if (r.recallPass !== null) {
      recallScored++;
      if (r.recallPass) recallPassed++;
    }
    if (c.expect.auto_accept) {
      acceptPosScored++;
      if (r.autoAcceptPass && r.autoAcceptCode === c.expected) acceptPosPassed++;
    } else {
      acceptNegScored++;
      if (r.autoAcceptPass) acceptNegPassed++;
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log("-".repeat(88));
  console.log(`Cases: ${passed}/${results.length} pass`);
  console.log(`Recall@${cases[0]?.expect.recall_top ?? 10}: ${pct(recallPassed, recallScored)}`);
  console.log(`Auto-accept recall (positives): ${pct(acceptPosPassed, acceptPosScored)}`);
  console.log(`Auto-accept precision (negatives): ${pct(acceptNegPassed, acceptNegScored)}`);
}

async function main(): Promise<void> {
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "eval",
    "lexical-base-term.yaml"
  );
  const cases = loadCases(path);
  if (cases.length === 0) {
    throw new Error(`No cases loaded from ${path}`);
  }

  const cat = Catalogue.load();
  console.log(`Lexical eval (${cases.length} cases, MTX v${cat.version})\n`);

  const results = cases.map((c) => evaluateLexicalCase(c));
  printTable(results);
  summarize(results, cases);

  if (results.some((r) => !r.pass)) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
