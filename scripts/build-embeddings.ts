/**
 * Embed catalogue terms and write compact vector indices.
 *
 *   data/embeddings-base.json/.f32   — expo food terms (base-term recall tips)
 *   data/embeddings-facets.json/.f32 — Facets (A0B8V) descendants (residual tips)
 *
 * Passage: name + aliases; when the term has children in the index hierarchy,
 * also list them under a bolded name line. No scope notes in the vector.
 *
 *   npm run build:embeddings
 *   npm run build:embeddings -- --index facets
 *   npm run build:embeddings -- --index all --model e5-small
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  Catalogue,
  DEFAULT_HIERARCHY,
  isInExposureTree,
  type CatalogueTerm,
} from "../src/catalogue.js";
import {
  DEFAULT_EMBEDDING_MODEL_ID,
  EMBEDDING_MODELS,
  embedPassagesWith,
} from "../src/search/embeddings.js";

const { values: args } = parseArgs({
  options: {
    model: { type: "string", default: DEFAULT_EMBEDDING_MODEL_ID },
    index: { type: "string", default: "base" },
  },
});

const modelId = args.model as string;
const lookedUp = EMBEDDING_MODELS[modelId];
if (lookedUp === undefined) {
  console.error(
    `Unknown model '${modelId}'. Known: ${Object.keys(EMBEDDING_MODELS).join(", ")}`
  );
  process.exit(1);
}
const MODEL = lookedUp;

const indexArg = (args.index as string).trim().toLowerCase();
const INDEXES =
  indexArg === "all"
    ? (["base", "facets"] as const)
    : indexArg === "base" || indexArg === "facets"
      ? ([indexArg] as const)
      : null;
if (INDEXES === null) {
  console.error(`Unknown --index '${args.index}'. Use: base | facets | all`);
  process.exit(1);
}
const activeIndexes: readonly ("base" | "facets")[] = INDEXES;

const FILE_SUFFIX = MODEL.id === DEFAULT_EMBEDDING_MODEL_ID ? "" : `.${MODEL.id}`;
const REPO = join(import.meta.dirname, "..");
const BATCH = 64;

/** MTX Facets root — attribute dimensions (not Source / Ingredient / F27). */
const FACETS_ROOT = "A0B8V";
/** Generic-term under Facets — keep out of residual tip index. */
const FACETS_GENERIC_TERM = "A0B9F";
const MTX_HIERARCHY = "MTX";

const cat = Catalogue.load();

function passageText(code: string, term: CatalogueTerm, hierarchy: string): string {
  const preferred = term.name ?? code;
  const extra = cat.altNames(code);
  const childNames = cat
    .children(code, hierarchy)
    .map((child) => cat.term(child)?.name)
    .filter((n): n is string => Boolean(n && n.trim() !== ""));

  if (childNames.length === 0) {
    return [preferred, ...extra].filter(Boolean).join("; ");
  }

  const aliasSuffix = extra.length > 0 ? `; ${extra.join("; ")}` : "";
  return `**${preferred}**${aliasSuffix}\n(${childNames.join(", ")})`;
}

/** Expo food terms only — includes H/M/P parents; excludes deprecated / nameless. */
function selectExpoFoodTerm(term: CatalogueTerm): boolean {
  if (term.name === null || term.name.trim() === "") return false;
  if (term.status === "DEPRECATED") return false;
  return isInExposureTree(term);
}

function collectMtxDescendants(root: string): Set<string> {
  const out = new Set<string>();
  const queue = [...cat.children(root, MTX_HIERARCHY)];
  while (queue.length > 0) {
    const code = queue.shift()!;
    if (out.has(code)) continue;
    out.add(code);
    for (const child of cat.children(code, MTX_HIERARCHY)) {
      queue.push(child);
    }
  }
  return out;
}

/** Facets-tree terms under A0B8V, excluding Generic-term and its subtree. */
function selectFacetTerm(code: string, term: CatalogueTerm, underFacets: Set<string>): boolean {
  if (!underFacets.has(code)) return false;
  if (code === FACETS_GENERIC_TERM) return false;
  if (term.name === null || term.name.trim() === "") return false;
  if (term.status === "DEPRECATED") return false;
  // Drop Generic-term descendants (F26 path).
  let current: string | null = code;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    if (current === FACETS_GENERIC_TERM) return false;
    seen.add(current);
    current = cat.parent(current, MTX_HIERARCHY);
  }
  return true;
}

async function writeIndex(
  name: "base" | "facets",
  codes: string[],
  texts: string[],
  metaExtra: Record<string, string>
): Promise<void> {
  console.log(`Embedding ${codes.length} ${name} terms with ${MODEL.hfModel}...`);
  const buffer = new Float32Array(codes.length * MODEL.dim);
  const started = Date.now();
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const vectors = await embedPassagesWith(MODEL, batch);
    for (let j = 0; j < vectors.length; j++) {
      buffer.set(vectors[j] as Float32Array, (i + j) * MODEL.dim);
    }
    if (i % (BATCH * 10) === 0 || i + BATCH >= texts.length) {
      const done = Math.min(i + BATCH, texts.length);
      const rate = done / ((Date.now() - started) / 1000);
      console.log(`  ${done}/${texts.length} (${rate.toFixed(0)}/s)`);
    }
  }

  const metaPath = join(REPO, "data", `embeddings-${name}${FILE_SUFFIX}.json`);
  const dataPath = join(REPO, "data", `embeddings-${name}${FILE_SUFFIX}.f32`);
  writeFileSync(
    metaPath,
    JSON.stringify({
      model: MODEL.hfModel,
      modelId: MODEL.id,
      dim: MODEL.dim,
      ...metaExtra,
      codes,
    })
  );
  writeFileSync(dataPath, Buffer.from(buffer.buffer));
  console.log(
    `Wrote ${codes.length} vectors (dim ${MODEL.dim}) to ${metaPath} ` +
      `in ${((Date.now() - started) / 1000).toFixed(0)}s`
  );
}

async function buildBase(): Promise<void> {
  const codes: string[] = [];
  const texts: string[] = [];
  for (const [code, term] of Object.entries(cat.data.terms)) {
    if (!selectExpoFoodTerm(term)) continue;
    codes.push(code);
    texts.push(passageText(code, term, DEFAULT_HIERARCHY));
  }
  await writeIndex("base", codes, texts, {
    selection: "expo_food_all",
    passage: "name_aliases_or_bold_name_with_children",
  });
}

async function buildFacets(): Promise<void> {
  const underFacets = collectMtxDescendants(FACETS_ROOT);
  const codes: string[] = [];
  const texts: string[] = [];
  for (const [code, term] of Object.entries(cat.data.terms)) {
    if (!selectFacetTerm(code, term, underFacets)) continue;
    codes.push(code);
    texts.push(passageText(code, term, MTX_HIERARCHY));
  }
  await writeIndex("facets", codes, texts, {
    selection: "facets_a0b8v_minus_generic",
    passage: "name_aliases_or_bold_name_with_mtx_children",
  });
}

async function main(): Promise<void> {
  for (const name of activeIndexes) {
    if (name === "base") await buildBase();
    else await buildFacets();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
