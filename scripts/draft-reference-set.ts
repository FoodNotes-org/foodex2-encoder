/**
 * Draft FoodEx2 codes for uncoded rows of a foodex2-reference-set data file.
 *
 *   npm run draft-reference -- <data.csv> [--limit 5] [--runs 2] [--concurrency 4]
 *
 * Takes the first <limit> rows with no code, status or notes, encodes each
 * description <runs> times, and writes the first run's code and free text back
 * as `draft`. Free text that only repeats the description is left out.
 * When runs disagree, every distinct code goes into `notes` for the reviewer.
 * The full encoder output per run lands in _private/reference-set-drafts/.
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Catalogue } from "../src/catalogue.js";
import { encodeBaseTerm } from "../src/encode/base-term.js";
import { formatFreeText } from "../src/encode/free-text.js";
import { toUserEncodeResult } from "../src/encode/user-result.js";
import type { EncodeUserResult } from "../src/encode/types.js";
import { loadEnv } from "../src/env.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRAFTS_DIR = join(ROOT, "_private", "reference-set-drafts");

type Row = Record<string, string>;

function parseCsv(text: string): { header: string[]; rows: Row[] } {
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

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function writeCsv(path: string, header: string[], rows: Row[]): void {
  const lines = [header, ...rows.map((r) => header.map((h) => r[h] ?? ""))];
  writeFileSync(path, lines.map((l) => l.map(csvField).join(",")).join("\n") + "\n", "utf8");
}

function encoderId(): string {
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  try {
    const commit = execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain -- src", { cwd: ROOT, encoding: "utf8" }).trim() !== "";
    return `foodex2-encoder ${version} (${commit}${dirty ? "-dirty" : ""})`;
  } catch {
    return `foodex2-encoder ${version}`;
  }
}

function parseArgs(argv: string[]): { path: string; limit: number; runs: number; concurrency: number } {
  const opts = { limit: 5, runs: 2, concurrency: 4 };
  let path: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const key = arg.replace(/^--/, "") as keyof typeof opts;
    if (arg.startsWith("--") && key in opts) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error(`${arg} needs a positive whole number`);
      opts[key] = value;
    } else if (path === undefined) path = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (path === undefined) {
    console.error("Usage: npm run draft-reference -- <data.csv> [--limit 5] [--runs 2] [--concurrency 4]");
    process.exit(2);
  }
  return { path, ...opts };
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

async function main(): Promise<void> {
  loadEnv();
  const { path, limit, runs, concurrency } = parseArgs(process.argv.slice(2));
  const { header, rows } = parseCsv(readFileSync(path, "utf8"));
  const todo = rows.filter((r) => !r.foodex2_code && !r.status && !r.notes).slice(0, limit);
  if (todo.length === 0) {
    console.log("No uncoded rows left.");
    return;
  }

  const coder = encoderId();
  const release = Catalogue.load().version;
  const sourceDir = join(DRAFTS_DIR, basename(path, ".csv"));
  mkdirSync(sourceDir, { recursive: true });
  console.log(`Encoding ${todo.length} foods × ${runs} runs with ${coder}, MTX ${release}`);

  const jobs = todo.flatMap((row) =>
    Array.from({ length: runs }, () => async (): Promise<EncodeUserResult> => {
      try {
        return toUserEncodeResult(await encodeBaseTerm(row.description as string, {}));
      } catch (err) {
        return { status: "rejected", message: `error: ${String(err)}` };
      }
    })
  );
  const results = await pool(jobs, concurrency);

  todo.forEach((row, i) => {
    const own = results.slice(i * runs, (i + 1) * runs);
    writeFileSync(
      join(sourceDir, `${row.source_food_id}.json`),
      JSON.stringify({ description: row.description, coder, mtxRelease: release, runs: own }, null, 2) + "\n"
    );
    const codes = own.flatMap((r) => (r.status === "ok" ? [r.code] : []));
    const first = codes[0];
    if (first === undefined) {
      const reasons = own.map((r) => (r.status === "rejected" ? r.message : "")).filter(Boolean);
      row.notes = `encoder gave no code: ${[...new Set(reasons)].join(" | ")}`;
      console.log(`  ${row.description}: no code`);
      return;
    }
    const distinct = [...new Set(codes)];
    const firstOk = own.find((r) => r.status === "ok");
    const description = (row.description as string).trim().toLowerCase();
    const freeText = (firstOk?.status === "ok" ? firstOk.freeText : []).filter(
      (e) => e.value.trim().toLowerCase() !== description
    );
    Object.assign(row, {
      foodex2_code: first,
      free_text: formatFreeText(freeText) ?? "",
      mtx_release: release,
      coded_by: coder,
      code_source: "contributor",
      status: "draft",
      notes: distinct.length > 1 || codes.length < runs
        ? `encoder runs disagreed: ${own.map((r) => (r.status === "ok" ? r.code : "no code")).join(" | ")}`
        : "",
    });
    console.log(`  ${row.description}: ${first}${row.notes ? "  (runs disagreed)" : ""}`);
  });

  writeCsv(path, header, rows);
  console.log(`Updated ${path}; full outputs in ${sourceDir}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
