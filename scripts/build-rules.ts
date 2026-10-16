/**
 * Build src/rules/rules-data.json from the hand-maintained rule tables in
 * rules/ (cardinality.yaml, conflicts.yaml) and EFSA's forbidden-process data
 * (vendor/efsa-business-rules/BR_Data.csv).
 *
 * Usage: npm run build:rules
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECOND = new Set(["error", "warning", "allowed"]);

interface FacetEntry {
  label: string;
  flag: string;
  guidance_2015: string | null;
  description: string | null;
  second: string;
  except?: string[];
  per_group?: boolean;
  conflict?: string;
}

interface ConflictEntry {
  id: string;
  facets: string[];
  topic: string;
  sources: Array<{ source: string; says: string }>;
  verdict: string;
  why: string;
  ours?: boolean;
}

function load<T>(name: string): T {
  return parse(readFileSync(resolve(repo, "rules", name), "utf8")) as T;
}

const cardinality = load<{ mtx_release: string; facets: Record<string, FacetEntry> }>(
  "cardinality.yaml"
);
const { conflicts } = load<{ conflicts: ConflictEntry[] }>("conflicts.yaml");
const conflictIds = new Set(conflicts.map((c) => c.id));

const facets: Record<string, unknown> = {};
for (const [code, entry] of Object.entries(cardinality.facets)) {
  if (!/^F\d\d$/.test(code)) throw new Error(`cardinality.yaml: bad facet code ${code}`);
  if (!SECOND.has(entry.second)) throw new Error(`cardinality.yaml: ${code}.second is ${entry.second}`);
  if (entry.conflict !== undefined && !conflictIds.has(entry.conflict)) {
    throw new Error(`cardinality.yaml: ${code} names unknown conflict ${entry.conflict}`);
  }
  facets[code] = {
    label: entry.label,
    flag: entry.flag,
    description: entry.description,
    second: entry.second,
    except: entry.except ?? [],
    perGroup: entry.per_group === true,
    conflict: entry.conflict ?? null,
  };
}

/** Food group -> processes that would recreate an existing derivative (BR16, BR19). */
const forbiddenProcesses: Record<string, string[]> = {};
const [header, ...rows] = readFileSync(resolve(repo, "vendor/efsa-business-rules/BR_Data.csv"), "utf8")
  .trim()
  .split(/\r?\n/);
if (!header?.startsWith("ROOT_GROUP_CODE;ROOT_GROUP_LABEL;FORBIDDEN_PROCS;")) {
  throw new Error(`BR_Data.csv: unexpected header ${header}`);
}
for (const row of rows) {
  const [group, , process] = row.split(";");
  if (!group || !process) throw new Error(`BR_Data.csv: bad row ${row}`);
  (forbiddenProcesses[group] ??= []).push(process);
}

const out = {
  _provenance: {
    generated_by: "scripts/build-rules.ts",
    generated_at: new Date().toISOString(),
    sources: [
      "rules/cardinality.yaml",
      "rules/conflicts.yaml",
      "vendor/efsa-business-rules/BR_Data.csv (EFSA, EUPL 1.2)",
    ],
  },
  mtxRelease: cardinality.mtx_release,
  facets,
  conflicts: Object.fromEntries(
    conflicts.map(({ id, topic, sources, verdict, why, ours }) => [
      id,
      { topic, sources, verdict, why, ours: ours === true },
    ])
  ),
  forbiddenProcesses,
};

const target = resolve(repo, "src/rules/rules-data.json");
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`Wrote ${target}: ${Object.keys(facets).length} facets, ${conflicts.length} conflicts`);
