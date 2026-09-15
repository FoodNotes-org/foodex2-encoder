/**
 * Top-down placement under Facets (A0B8V) closed hierarchies.
 *
 * Two stages (same idea as base-term recall → select):
 * 1. Recall — under each opened header, branch-open only; collect candidate
 *    descriptors (leaves at visited levels + opened internals).
 * 2. Select — one pick over the union (name + codingGuidance). If the winner
 *    is an internal node, densify under it with the same split.
 *
 * Separate from base-term traverse.ts — phrase-vs-descriptor, not food-vs-term.
 */

import { Catalogue } from "../catalogue.js";
import { chatJson } from "../llm.js";
import { pickAllowedCode, pickAllowedCodes } from "./answers.js";
import { F07, F11 } from "./numeric-facets.js";
import type { FacetDescriptorRef } from "./types.js";

const F26 = "F26";

/** Handled by numeric snap, F26 path, or not residual Facets walk. */
export const FACET_WALK_SKIP_HEADERS: ReadonlySet<string> = new Set([F07, F11, F26]);

const MAX_DEPTH = 6;
const MAX_BRANCHES_PER_LEVEL = 4;

/**
 * Branch open: which children are worth descending into.
 * Payload is name + direct child names only (no scope notes).
 */
const SYSTEM_BRANCH = `You are a food and nutrition ontology expert.

We are placing a leftover property of a food into the FoodEx2 facet catalogue by walking its hierarchy top-down. The phrase is that property (not the food itself). The candidates are sibling nodes at the current level.

Return every candidate under which the phrase might belong — we will descend into those next. Use each candidate's listed child names only to see what that branch covers; child names are catalogue structure, not ingredients of the food.

Empty list if none apply.

Reply with JSON only:
{"codes":["<code>",...]}
`;

/**
 * Precision pick among recalled descriptors (possibly from several dimensions).
 * codingGuidance is MTX scope text reframed for the model.
 */
const SYSTEM_LEAF = `You are a food and nutrition ontology expert.

We are placing a leftover property of a food into the FoodEx2 facet catalogue. The phrase is that property (not the food itself). Candidates may come from different facet dimensions (see facet). Pick the descriptor that fits the phrase, or null if none do.

Candidates may include codingGuidance: catalogue instructions for when to use or not use that descriptor, and sometimes how it trades off against other facets. Use it only to decide whether that candidate is the right code for the phrase.

Reply with JSON only:
{"code":"<CODE>"|null}
`;

export type FacetWalkAccept = (header: string, code: string) => boolean;

export type FacetWalkOptions = {
  model: string;
  /** Default: keep every non-deprecated descriptor in the hierarchy. */
  accept?: FacetWalkAccept;
  maxDepth?: number;
};

type WalkStep = Record<string, unknown>;

type RecalledCandidate = {
  header: string;
  code: string;
};

function hierarchyFor(cat: Catalogue, header: string): string | null {
  return cat.facetCategory(header)?.hierarchyCode ?? null;
}

function childCodes(
  cat: Catalogue,
  hierarchy: string,
  parent: string,
  header: string,
  accept: FacetWalkAccept | undefined
): string[] {
  const out: string[] = [];
  for (const code of cat.children(parent, hierarchy)) {
    if (cat.isDeprecated(code)) continue;
    if (accept !== undefined && !accept(header, code)) continue;
    out.push(code);
  }
  return out;
}

function branchPayload(
  cat: Catalogue,
  hierarchy: string,
  codes: string[]
): Array<{ code: string; name: string; children?: string[] }> {
  return codes.map((code) => {
    const name = cat.term(code)?.name ?? code;
    const kids = cat
      .children(code, hierarchy)
      .filter((c) => !cat.isDeprecated(c))
      .map((c) => cat.term(c)?.name ?? c);
    return {
      code,
      name,
      ...(kids.length > 0 ? { children: kids } : {}),
    };
  });
}

function selectPayload(
  cat: Catalogue,
  candidates: RecalledCandidate[]
): Array<{ code: string; name: string; facet: string; codingGuidance?: string }> {
  return candidates.map(({ code, header }) => {
    const term = cat.term(code);
    const name = term?.name ?? code;
    const guidance = term?.scopeNote?.trim();
    const facet = cat.facetCategory(header)?.label ?? header;
    return {
      code,
      name,
      facet,
      ...(guidance ? { codingGuidance: guidance } : {}),
    };
  });
}

async function askBranch(
  phrase: string,
  candidates: Array<{ code: string; name: string; children?: string[] }>,
  model: string
): Promise<{ codes: string[]; model: string }> {
  const allowed = new Set(candidates.map((c) => c.code));
  const picked = await chatJson({
    model,
    system: SYSTEM_BRANCH,
    user: JSON.stringify({ phrase, candidates }, null, 2),
  });
  return {
    codes: pickAllowedCodes(picked.content, allowed).slice(0, MAX_BRANCHES_PER_LEVEL),
    model: picked.model,
  };
}

async function askSelect(
  phrase: string,
  candidates: Array<{ code: string; name: string; facet: string; codingGuidance?: string }>,
  model: string
): Promise<{ code: string | null; model: string }> {
  const allowed = new Set(candidates.map((c) => c.code));
  const picked = await chatJson({
    model,
    system: SYSTEM_LEAF,
    user: JSON.stringify({ phrase, candidates }, null, 2),
  });
  return { code: pickAllowedCode(picked.content, allowed), model: picked.model };
}

export type FacetWalkDimension = {
  /** MTX dimension term under Facets (A0B8V). */
  code: string;
  name: string;
  header: string;
};

/**
 * Facets dimensions eligible for residual walk (excludes numeric / F26).
 */
export function walkableDimensions(
  dimensions: FacetWalkDimension[]
): FacetWalkDimension[] {
  return dimensions.filter((d) => !FACET_WALK_SKIP_HEADERS.has(d.header));
}

/**
 * Ask which Facets dimensions to open (name + top descriptor-group names).
 * Wide recall; caller walks only the returned headers.
 */
export async function openFacetDimensions(
  cat: Catalogue,
  phrase: string,
  dimensions: FacetWalkDimension[],
  options: FacetWalkOptions
): Promise<{ headers: string[]; detail: Record<string, unknown> }> {
  const walkable = walkableDimensions(dimensions);
  if (walkable.length === 0) {
    return { headers: [], detail: { phrase, via: "dimension_open", opened: [] } };
  }
  if (walkable.length === 1) {
    return {
      headers: [walkable[0]!.header],
      detail: {
        phrase,
        via: "dimension_open",
        opened: [walkable[0]!.code],
        headers: [walkable[0]!.header],
        sole: true,
      },
    };
  }

  const accept = options.accept;
  const candidates = walkable.map((d) => {
    const hierarchy = hierarchyFor(cat, d.header);
    const childNames =
      hierarchy === null
        ? []
        : childCodes(cat, hierarchy, "root", d.header, accept).map(
            (c) => cat.term(c)?.name ?? c
          );
    return {
      code: d.code,
      name: d.name,
      ...(childNames.length > 0 ? { children: childNames } : {}),
    };
  });

  const opened = await askBranch(phrase, candidates, options.model);
  const byCode = new Map(walkable.map((d) => [d.code, d.header]));
  const headers: string[] = [];
  for (const code of opened.codes) {
    const header = byCode.get(code);
    if (header !== undefined && !headers.includes(header)) headers.push(header);
  }
  return {
    headers,
    detail: {
      phrase,
      via: "dimension_open",
      candidates: candidates.map((c) => ({
        code: c.code,
        name: c.name,
        childCount: c.children?.length ?? 0,
      })),
      opened: opened.codes,
      headers,
      model: opened.model,
    },
  };
}

/**
 * Recall under one header: branch-open only; collect leaves at visited levels
 * and opened internal nodes (no precision pick yet).
 */
async function collectUnderHeader(
  cat: Catalogue,
  phrase: string,
  header: string,
  options: FacetWalkOptions,
  steps: WalkStep[],
  startParent = "root"
): Promise<RecalledCandidate[]> {
  const hierarchy = hierarchyFor(cat, header);
  if (hierarchy === null) {
    steps.push({ header, via: "no_hierarchy" });
    return [];
  }

  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const accept = options.accept;
  const out: RecalledCandidate[] = [];
  const seen = new Set<string>();

  const add = (code: string): void => {
    if (seen.has(code)) return;
    seen.add(code);
    out.push({ header, code });
  };

  const walk = async (parent: string, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      steps.push({ header, parent, via: "max_depth" });
      return;
    }

    const children = childCodes(cat, hierarchy, parent, header, accept);
    if (children.length === 0) {
      steps.push({ header, parent, via: "no_children" });
      return;
    }

    const leaves: string[] = [];
    const internals: string[] = [];
    for (const code of children) {
      if (childCodes(cat, hierarchy, code, header, accept).length === 0) leaves.push(code);
      else internals.push(code);
    }

    for (const code of leaves) add(code);

    if (internals.length === 0) {
      steps.push({
        header,
        parent,
        via: "recall_leaves",
        depth,
        added: leaves,
      });
      return;
    }

    const branchCandidates = branchPayload(cat, hierarchy, internals);
    const opened = await askBranch(phrase, branchCandidates, options.model);
    steps.push({
      header,
      parent,
      via: "branch_open",
      depth,
      leavesAtLevel: leaves,
      candidates: branchCandidates.map((c) => ({
        code: c.code,
        name: c.name,
        childCount: c.children?.length ?? 0,
      })),
      opened: opened.codes,
      model: opened.model,
    });

    for (const code of opened.codes) {
      add(code);
      await walk(code, depth + 1);
    }
  };

  await walk(startParent, startParent === "root" ? 0 : 1);
  return out;
}

function mergeRecalled(into: RecalledCandidate[], more: RecalledCandidate[]): void {
  const seen = new Set(into.map((c) => c.code));
  for (const c of more) {
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    into.push(c);
  }
}

async function selectAmong(
  cat: Catalogue,
  phrase: string,
  pool: RecalledCandidate[],
  options: FacetWalkOptions,
  steps: WalkStep[],
  via: string
): Promise<RecalledCandidate | null> {
  if (pool.length === 0) return null;
  if (pool.length === 1) {
    steps.push({
      via,
      sole: true,
      code: pool[0]!.code,
      header: pool[0]!.header,
    });
    return pool[0]!;
  }

  const candidates = selectPayload(cat, pool);
  const picked = await askSelect(phrase, candidates, options.model);
  steps.push({
    via,
    candidates: candidates.map((c) => ({
      code: c.code,
      name: c.name,
      facet: c.facet,
      hasGuidance: c.codingGuidance !== undefined,
    })),
    picked: picked.code,
    model: picked.model,
  });
  if (picked.code === null) return null;
  return pool.find((c) => c.code === picked.code) ?? null;
}

/**
 * After a global pick of an internal node, recall under it and select again
 * (including the current node as "stop here").
 */
async function densify(
  cat: Catalogue,
  phrase: string,
  current: RecalledCandidate,
  options: FacetWalkOptions,
  steps: WalkStep[]
): Promise<RecalledCandidate> {
  const hierarchy = hierarchyFor(cat, current.header);
  if (hierarchy === null) return current;

  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  let chosen = current;

  for (let depth = 0; depth < maxDepth; depth++) {
    const kids = childCodes(
      cat,
      hierarchy,
      chosen.code,
      chosen.header,
      options.accept
    );
    if (kids.length === 0) return chosen;

    const deeper = await collectUnderHeader(
      cat,
      phrase,
      chosen.header,
      options,
      steps,
      chosen.code
    );
    const pool: RecalledCandidate[] = [{ header: chosen.header, code: chosen.code }];
    mergeRecalled(pool, deeper);

    const picked = await selectAmong(
      cat,
      phrase,
      pool,
      options,
      steps,
      "select_densify"
    );
    if (picked === null || picked.code === chosen.code) return chosen;
    chosen = picked;
  }

  return chosen;
}

/**
 * Recall under every header, then one precision select over the union.
 */
export async function resolveFacetWalk(
  cat: Catalogue,
  phrase: string,
  headers: string[],
  options: FacetWalkOptions
): Promise<{ facet: FacetDescriptorRef | null; detail: Record<string, unknown> }> {
  const steps: WalkStep[] = [];
  const tried: string[] = [];
  const pool: RecalledCandidate[] = [];

  for (const header of headers) {
    if (FACET_WALK_SKIP_HEADERS.has(header)) {
      steps.push({ header, via: "skipped_header" });
      continue;
    }
    tried.push(header);
    const recalled = await collectUnderHeader(cat, phrase, header, options, steps);
    steps.push({
      header,
      via: "recall_done",
      count: recalled.length,
      codes: recalled.map((c) => c.code),
    });
    mergeRecalled(pool, recalled);
  }

  steps.push({
    via: "recall_pool",
    count: pool.length,
    byHeader: tried.map((header) => ({
      header,
      count: pool.filter((c) => c.header === header).length,
    })),
  });

  let picked = await selectAmong(cat, phrase, pool, options, steps, "select");
  if (picked === null) {
    return {
      facet: null,
      detail: {
        phrase,
        via: "facet_walk",
        headers: tried,
        resolved: null,
        steps,
      },
    };
  }

  const hierarchy = hierarchyFor(cat, picked.header);
  if (
    hierarchy !== null &&
    childCodes(cat, hierarchy, picked.code, picked.header, options.accept).length > 0
  ) {
    picked = await densify(cat, phrase, picked, options, steps);
  }

  const facet: FacetDescriptorRef = {
    header: picked.header,
    code: picked.code,
    name: cat.term(picked.code)?.name ?? picked.code,
  };

  return {
    facet,
    detail: {
      phrase,
      via: "facet_walk",
      headers: tried,
      resolved: facet.code,
      header: facet.header,
      name: facet.name,
      steps,
    },
  };
}
