/**
 * Eval case files: a YAML document with a top-level `cases` list. Field
 * readers validate one record at a time and name the case in every error.
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type CaseRecord = Record<string, unknown>;

export function loadCaseRecords(path: string): CaseRecord[] {
  const doc: unknown = parse(readFileSync(path, "utf8"));
  const cases = (doc as { cases?: unknown } | null)?.cases;
  if (!Array.isArray(cases)) throw new Error(`${path}: expected a top-level "cases" list`);
  return cases.map((entry, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${path}: case ${i + 1} is not a mapping`);
    }
    return entry as CaseRecord;
  });
}

function fail(rec: CaseRecord, key: string, expected: string): never {
  const id = typeof rec.id === "string" ? rec.id : "?";
  throw new Error(`case ${id}: ${key} must be ${expected}, got ${JSON.stringify(rec[key])}`);
}

export function text(rec: CaseRecord, key: string): string | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fail(rec, key, "text");
}

export function requiredText(rec: CaseRecord, key: string): string {
  return text(rec, key) ?? fail(rec, key, "present");
}

export function oneOf<T extends string>(
  rec: CaseRecord,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const v = text(rec, key);
  if (v === undefined) return undefined;
  return allowed.includes(v as T) ? (v as T) : fail(rec, key, `one of ${allowed.join(" | ")}`);
}

export function bool(rec: CaseRecord, key: string): boolean | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  return typeof v === "boolean" ? v : fail(rec, key, "true or false");
}

export function int(rec: CaseRecord, key: string): number | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  return typeof v === "number" && Number.isInteger(v) ? v : fail(rec, key, "an integer");
}

/** Comma-separated text (or a YAML list) → trimmed, non-empty items. */
export function list(rec: CaseRecord, key: string): string[] | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : fail(rec, key, "a list");
  return items
    .map((item) => (typeof item === "string" ? item.trim() : fail(rec, key, "a list of text")))
    .filter((item) => item !== "");
}

/** Like list, upper-cased for catalogue and facet codes. */
export function codeList(rec: CaseRecord, key: string): string[] | undefined {
  return list(rec, key)?.map((code) => code.toUpperCase());
}
