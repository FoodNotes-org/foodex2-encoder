/**
 * CLI — catalogue inspection, lexical search, semantic search, encode.
 *
 *   npm run cli -- info
 *   npm run cli -- term A03BG
 *   npm run cli -- search "nectar orange"
 *   npm run cli -- semantic "scrambled eggs"
 *   npm run cli -- encode "orange juice"
 *   npm run cli -- traverse "eggplant"   (walk only, no selection)
 */

import {
  Catalogue,
  DEFAULT_HIERARCHY,
  DETAIL_LEVEL_LABELS,
  EXPO_ROOT,
  TERM_TYPE_LABELS,
  isBaseCandidate,
  isInExposureTree,
} from "./catalogue.js";
import { dataDir } from "./data.js";
import { encodeBaseTerm } from "./encode/base-term.js";
import { collectTraversalCandidates } from "./encode/traverse.js";
import { loadEnv } from "./env.js";
import { searchTerms } from "./search/lexical.js";
import { vectorIndexAvailable, vectorSearchBase } from "./search/vector.js";

function usage(): never {
  console.error(`Usage:
  npm run cli -- info
  npm run cli -- term <CODE>
  npm run cli -- search <query> [--limit N]
  npm run cli -- semantic <query> [--limit N]
  npm run cli -- encode <food description> [--lexical-only] [--base-only]
  npm run cli -- traverse <food description> [--audit]`);
  process.exit(2);
}

function cmdInfo(): void {
  const cat = Catalogue.load();
  const topLevel = cat.exposureTopLevel();
  const baseCount = Object.values(cat.data.terms).filter(isBaseCandidate).length;
  console.log(
    JSON.stringify(
      {
        dataDir: dataDir(),
        catalogue: cat.data.catalogue,
        version: cat.version,
        hierarchy: DEFAULT_HIERARCHY,
        termCount: cat.termCount,
        facetCategoryCount: Object.keys(cat.data.facetCategories).length,
        baseCandidateCount: baseCount,
        exposureTopLevel: {
          parent: EXPO_ROOT,
          groupCount: topLevel.length,
          groups: topLevel.map((code) => ({
            code,
            name: cat.term(code)?.name ?? null,
          })),
        },
      },
      null,
      2
    )
  );
}

function cmdTerm(code: string): void {
  const cat = Catalogue.load();
  const term = cat.term(code);
  if (term === undefined) {
    console.error(`Unknown term: ${code}`);
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        code,
        name: term.name,
        termType: term.termType
          ? TERM_TYPE_LABELS[term.termType] ?? term.termType
          : null,
        detailLevel: term.detailLevel
          ? DETAIL_LEVEL_LABELS[term.detailLevel] ?? term.detailLevel
          : null,
        deprecated: term.status === "DEPRECATED",
        baseCandidate: isBaseCandidate(term),
        underFood: term !== undefined && isInExposureTree(term),
        scopeNote: term.scopeNote,
        implicitFacets: term.implicitFacets,
        inheritedFacets: cat.inheritedFacets(term),
        impliedFacets: cat.impliedFacets(code),
        parent: cat.parent(code, DEFAULT_HIERARCHY),
        children: cat.children(code, DEFAULT_HIERARCHY).slice(0, 20),
      },
      null,
      2
    )
  );
}

function parseSearchArgs(argv: string[]): { query: string; limit: number } {
  let limit = 10;
  const parts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--limit") {
      const value = argv[++i];
      if (value === undefined || !/^\d+$/.test(value)) usage();
      limit = Number(value);
      continue;
    }
    parts.push(arg);
  }
  const query = parts.join(" ").trim();
  if (query === "") usage();
  return { query, limit };
}

function cmdSearch(argv: string[]): void {
  const { query, limit } = parseSearchArgs(argv);
  const started = performance.now();
  const hits = searchTerms(query, { limit, baseOnly: true, underFood: true });
  const ms = Math.round(performance.now() - started);
  console.log(
    JSON.stringify(
      {
        query,
        limit,
        elapsedMs: ms,
        hits: hits.map((h) => ({
          code: h.code,
          name: h.name,
          score: Math.round(h.score * 1000) / 1000,
          detailLevel: h.detailLevel
            ? DETAIL_LEVEL_LABELS[h.detailLevel] ?? h.detailLevel
            : null,
          termType: h.termType ? TERM_TYPE_LABELS[h.termType] ?? h.termType : null,
        })),
      },
      null,
      2
    )
  );
}

async function cmdSemantic(argv: string[]): Promise<void> {
  const { query, limit } = parseSearchArgs(argv);
  if (!vectorIndexAvailable()) {
    console.error("Base embedding index missing — run npm run build:embeddings");
    process.exit(1);
  }
  const cat = Catalogue.load();
  const started = performance.now();
  const hits = await vectorSearchBase(query, limit);
  const ms = Math.round(performance.now() - started);
  console.log(
    JSON.stringify(
      {
        query,
        limit,
        elapsedMs: ms,
        hits: hits.map((h) => {
          const term = cat.term(h.code);
          return {
            code: h.code,
            name: term?.name ?? null,
            similarity: Math.round(h.similarity * 1000) / 1000,
            detailLevel: term?.detailLevel
              ? DETAIL_LEVEL_LABELS[term.detailLevel] ?? term.detailLevel
              : null,
            termType: term?.termType
              ? TERM_TYPE_LABELS[term.termType] ?? term.termType
              : null,
          };
        }),
      },
      null,
      2
    )
  );
}

function parseEncodeArgs(argv: string[]): {
  input: string;
  lexicalOnly: boolean;
  baseOnly: boolean;
} {
  const lexicalOnly = argv.includes("--lexical-only");
  const baseOnly = argv.includes("--base-only");
  const parts = argv.filter((a) => a !== "--lexical-only" && a !== "--base-only");
  const input = parts.join(" ").trim();
  if (input === "") usage();
  return { input, lexicalOnly, baseOnly };
}

async function cmdEncode(argv: string[]): Promise<void> {
  loadEnv();
  const { input, lexicalOnly, baseOnly } = parseEncodeArgs(argv);
  const started = performance.now();
  const result = await encodeBaseTerm(input, { lexicalOnly, baseOnly });
  const elapsedMs = Math.round(performance.now() - started);
  console.log(JSON.stringify({ elapsedMs, ...result }, null, 2));
  if (result.status === "rejected") process.exitCode = 1;
}

async function cmdTraverse(argv: string[]): Promise<void> {
  loadEnv();
  const withAudit = argv.includes("--audit");
  const input = argv.filter((a) => a !== "--audit").join(" ").trim();
  if (input === "") usage();
  const started = performance.now();
  const collected = await collectTraversalCandidates(input);
  const elapsedMs = Math.round(performance.now() - started);

  // Per classify call: what matched; the full list only where nothing did.
  const path = collected.steps.map(({ walk, parent, classifications }) => {
    const matches = classifications.filter((row) => row.match !== "none");
    return {
      walk,
      parent,
      matches,
      ...(matches.length === 0 ? { nonMatches: classifications } : {}),
    };
  });

  const body: Record<string, unknown> = {
    elapsedMs,
    input,
    wholeItem: collected.wholeItem,
    descriptionKind: collected.descriptionKind,
    walks: collected.walks,
    candidateCount: collected.candidates.length,
    candidates: collected.candidates,
    path,
  };
  if (withAudit) body.audit = collected.audit;

  console.log(JSON.stringify(body, null, 2));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === undefined || cmd === "info") {
    cmdInfo();
    return;
  }
  if (cmd === "term") {
    const code = rest[0];
    if (code === undefined) usage();
    cmdTerm(code.toUpperCase());
    return;
  }
  if (cmd === "search") {
    cmdSearch(rest);
    return;
  }
  if (cmd === "semantic") {
    await cmdSemantic(rest);
    return;
  }
  if (cmd === "encode") {
    await cmdEncode(rest);
    return;
  }
  if (cmd === "traverse") {
    await cmdTraverse(rest);
    return;
  }
  usage();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
