/**
 * Compare legacy leftovers with attribute slots on the reference-set descriptions.
 *
 *   npx tsx scripts/facet-slots-compare.ts attributes
 *   npx tsx scripts/facet-slots-compare.ts facets
 *
 * Base terms are encoded once and reused. Attribute lists are the split only.
 * Facet codes run both residual paths on that frozen base.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCountry } from "../src/country.js";
import { encodeBaseTerm } from "../src/encode/base-term.js";
import {
  assignResiduals,
  listAttributeSlots,
  listLegacyInputProperties,
} from "../src/encode/residuals.js";
import { loadEnv } from "../src/env.js";
import type { BaseTermRef, DescriptionKind, SelectFit } from "../src/encode/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = "/Users/jornmineur/Code/foodex2-reference-set/data";
const OUT = join(ROOT, "_private", "facet-slots");
const CONCURRENCY = 6;

interface Food {
  source: string;
  id: string;
  description: string;
  country: string | null;
}

interface FrozenBase {
  source: string;
  id: string;
  description: string;
  country: string | null;
  status: "ok" | "rejected";
  message?: string;
  base?: BaseTermRef;
  fit?: SelectFit | null;
  descriptionKind?: DescriptionKind | null;
}

function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || record.length > 0) records.push([...record, field]);
  return records;
}

function foods(): Food[] {
  const files = ["usda-fdc-foundation.csv", "nevo-online-2025.csv", "efsa-foodex2-guidance-2015.csv", "cofid-2021.csv"];
  const out: Food[] = [];
  for (const file of files) {
    const records = parseCsv(readFileSync(join(DATA, file), "utf8"));
    const [header, ...body] = records;
    if (header === undefined) continue;
    const col = (name: string) => header.indexOf(name);
    for (const row of body) {
      const description = (row[col("description")] ?? "").trim();
      if (description === "") continue;
      const raw = (row[col("country")] ?? "").trim();
      const resolved = raw === "" ? null : resolveCountry(raw);
      out.push({
        source: file.replace(/\.csv$/, ""),
        id: row[col("source_food_id")] ?? "",
        description,
        country: resolved !== null && resolved.ok ? resolved.name : null,
      });
    }
  }
  return out;
}

function countryCode(name: string | null): string | undefined {
  if (name === null) return undefined;
  const table: Record<string, string> = {
    "United States": "US",
    "United Kingdom": "GB",
    Netherlands: "NL",
  };
  return table[name];
}

async function pool<T>(jobs: (() => Promise<T>)[], size: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await (jobs[i] as () => Promise<T>)();
      }
    })
  );
  return out;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

async function freezeBases(rows: Food[]): Promise<FrozenBase[]> {
  const path = join(OUT, "bases.json");
  const cached = readJson<FrozenBase[]>(path);
  const byKey = new Map((cached ?? []).map((b) => [`${b.source}:${b.id}`, b]));
  const missing = rows.filter((r) => !byKey.has(`${r.source}:${r.id}`));
  console.log(`Base terms: ${rows.length - missing.length} cached, ${missing.length} to encode`);
  const jobs = missing.map((row) => async (): Promise<void> => {
    try {
      const result = await encodeBaseTerm(row.description, {
        baseOnly: true,
        ...(countryCode(row.country) !== undefined ? { country: countryCode(row.country) } : {}),
      });
      const frozen: FrozenBase =
        result.status === "ok"
          ? {
              source: row.source,
              id: row.id,
              description: row.description,
              country: row.country,
              status: "ok",
              base: result.baseTerm,
              fit: result.fit ?? null,
              descriptionKind: result.descriptionKind ?? null,
            }
          : {
              source: row.source,
              id: row.id,
              description: row.description,
              country: row.country,
              status: "rejected",
              message: result.message,
            };
      byKey.set(`${row.source}:${row.id}`, frozen);
      writeFileSync(path, JSON.stringify([...byKey.values()], null, 2) + "\n");
      console.log(`  base ${row.source} ${row.id}: ${frozen.status === "ok" ? frozen.base?.code : frozen.message}`);
    } catch (err) {
      console.log(`  base ${row.source} ${row.id}: error ${String(err)}`);
    }
  });
  await pool(jobs, CONCURRENCY);
  return rows.map((r) => byKey.get(`${r.source}:${r.id}`)).filter((b): b is FrozenBase => b !== undefined);
}

async function compareAttributes(bases: FrozenBase[]): Promise<void> {
  const path = join(OUT, "attributes.json");
  type Row = {
    source: string;
    id: string;
    description: string;
    base: string | null;
    legacy: string[];
    slots: string[];
    omitted: { phrase: string; reason: string | null }[];
  };
  const cached = readJson<Row[]>(path) ?? [];
  const done = new Set(cached.map((r) => `${r.source}:${r.id}`));
  const rows = [...cached];
  const pending = bases.filter((b) => b.status === "ok" && b.base !== undefined && !done.has(`${b.source}:${b.id}`));
  console.log(`Attributes: ${done.size} cached, ${pending.length} to list`);
  const jobs = pending.map((base) => async (): Promise<void> => {
    const term = base.base as BaseTermRef;
    const opts = { country: base.country };
    const [legacy, slots] = await Promise.all([
      listLegacyInputProperties(base.description, term, opts),
      listAttributeSlots(base.description, term, opts),
    ]);
    rows.push({
      source: base.source,
      id: base.id,
      description: base.description,
      base: `${term.code} ${term.name}`,
      legacy: legacy.properties,
      slots: slots.attributes,
      omitted: slots.omitted,
    });
    writeFileSync(path, JSON.stringify(rows, null, 2) + "\n");
    console.log(`  slots ${base.source} ${base.id}: ${slots.attributes.join(" | ") || "(none)"}`);
  });
  await pool(jobs, CONCURRENCY);
}

async function compareFacets(bases: FrozenBase[]): Promise<void> {
  const path = join(OUT, "facets.json");
  type Row = {
    source: string;
    id: string;
    description: string;
    base: string;
    legacy: string | null;
    slots: string | null;
    legacyFacets: string[];
    slotFacets: string[];
  };
  const cached = readJson<Row[]>(path) ?? [];
  const done = new Set(cached.map((r) => `${r.source}:${r.id}`));
  const rows = [...cached];
  const pending = bases.filter((b) => b.status === "ok" && b.base !== undefined && !done.has(`${b.source}:${b.id}`));
  console.log(`Facets: ${done.size} cached, ${pending.length} to assign`);
  const jobs = pending.map((base) => async (): Promise<void> => {
    const term = base.base as BaseTermRef;
    const opts = {
      country: base.country,
      fit: base.fit ?? null,
      descriptionKind: base.descriptionKind ?? null,
      food: base.description,
    };
    const [legacy, slots] = await Promise.all([
      assignResiduals(base.description, term, { ...opts, facetSlots: false }),
      assignResiduals(base.description, term, { ...opts, facetSlots: true }),
    ]);
    const row: Row = {
      source: base.source,
      id: base.id,
      description: base.description,
      base: `${term.code} ${term.name}`,
      legacy: legacy.status === "ok" ? legacy.code : null,
      slots: slots.status === "ok" ? slots.code : null,
      legacyFacets: legacy.status === "ok" ? legacy.facets.map((f) => `${f.header}.${f.code} ${f.name}`) : [],
      slotFacets: slots.status === "ok" ? slots.facets.map((f) => `${f.header}.${f.code} ${f.name}`) : [],
    };
    rows.push(row);
    writeFileSync(path, JSON.stringify(rows, null, 2) + "\n");
    console.log(`  facets ${base.source} ${base.id}: ${row.slots}`);
  });
  await pool(jobs, CONCURRENCY);
}

async function main(): Promise<void> {
  loadEnv();
  mkdirSync(OUT, { recursive: true });
  const phase = process.argv[2] ?? "attributes";
  const bases = await freezeBases(foods());
  if (phase === "attributes" || phase === "all") await compareAttributes(bases);
  if (phase === "facets" || phase === "all") await compareFacets(bases);
  console.log(`Done ${phase}; output in ${OUT}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
