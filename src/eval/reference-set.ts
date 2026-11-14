/**
 * The FoodEx2 reference set (vendor/foodex2-reference-set, pinned to a tag):
 * food descriptions from published sources, each with the code the set gives
 * for it. One CSV per source edition under data/.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REFERENCE_SET_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "vendor",
  "foodex2-reference-set"
);

export const REFERENCE_STATUSES = ["draft", "reviewed", "confirmed"] as const;
export type ReferenceStatus = (typeof REFERENCE_STATUSES)[number];

export interface ReferenceFood {
  /** `<source id>/<source_food_id>`, unique across the set. */
  id: string;
  /** The data file's name without `.csv`. */
  sourceId: string;
  /** The source as it asks to be cited. */
  source: string;
  sourceFoodId: string;
  description: string;
  /** ISO 3166-1 code, or EU. */
  country: string;
  /** The source's own code, unchanged; null when it published none. */
  publishedCode: string | null;
  /** A contributor's code; null when the published code stands. */
  proposedCode: string | null;
  /** The row's code: the proposed code, else the published one. */
  code: string;
  freeText: string | null;
  mtxRelease: string;
  status: ReferenceStatus;
  notes: string | null;
}

const COLUMNS = [
  "source",
  "source_food_id",
  "description",
  "country",
  "published_code",
  "proposed_code",
  "free_text",
  "mtx_release",
  "status",
  "notes",
] as const;

export type CsvRow = Record<string, string>;

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): { header: string[]; rows: CsvRow[] } {
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
  const [header, ...body] = records;
  if (header === undefined) throw new Error("empty CSV");
  return { header, rows: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))) };
}

function orNull(value: string): string | null {
  const v = value.trim();
  return v === "" ? null : v;
}

/** Coded rows of every data file; rows without a status have no code yet and are left out. */
export function loadReferenceSet(dir: string = REFERENCE_SET_DIR): ReferenceFood[] {
  const dataDir = join(dir, "data");
  const files = readdirSync(dataDir).filter((f) => f.endsWith(".csv")).sort();
  if (files.length === 0) throw new Error(`${dataDir}: no data files; run git submodule update --init`);
  const foods: ReferenceFood[] = [];
  for (const file of files) {
    const { header, rows } = parseCsv(readFileSync(join(dataDir, file), "utf8"));
    const missing = COLUMNS.filter((c) => !header.includes(c));
    if (missing.length > 0) throw new Error(`${file}: missing columns ${missing.join(", ")}`);
    for (const row of rows) {
      const status = row.status?.trim() ?? "";
      if (status === "") continue;
      const sourceId = file.replace(/\.csv$/, "");
      const id = `${sourceId}/${row.source_food_id}`;
      if (!(REFERENCE_STATUSES as readonly string[]).includes(status)) {
        throw new Error(`${file}: ${id} has unknown status ${JSON.stringify(status)}`);
      }
      const publishedCode = orNull(row.published_code ?? "");
      const proposedCode = orNull(row.proposed_code ?? "");
      const code = proposedCode ?? publishedCode;
      if (code === null) throw new Error(`${file}: ${id} has status ${status} but no code`);
      foods.push({
        id,
        sourceId,
        source: (row.source as string).trim(),
        sourceFoodId: row.source_food_id as string,
        description: (row.description as string).trim(),
        // EFSA's guidance examples name no country; they are EU-wide.
        country: orNull(row.country ?? "") ?? "EU",
        publishedCode,
        proposedCode,
        code,
        freeText: orNull(row.free_text ?? ""),
        mtxRelease: (row.mtx_release as string).trim(),
        status: status as ReferenceStatus,
        notes: orNull(row.notes ?? ""),
      });
    }
  }
  const seen = new Set<string>();
  for (const f of foods) {
    if (seen.has(f.id)) throw new Error(`reference set: duplicate row ${f.id}`);
    seen.add(f.id);
  }
  return foods;
}
