/**
 * Top-down placement under Facets (A0B8V) closed hierarchies.
 *
 * Two stages (same idea as base-term recall → select):
 * 1. Recall — under each opened header, branch-open only; collect candidate
 *    descriptors (leaves at visited levels + opened internals).
 * 2. Select — the terms the phrase states. A single facet yields one or none;
 *    a repeatable facet yields zero or more.
 *
 * Separate from base-term traverse.ts — phrase-vs-descriptor, not food-vs-term.
 */

import { Catalogue } from "../catalogue.js";
import { countryParagraph } from "../country.js";
import { chatJson } from "../llm.js";
import { facetCardinality } from "../rules/index.js";
import { vectorIndexAvailable, vectorSearchFacets } from "../search/vector.js";
import { pickAllowedCode, pickAllowedCodes } from "./answers.js";
import { F07, F11 } from "./numeric-facets.js";
import type { FacetDescriptorRef } from "./types.js";

const F09 = "F09";
const F26 = "F26";
const F28 = "F28";

/**
 * Nearest process-facet hits added to the choice list. Same count as the
 * base-term embedding seeds. They do not open branches.
 */
const PROCESS_EMBEDDING_SEED_LIMIT = 5;
/** Extra hits so a rejected one does not shrink the five. */
const PROCESS_EMBEDDING_SCAN = 20;

/** Owned by an earlier step (numeric snap, fortification, F26 path), never walked. */
export const FACET_WALK_SKIP_HEADERS: ReadonlySet<string> = new Set([F07, F09, F11, F26]);

const MAX_DEPTH = 6;
const MAX_BRANCHES_PER_LEVEL = 4;

/**
 * Branch open: which groups a kind named by the phrase is a kind of.
 * A phrase may name several kinds. Payload is name + direct child names only.
 */
function systemBranch(withCountry: boolean): string {
  return `You are an expert in food classification.

You are given the following inputs:
- \`description\`: the food description.
- \`phrase\`: the phrase from the description.
- \`groups\`: groups of catalogue terms, each with a \`code\`, a \`name\`, and the names of the terms directly under it.
${countryParagraph(withCountry, "description")}
Your task is to decide which of these groups a kind named by the phrase is a kind of.

Reply with JSON only, listing the codes of those groups, or an empty list if there are none:
{"codes":["<code>",...]}
`;
}

/**
 * Precision pick among recalled descriptors of one facet. note is MTX scope text.
 * A repeatable facet may take every matching term; a single facet takes one.
 */
export function systemLeaf(withCountry: boolean, many = false): string {
  const foodLine = withCountry
    ? "- `food`: the food being described, to be understood alongside `phrase` in the food nomenclature of: `country`."
    : "- `food`: the food being described.";
  const task = many
    ? "Your task is to decide which terms, if any, mean the same thing about `food` as `phrase` does — the same attribute and the same value of it."
    : "Your task is to decide which term, if any, means the same thing about `food` as `phrase` does — the same attribute and the same value of it.";
  const reply = many
    ? `Reply with JSON only, first stating in English what \`phrase\` means about \`food\`, then listing the codes of the matching terms, or an empty list if there are none:
{"meaning":"<meaning>","codes":["<code>",...]}`
    : `Reply with JSON only, first stating in English what \`phrase\` means about \`food\`, then giving the code of the matching term, or null if there is none:
{"meaning":"<meaning>","code":"<code>"|null}`;
  return `You are an expert in food classification.

A food description is being expressed in the terms of a food catalogue.

Your given inputs:
${foodLine}
- \`phrase\`: a phrase that qualifies \`food\`.
- \`terms\`: catalogue terms, each with a \`code\`, a \`label\` (\`<attribute>: <value>\`) that names it, and, for some, a \`note\` from the catalogue explaining its meaning, scope and use.

${task}

${reply}
`;
}

/** How the picked term relates to the food in an origin walk. */
export type OriginPickRole = "source" | "made_from" | "ingredient";

const ORIGIN_TASK: Record<OriginPickRole, string> = {
  source:
    "which term, if any, is the plant or animal `food` comes from, that `lookingFor` states and that `baseTerm` does not already denote",
  made_from:
    "which term, if any, is what `food` is made from, that `lookingFor` states and that `baseTerm` does not already denote",
  ingredient:
    "which term, if any, is the characterising ingredient of `food` that `lookingFor` states and that `baseTerm` does not already denote",
};

const ORIGIN_TASK_MANY: Record<OriginPickRole, string> = {
  source:
    "which terms, if any, does `lookingFor` name as the plant or animal `food` comes from, that `baseTerm` does not already denote",
  made_from:
    "which terms, if any, does `lookingFor` name as what `food` is made from, that `baseTerm` does not already denote",
  ingredient:
    "which terms, if any, does `lookingFor` name as the characterising ingredient of `food`, that `baseTerm` does not already denote",
};

/**
 * Final pick for origin walks.
 * A repeatable facet (`many`) may name every term the phrase states.
 * A single facet names one.
 */
export function systemOriginPick(role: OriginPickRole, withCountry = false, many = false): string {
  const task = many ? ORIGIN_TASK_MANY[role] : ORIGIN_TASK[role];
  const detail = many
    ? `The remainder of a parent is the sibling that is the part of the parent the other siblings do not cover. A sibling other than the remainder counts only when \`lookingFor\` names it, and not when it adds a detail \`lookingFor\` does not name. The narrowest remainder counts when \`lookingFor\` names a kind of its parent and no other sibling counts for that kind.

`
    : "";
  const termsLine = many
    ? "- `terms`: candidate terms, each with a `code`, a `name`, and its `parent`."
    : "- `terms`: candidate terms, each with a `code` and a `name`.";
  const reply = many
    ? `Reply with JSON only, listing the codes of those terms, or an empty list if there are none:
{"codes":["<code>",...]}`
    : `Reply with JSON only, with the code of that term, or null if none of them is:
{"code":"<code>"|null}`;
  return `You are an expert in food classification.

Task: ${task}?

${detail}Given:
- \`food\`: the food as described.
- \`baseTerm\`: the class already chosen for this food, with its \`name\` and its \`scope\`.
- \`lookingFor\`: what we are trying to identify; it may be worded loosely.
${termsLine}
${countryParagraph(withCountry, "food")}
A term counts only when it states a detail \`lookingFor\` names and \`baseTerm\` does not already denote. \`baseTerm\` denotes a detail when its name or scope fixes it, including under another name. A narrower kind counts only when the detail it adds is one \`baseTerm\` does not denote.

${reply}
`;
}

/**
 * Source-commodities pick. Its own question: the raw commodity the food is made
 * from. Fresh in a raw-commodity name is that commodity.
 */
export function systemSourceCommodityPick(withCountry = false, many = false): string {
  const task = many
    ? "which terms, if any, are the raw commodities `food` is made from, that `lookingFor` states and that `baseTerm` does not already denote"
    : "which term, if any, is the raw commodity `food` is made from, that `lookingFor` states and that `baseTerm` does not already denote";
  const termsLine = many
    ? "- `terms`: candidate raw commodities, each with a `code`, a `name`, and its `parent`."
    : "- `terms`: candidate raw commodities, each with a `code` and a `name`.";
  const reply = many
    ? `Reply with JSON only, listing the codes of those terms, or an empty list if there are none:
{"codes":["<code>",...]}`
    : `Reply with JSON only, with the code of that term, or null if none of them is:
{"code":"<code>"|null}`;
  const remainder = many
    ? `The remainder of a parent is the sibling that is the part of the parent the other siblings do not cover. A sibling other than the remainder counts when it is the raw commodity \`lookingFor\` states. In a raw-commodity name, fresh denotes the raw commodity, not a further detail. The narrowest remainder counts when \`lookingFor\` states a kind of its parent and no listed sibling is that commodity.

`
    : `In a raw-commodity name, fresh denotes the raw commodity, not a further detail.

`;
  return `You are an expert in food classification.

Task: ${task}?

${remainder}Given:
- \`food\`: the food as described.
- \`baseTerm\`: the class already chosen for this food, with its \`name\` and its \`scope\`.
- \`lookingFor\`: the raw commodity to identify; it may be worded loosely.
${termsLine}
${countryParagraph(withCountry, "food")}
A term counts when it is the raw commodity \`lookingFor\` states and \`baseTerm\` does not already denote. \`baseTerm\` denotes a detail when its name or scope fixes it, including under another name.

${reply}
`;
}

export type FacetWalkAccept = (header: string, code: string) => boolean;

/** The food the phrase belongs to, shown to the model alongside the phrase. */
export type FacetWalkFood = {
  input: string;
  /** Input with stated attributes cut out; falls back to `input`. */
  food?: string;
  baseTerm: string;
  baseScope: string;
};

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
  /** Origin walks: the final pick asks this role's question about `food`. */
  originRole?: OriginPickRole;
  /** English country name. Omitted from the prompt when absent. */
  country?: string | null;
};

function hasCountry(options: FacetWalkOptions): boolean {
  return options.country != null && options.country !== "";
}

function countryField(options: FacetWalkOptions): { country: string } | Record<string, never> {
  return hasCountry(options) ? { country: options.country as string } : {};
}

type WalkStep = Record<string, unknown>;

type RecalledCandidate = {
  header: string;
  code: string;
};

/**
 * Hierarchy descriptors (detail level H) to leave out of a facet choice
 * because a descriptor of any other detail level is in the same pool.
 * Empty when every descriptor is a hierarchy term: §5.2, the same last
 * resort as a base term.
 */
export function hierarchyDescriptorsHeldBack<T extends { code: string }>(
  cat: Catalogue,
  pool: readonly T[]
): T[] {
  const hierarchy = pool.filter((candidate) => cat.term(candidate.code)?.detailLevel === "H");
  if (hierarchy.length === 0 || hierarchy.length === pool.length) return [];
  return hierarchy;
}

function withoutHierarchyDescriptors<T extends { code: string }>(
  cat: Catalogue,
  pool: readonly T[]
): { offered: T[]; heldBack: T[] } {
  const heldBack = hierarchyDescriptorsHeldBack(cat, pool);
  if (heldBack.length === 0) return { offered: [...pool], heldBack };
  const drop = new Set(heldBack.map((candidate) => candidate.code));
  return { offered: pool.filter((candidate) => !drop.has(candidate.code)), heldBack };
}

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
): Array<{ code: string; name: string; list: string; parent?: string; note?: string }> {
  return candidates.map(({ code, header }) => {
    const term = cat.term(code);
    const name = term?.name ?? code;
    const note = term?.scopeNote?.trim();
    const list = cat.facetCategory(header)?.label ?? header;
    const hierarchy = hierarchyFor(cat, header);
    const parentCode = hierarchy === null ? null : cat.parent(code, hierarchy);
    const parent =
      parentCode === null ? undefined : (cat.term(parentCode)?.name ?? parentCode);
    return {
      code,
      name,
      list,
      ...(parent !== undefined ? { parent } : {}),
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
    system: systemBranch(hasCountry(options)),
    user: JSON.stringify(
      {
        ...(options.food ? { description: options.food.input } : {}),
        ...countryField(options),
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

function facetAllowsMany(header: string): boolean {
  return facetCardinality(header)?.flag === "repeatable";
}

export function leafTerms(
  terms: ReadonlyArray<{ code: string; name: string; list: string; note?: string }>
): Array<{ code: string; label: string; note?: string }> {
  return terms.map(({ code, name, list, note }) => ({
    code,
    label: `${list}: ${name}`,
    ...(note !== undefined ? { note } : {}),
  }));
}

function parseMeaning(content: unknown): string | null {
  if (content === null || typeof content !== "object") return null;
  const raw = (content as { meaning?: unknown }).meaning;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

async function askSelect(
  phrase: string,
  terms: Array<{ code: string; name: string; list: string; parent?: string; note?: string }>,
  options: FacetWalkOptions,
  many = false
): Promise<{ codes: string[]; meaning: string | null; model: string }> {
  const allowed = new Set(terms.map((c) => c.code));
  if (options.originRole !== undefined && options.food !== undefined) {
    const picked = await chatJson({
      model: options.model,
      system:
        options.originRole === "made_from"
          ? systemSourceCommodityPick(hasCountry(options), many)
          : systemOriginPick(options.originRole, hasCountry(options), many),
      user: JSON.stringify(
        {
          food: options.food.input,
          baseTerm: { name: options.food.baseTerm, scope: options.food.baseScope },
          ...countryField(options),
          lookingFor: phrase,
          terms: terms.map(({ code, name, parent }) => ({
            code,
            name,
            ...(many && parent !== undefined ? { parent } : {}),
          })),
        },
        null,
        2
      ),
    });
    const codes = many
      ? pickAllowedCodes(picked.content, allowed)
      : (() => {
          const code = pickAllowedCode(picked.content, allowed);
          return code === null ? [] : [code];
        })();
    return { codes, meaning: null, model: picked.model };
  }
  const foodText = options.food?.food ?? options.food?.input;
  const picked = await chatJson({
    model: options.model,
    system: systemLeaf(hasCountry(options), many),
    user: JSON.stringify(
      {
        ...(foodText !== undefined ? { food: foodText } : {}),
        ...countryField(options),
        phrase,
        terms: leafTerms(terms),
      },
      null,
      2
    ),
  });
  const codes = many
    ? pickAllowedCodes(picked.content, allowed)
    : (() => {
        const code = pickAllowedCode(picked.content, allowed);
        return code === null ? [] : [code];
      })();
  return { codes, meaning: parseMeaning(picked.content), model: picked.model };
}

/**
 * Across facets: which of the candidate terms are true of the phrase.
 * A list marked single contributes at most one term.
 */
function systemStatedFacets(withCountry: boolean): string {
  return `You are an expert in food classification.

Your given inputs:
- \`description\`: the food being coded.
- \`phrase\`: one thing that description says about that food.
- \`terms\`: catalogue terms that may be true of the phrase. Each has a \`code\`, a \`name\`, the \`list\` it belongs to and, for some, a \`note\`. \`single\` is true when that list can contribute only one term.
${countryParagraph(withCountry, "description")}
Your task is to decide which terms, if any, are true of the phrase. From a list with \`single\` true, include at most one term.

Reply with JSON only, listing the codes of those terms, or an empty list if there are none:
{"codes":["<code>",...]}
`;
}

export async function selectStatedFacet(
  phrase: string,
  terms: Array<{ code: string; name: string; list: string; note?: string; single?: boolean }>,
  options: { model: string; description: string; country?: string | null }
): Promise<{ codes: string[]; model: string }> {
  const allowed = new Set(terms.map((t) => t.code));
  const country = options.country ?? null;
  const withCountry = country !== null && country !== "";
  const picked = await chatJson({
    model: options.model,
    system: systemStatedFacets(withCountry),
    user: JSON.stringify(
      {
        description: options.description,
        ...(withCountry ? { country } : {}),
        phrase,
        terms,
      },
      null,
      2
    ),
  });
  return { codes: pickAllowedCodes(picked.content, allowed), model: picked.model };
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
function systemPickFacets(withCountry: boolean): string {
  return `You are an expert in food classification.

You are given the following inputs:
- \`description\`: the food's full description.
- \`phrase\`: a part of that description.
- \`facets\`: candidate facets, each with a \`code\`, a \`name\`, and what it \`covers\`.
${countryParagraph(withCountry, "description")}
Each facet is one attribute of a food, such as how it was processed or what it is packed in. Your task is to decide which facets the phrase states a value for.

Reply with JSON only, listing the codes, or an empty list if it states a value for none:
{"codes":["<code>",...]}
`;
}

/** A picker option that is not a Facets dimension (routed by the caller). */
export type FacetPickExtra = { code: string; name: string; covers: string };

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
  const facets: Array<{ code: string; name: string; covers: string }> = [
    ...extras.map(({ code, name, covers }) => ({ code, name, covers })),
  ];
  for (const d of walkable) {
    const hierarchy = hierarchyFor(cat, d.header);
    if (hierarchy === null) continue;
    const childNames = childCodes(cat, hierarchy, "root", d.header, options.accept).map(
      (c) => cat.term(c)?.name ?? c
    );
    /** Nothing under it to walk, so nothing it could place. */
    if (childNames.length === 0) continue;
    facets.push({ code: d.header, name: d.name, covers: childNames.join("; ") });
  }
  /** pickAllowedCodes upper-cases replies; extras' codes need not be upper case. */
  const byUpper = new Map(facets.map((c) => [c.code.toUpperCase(), c.code]));
  const allowed = new Set(byUpper.keys());
  const picked = await chatJson({
    model: options.model,
    system: systemPickFacets(hasCountry(options)),
    user: JSON.stringify(
      {
        ...(options.food ? { description: options.food.input } : {}),
        ...countryField(options),
        phrase,
        facets,
      },
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

/**
 * Nearest hits that belong to one facet, in the order given (nearest first).
 * A hit the walk would not record is skipped.
 */
export function nearestFacetSeeds(
  cat: Catalogue,
  header: string,
  hits: readonly { code: string; similarity: number }[],
  accept: ((header: string, code: string) => boolean) | undefined,
  limit: number
): RecalledCandidate[] {
  const hierarchy = hierarchyFor(cat, header);
  if (hierarchy === null || limit <= 0) return [];
  const out: RecalledCandidate[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (seen.has(hit.code)) continue;
    seen.add(hit.code);
    if (cat.isDeprecated(hit.code)) continue;
    if (!cat.belongsTo(hit.code, hierarchy)) continue;
    if (accept !== undefined && !accept(header, hit.code)) continue;
    out.push({ header, code: hit.code });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Facet-index hits for one header. The index is built for every facet; the
 * process walk is the one that consults it. A missing index adds nothing.
 */
async function recallEmbeddingSeeds(
  cat: Catalogue,
  phrase: string,
  header: string,
  options: FacetWalkOptions,
  steps: WalkStep[]
): Promise<RecalledCandidate[]> {
  if (!vectorIndexAvailable("facets")) {
    steps.push({ via: "embedding_seeds", header, skipped: true, reason: "index_missing" });
    return [];
  }
  const hierarchy = hierarchyFor(cat, header);
  if (hierarchy === null) return [];
  const hits = await vectorSearchFacets(
    phrase,
    PROCESS_EMBEDDING_SCAN,
    (code) => cat.belongsTo(code, hierarchy) && !cat.isDeprecated(code)
  );
  const seeds = nearestFacetSeeds(
    cat,
    header,
    hits,
    options.accept,
    PROCESS_EMBEDDING_SEED_LIMIT
  );
  steps.push({
    via: "embedding_seeds",
    header,
    codes: seeds.map((seed) => seed.code),
  });
  return seeds;
}

async function selectAmong(
  cat: Catalogue,
  phrase: string,
  pool: RecalledCandidate[],
  options: FacetWalkOptions,
  steps: WalkStep[],
  via: string
): Promise<RecalledCandidate[]> {
  if (pool.length === 0) return [];
  const held = withoutHierarchyDescriptors(cat, pool);
  if (held.heldBack.length > 0) {
    steps.push({
      via: "hierarchy_held_back",
      dropped: held.heldBack.map((candidate) => candidate.code),
    });
  }
  pool = held.offered;
  if (pool.length === 1) {
    steps.push({
      via,
      sole: true,
      code: pool[0]!.code,
      header: pool[0]!.header,
    });
    return [pool[0]!];
  }

  const header = pool.every((c) => c.header === pool[0]!.header) ? pool[0]!.header : null;
  const many = header !== null && facetAllowsMany(header);
  const candidates = selectPayload(cat, pool);
  const picked = await askSelect(phrase, candidates, options, many);
  const found = picked.codes.flatMap((code) => {
    const match = pool.find((c) => c.code === code);
    return match === undefined ? [] : [match];
  });
  steps.push({
    via,
    candidates: candidates.map((c) => ({
      code: c.code,
      name: c.name,
      facet: c.list,
      ...(c.parent !== undefined ? { parent: c.parent } : {}),
      hasGuidance: c.note !== undefined,
    })),
    ...(picked.meaning !== null ? { meaning: picked.meaning } : {}),
    picked: many ? picked.codes : (picked.codes[0] ?? null),
    model: picked.model,
  });
  return found;
}

/**
 * Recall under every header, then one precision select over the union.
 */
export async function resolveFacetWalk(
  cat: Catalogue,
  phrase: string,
  headers: string[],
  options: FacetWalkOptions
): Promise<{
  facet: FacetDescriptorRef | null;
  facets: FacetDescriptorRef[];
  detail: Record<string, unknown>;
}> {
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

  if (tried.includes(F28)) {
    mergeRecalled(pool, await recallEmbeddingSeeds(cat, phrase, F28, options, steps));
  }

  steps.push({
    via: "recall_pool",
    count: pool.length,
    byHeader: tried.map((header) => ({
      header,
      count: pool.filter((c) => c.header === header).length,
    })),
  });

  const picked = await selectAmong(cat, phrase, pool, options, steps, "select");
  const facets: FacetDescriptorRef[] = picked.map((candidate) => ({
    header: candidate.header,
    code: candidate.code,
    name: cat.term(candidate.code)?.name ?? candidate.code,
  }));
  const facet = facets[0] ?? null;
  const resolved =
    facets.length === 0 ? null : facets.length === 1 ? facets[0]!.code : facets.map((f) => f.code);

  return {
    facet,
    facets,
    detail: {
      phrase,
      via: "facet_walk",
      headers: tried,
      resolved,
      ...(facet !== null ? { header: facet.header, name: facet.name } : {}),
      steps,
    },
  };
}
