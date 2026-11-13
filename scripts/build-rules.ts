/**
 * Build src/rules/rules-data.json from the hand-maintained rule tables in
 * rules/ (cardinality.yaml, conflicts.yaml, efsa-processes.yaml) and EFSA's
 * forbidden-process data (vendor/efsa-business-rules/BR_Data.csv).
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

interface NewFoodEntry {
  code: string;
  table: number;
  process: string;
  applied_to: string;
  leads_to: string;
  also_groups?: string[];
  efsa_code?: string;
  note?: string;
}

interface ProcessTables {
  mtx_release: string;
  new_food: NewFoodEntry[];
  facet_only: Array<{ codes: string[]; descriptors: string; exceptions?: string }>;
  priority: Array<{ group: string; processes: string[] }>;
}

const CODE = /^A[0-9A-Z]{4}$/;
const tables = load<ProcessTables>("efsa-processes.yaml");
if (tables.mtx_release !== cardinality.mtx_release) {
  throw new Error(`efsa-processes.yaml: mtx_release ${tables.mtx_release} differs from cardinality.yaml`);
}

/** Process -> validator groups that list it. */
const validatorGroups: Record<string, string[]> = {};
for (const [group, processes] of Object.entries(forbiddenProcesses)) {
  for (const process of processes) (validatorGroups[process] ??= []).push(group);
}

const seenNewFood = new Set<string>();
const newFood = tables.new_food.map((entry) => {
  const codes = [entry.code, ...(entry.also_groups ?? [])];
  if (codes.some((code) => !CODE.test(code))) throw new Error(`efsa-processes.yaml: bad code in ${entry.code}`);
  if (entry.table !== 4 && entry.table !== 5) throw new Error(`efsa-processes.yaml: ${entry.code} table ${entry.table}`);
  if (seenNewFood.has(entry.code)) throw new Error(`efsa-processes.yaml: ${entry.code} listed twice`);
  seenNewFood.add(entry.code);
  return {
    code: entry.code,
    table: entry.table,
    process: entry.process,
    appliedTo: entry.applied_to,
    leadsTo: entry.leads_to,
    validatorGroups: (validatorGroups[entry.code] ?? []).sort(),
    alsoGroups: entry.also_groups ?? [],
    efsaCode: entry.efsa_code ?? null,
    note: entry.note ?? null,
  };
});

const seenFacet = new Set<string>();
const facetOnly = tables.facet_only.map((row) => {
  for (const code of row.codes) {
    if (!CODE.test(code) || seenFacet.has(code)) throw new Error(`efsa-processes.yaml: Table 22 code ${code}`);
    seenFacet.add(code);
  }
  return { codes: row.codes, descriptors: row.descriptors, exceptions: row.exceptions ?? null };
});

const seenPriority = new Set<string>();
for (const row of tables.priority) {
  for (const code of row.processes) {
    if (!CODE.test(code) || seenPriority.has(code)) throw new Error(`efsa-processes.yaml: Table 6 code ${code}`);
    seenPriority.add(code);
  }
}

const out = {
  _provenance: {
    generated_by: "scripts/build-rules.ts",
    generated_at: new Date().toISOString(),
    sources: [
      "rules/cardinality.yaml",
      "rules/conflicts.yaml",
      "rules/efsa-processes.yaml",
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
  processTables: { newFood, facetOnly, priority: tables.priority },
};

const target = resolve(repo, "src/rules/rules-data.json");
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(
  `Wrote ${target}: ${Object.keys(facets).length} facets, ${conflicts.length} conflicts,` +
    ` ${newFood.length} new-food treatments, ${facetOnly.length} Table 22 rows, ${tables.priority.length} priorities`
);
