/**
 * Top-down placement under Facets (A0B8V) closed hierarchies.
 *
 * Two stages (same idea as base-term recall → select):
 * 1. Recall — under each opened header, branch-open only; collect candidate
 *    descriptors (leaves at visited levels + opened internals).
 * 2. Select — one pick over the union (name + scope note). If the winner
 *    is an internal node, pick among its direct children, level by level.
 *
 * Separate from base-term traverse.ts — phrase-vs-descriptor, not food-vs-term.
 */

import { Catalogue } from "../catalogue.js";
import { chatJson } from "../llm.js";
import { pickAllowedCode, pickAllowedCodes } from "./answers.js";
import { F07, F11 } from "./numeric-facets.js";
import type { FacetDescriptorRef } from "./types.js";

const F09 = "F09";
const F26 = "F26";

/** Owned by an earlier step (numeric snap, fortification, F26 path), never walked. */
export const FACET_WALK_SKIP_HEADERS: ReadonlySet<string> = new Set([F07, F09, F11, F26]);

const MAX_DEPTH = 6;
const MAX_BRANCHES_PER_LEVEL = 4;

/**
 * Branch open: which children are worth descending into.
 * Payload is name + direct child names only (no scope notes).
 */
const SYSTEM_BRANCH = `You are a food and nutrition ontology expert. Your task is to decide which -if any- of the groups may contain a term applicable to the phrase.

Inputs:
- \`description\`: the food description.
- \`phrase\`: the phrase from the description.
- \`groups\`: groups of catalogue terms, each with a \`code\`, a \`name\`, and the names of the terms directly under it.

Interpret the phrase in the context of the food description.

Reply with JSON only, listing the codes of those groups, or an empty list if there are none:
{"codes":["<code>",...]}
`;

/**
 * Precision pick among recalled descriptors (possibly from several dimensions).
 * note is MTX scope text.
 */
const SYSTEM_LEAF = `You are a food and nutrition ontology expert. Your task is to match a phrase from a food description to a catalogue term.

Inputs:
- \`description\`: the food description.
- \`phrase\`: the phrase from the description.
- \`terms\`: catalogue terms, each with a \`code\`, a \`name\`, the \`list\` it belongs to and, for some, a \`note\` from the catalogue on when to use it.

A term matches when the description alone is enough to know the term is true of what the phrase says. Pick the narrowest matching term.

Reply with JSON only, giving the code of that term, or null if no term matches:
{"code":"<code>"|null}
`;

export type FacetWalkAccept = (header: string, code: string) => boolean;

/** The food the phrase belongs to, shown to the model alongside the phrase. */
export type FacetWalkFood = { input: string; baseTerm: string };

export type FacetWalkOptions = {
  model: string;
  /**
   * Which descriptors may be returned. Default: every non-deprecated descriptor
   * in the hierarchy. Rejected internal nodes can still be descended through.
   */
  accept?: FacetWalkAccept;
  maxDepth?: number;
  food?: FacetWalkFood;
  /**
   * Extra candidates for the select, e.g. name matches the catalogue files away
   * from where the walk looks (F04 *Fries* under composite dishes).
   */
  seeds?: Array<{ header: string; code: string }>;
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
): Array<{ code: string; name: string; list: string; note?: string }> {
  return candidates.map(({ code, header }) => {
    const term = cat.term(code);
    const name = term?.name ?? code;
    const note = term?.scopeNote?.trim();
    const list = cat.facetCategory(header)?.label ?? header;
    return {
      code,
      name,
      list,
      ...(note ? { note } : {}),
    };
  });
}

async function askBranch(
  phrase: string,
  groups: Array<{ code: string; name: string; children?: string[] }>,
  options: FacetWalkOptions
): Promise<{ codes: string[]; model: string }> {
  const allowed = new Set(groups.map((c) => c.code));
  const picked = await chatJson({
    model: options.model,
    system: SYSTEM_BRANCH,
    user: JSON.stringify(
      {
        ...(options.food ? { description: options.food.input } : {}),
        phrase,
        groups,
      },
      null,
      2
    ),
  });
  return {
    codes: pickAllowedCodes(picked.content, allowed).slice(0, MAX_BRANCHES_PER_LEVEL),
    model: picked.model,
  };
}

async function askSelect(
  phrase: string,
  terms: Array<{ code: string; name: string; list: string; note?: string }>,
  options: FacetWalkOptions
): Promise<{ code: string | null; model: string }> {
  const allowed = new Set(terms.map((c) => c.code));
  const picked = await chatJson({
    model: options.model,
    system: SYSTEM_LEAF,
    user: JSON.stringify(
      {
        ...(options.food ? { description: options.food.input } : {}),
        phrase,
        terms,
      },
      null,
      2
    ),
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

  const opened = await askBranch(phrase, candidates, options);
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
 * Which facets a leftover phrase speaks to, for this food. Several may apply
 * ("in sunflower oil" on canned tuna: surrounding medium and ingredient).
 */
const SYSTEM_PICK_FACETS = `You are a food and nutrition ontology expert.

We are coding a food in FoodEx2. Its base term is chosen; \`phrase\` is part of the food description the base term does not yet capture. Which facets does that phrase say something about, for this food? A phrase can speak to more than one facet.

Each candidate is a facet; its listed child names show what it covers.

Empty list if none apply.

Reply with JSON only:
{"codes":["<code>",...]}
`;

/** A picker option that is not a Facets dimension (routed by the caller). */
export type FacetPickExtra = { code: string; name: string };

/**
 * Pick every option the phrase speaks to: walkable Facets dimensions (by
 * header) plus caller-routed extras. Returns codes in reply order.
 */
export async function pickFacets(
  cat: Catalogue,
  phrase: string,
  dimensions: FacetWalkDimension[],
  extras: FacetPickExtra[],
  options: FacetWalkOptions
): Promise<{ codes: string[]; detail: Record<string, unknown> }> {
  const walkable = walkableDimensions(dimensions);
  const candidates = [
    ...extras.map((e) => ({ code: e.code, name: e.name })),
    ...walkable.map((d) => {
      const hierarchy = hierarchyFor(cat, d.header);
      const childNames =
        hierarchy === null
          ? []
          : childCodes(cat, hierarchy, "root", d.header, options.accept).map(
              (c) => cat.term(c)?.name ?? c
            );
      return {
        code: d.header,
        name: d.name,
        ...(childNames.length > 0 ? { children: childNames } : {}),
      };
    }),
  ];
  /** pickAllowedCodes upper-cases replies; extras' codes need not be upper case. */
  const byUpper = new Map(candidates.map((c) => [c.code.toUpperCase(), c.code]));
  const allowed = new Set(byUpper.keys());
  const picked = await chatJson({
    model: options.model,
    system: SYSTEM_PICK_FACETS,
    user: JSON.stringify(
      { phrase, ...(options.food ? { food: options.food } : {}), candidates },
      null,
      2
    ),
  });
  const codes = pickAllowedCodes(picked.content, allowed).map((c) => byUpper.get(c) ?? c);
  return {
    codes,
    detail: { phrase, via: "pick_facets", picked: codes, model: picked.model },
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
  steps: WalkStep[]
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
    if (accept !== undefined && !accept(header, code)) return;
    seen.add(code);
    out.push({ header, code });
  };

  const walk = async (parent: string, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      steps.push({ header, parent, via: "max_depth" });
      return;
    }

    const children = childCodes(cat, hierarchy, parent, header, undefined);
    if (children.length === 0) {
      steps.push({ header, parent, via: "no_children" });
      return;
    }

    const leaves: string[] = [];
    const internals: string[] = [];
    for (const code of children) {
      if (childCodes(cat, hierarchy, code, header, undefined).length === 0) leaves.push(code);
      else internals.push(code);
    }

    for (const code of leaves) add(code);

    if (internals.length === 0) {
      steps.push({
        header,
        parent,
        via: "recall_leaves",
        depth,
        added: leaves.filter((code) => seen.has(code)),
      });
      return;
    }

    const branchCandidates = branchPayload(cat, hierarchy, internals);
    const opened = await askBranch(phrase, branchCandidates, options);
    steps.push({
      header,
      parent,
      via: "branch_open",
      depth,
      leavesAtLevel: leaves.filter((code) => seen.has(code)),
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

  await walk("root", 0);
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
  const picked = await askSelect(phrase, candidates, options);
  steps.push({
    via,
    candidates: candidates.map((c) => ({
      code: c.code,
      name: c.name,
      facet: c.list,
      hasGuidance: c.note !== undefined,
    })),
    picked: picked.code,
    model: picked.model,
  });
  if (picked.code === null) return null;
  return pool.find((c) => c.code === picked.code) ?? null;
}

/**
 * After a pick of an internal node, select among its direct children only;
 * keep the node when none matches. Repeats while the pick has children.
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
    const kids = childCodes(cat, hierarchy, chosen.code, chosen.header, options.accept);
    if (kids.length === 0) return chosen;

    const pool: RecalledCandidate[] = kids.map((code) => ({ header: chosen.header, code }));
    const candidates = selectPayload(cat, pool);
    const picked = await askSelect(phrase, candidates, options);
    steps.push({
      via: "select_densify",
      parent: chosen.code,
      candidates: candidates.map((c) => ({ code: c.code, name: c.name })),
      picked: picked.code,
      model: picked.model,
    });
    const next = pool.find((c) => c.code === picked.code);
    if (next === undefined) return chosen;
    chosen = next;
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

  const seeds = (options.seeds ?? []).filter(
    (s) =>
      tried.includes(s.header) &&
      !cat.isDeprecated(s.code) &&
      (options.accept === undefined || options.accept(s.header, s.code))
  );
  if (seeds.length > 0) {
    steps.push({ via: "seeds", codes: seeds.map((s) => s.code) });
    mergeRecalled(pool, seeds);
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
    childCodes(cat, hierarchy, picked.code, picked.header, undefined).length > 0
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
