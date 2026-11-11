/**
 * Source facet (F01) as a walk of the natural-source tree.
 *
 * Name search only chooses where the walk enters. An exact child is the
 * source. When no child is exact, a broad child is opened. When no child is
 * exact or broad, the broad group we are standing in is the source.
 */

import { chatJson } from "../llm.js";
import { Catalogue } from "../catalogue.js";
import { impliedRelation } from "../rules/index.js";
import { catalogueLookup } from "../rules/catalogue-lookup.js";
import { searchTerms } from "../search/lexical.js";
import { vectorIndexAvailable, vectorSearchBase } from "../search/vector.js";
import { parseClassifications } from "./answers.js";
import { LADDER_LABELS } from "./classify-ladder.js";
import type { FacetDescriptorRef } from "./types.js";
import type { LadderLabel } from "./types.js";

const SOURCE = "source";
const F01 = "F01";
const BATCH = 40;
const CLIMB_LIMIT = 6;

export type SourceVisit = "root" | "seed" | "broad";

/**
 * What one level of the source walk does with the ladder.
 * `nodeIsBroad` is true when this group was reached because it is a hypernym
 * of the organism, including a name-search entry that was judged broad.
 */
export function chooseSourceLevel(
  visit: SourceVisit,
  nodeIsBroad: boolean,
  children: ReadonlyArray<{ code: string; match: LadderLabel }>
): { exact: string[]; descend: string[]; useNode: boolean } {
  const exact = children.filter((child) => child.match === "exact").map((child) => child.code);
  if (exact.length > 0) return { exact, descend: [], useNode: false };
  const descend = children.filter((child) => child.match === "broad").map((child) => child.code);
  if (descend.length > 0) return { exact: [], descend, useNode: false };
  return { exact: [], descend: [], useNode: visit !== "root" && nodeIsBroad };
}

export function systemSourceMatch(): string {
  return `You are an expert in food classification.

Your task is to match a food source against source terms in a food catalogue.

You are given:
- \`lookingFor\`: the food source.
- \`country\`: the country from which the food source is reported.
- \`terms\`: the source terms to judge. Each has a \`code\` and a \`name\`. A term that has children also has \`directSubcategories\`. A term that has a scope note also has \`note\`.
- \`parent\`: the source group these terms sit under.

Compare \`lookingFor\` with the class the term denotes. Use the term's name and, when present, its \`directSubcategories\` and its \`note\`.

For each term, assign one match.
- exact: in the nomenclature of \`country\`, \`lookingFor\` denotes this term and no source outside it
- broad: in that nomenclature, this term contains every source \`lookingFor\` can denote, and it contains other sources too
- narrow: in that nomenclature, \`lookingFor\` can denote this term, and it can also denote a source outside this term
- related: associated, and neither is a hypernym or a hyponym of the other
- none: none of the above

Reply with JSON only:
{"classifications":[{"code":"<code>","match":"exact|broad|narrow|related|none"}, ...]}
`;
}

function sourceChildren(cat: Catalogue, parent: string): string[] {
  return cat.children(parent, SOURCE).filter((code) => !cat.isDeprecated(code));
}

function termView(cat: Catalogue, code: string): Record<string, unknown> {
  const term = cat.term(code);
  const children = sourceChildren(cat, code).map((child) => cat.term(child)?.name ?? child);
  const note = term?.scopeNote?.trim() ?? "";
  return {
    code,
    name: term?.name ?? code,
    ...(children.length > 0 ? { directSubcategories: children.slice(0, 40) } : {}),
    ...(note !== "" ? { note } : {}),
  };
}

function lexicalSourceHits(phrase: string): string[] {
  const text = phrase.trim().toLowerCase();
  if (text === "") return [];
  return searchTerms(text, { limit: 20, descriptorsOnly: true, facetCategory: F01 }).map(
    (hit) => hit.code
  );
}

async function embeddingSourceHits(cat: Catalogue, phrase: string): Promise<string[]> {
  if (!vectorIndexAvailable("base")) return [];
  const hits = await vectorSearchBase(phrase, 8);
  return hits.map((hit) => hit.code).filter((code) => cat.belongsTo(code, SOURCE));
}

function recordable(cat: Catalogue, code: string, implied: Set<string>): boolean {
  if (!cat.belongsTo(code, SOURCE) || !cat.isReportable(code, SOURCE) || cat.isDeprecated(code)) {
    return false;
  }
  const relation = impliedRelation(catalogueLookup(cat), F01, code, [...implied]);
  return relation === "none" || relation === "narrower";
}

async function matchSourceTerms(
  cat: Catalogue,
  model: string,
  system: string,
  lookingFor: string,
  parentName: string,
  codes: string[],
  country: string | null
): Promise<Map<string, LadderLabel>> {
  const out = new Map<string, LadderLabel>();
  const batches: string[][] = [];
  for (let i = 0; i < codes.length; i += BATCH) batches.push(codes.slice(i, i + BATCH));
  const parts = await Promise.all(
    batches.map(async (batch) => {
      const allowed = new Set(batch);
      const replied = await chatJson({
        model,
        system,
        user: JSON.stringify(
          {
            lookingFor,
            ...(country !== null && country !== "" ? { country } : {}),
            parent: parentName,
            terms: batch.map((code) => termView(cat, code)),
          },
          null,
          2
        ),
      });
      return parseClassifications(replied.content, allowed, "match", LADDER_LABELS);
    })
  );
  for (const part of parts) {
    if (part === null) continue;
    for (const [code, match] of part) out.set(code, match);
  }
  return out;
}

function facetOf(cat: Catalogue, code: string): FacetDescriptorRef {
  return { header: F01, code, name: cat.term(code)?.name ?? code };
}

/**
 * Walk the source tree for the organism `phrase` names.
 * Name and embedding hits are entries into the tree, not the choice.
 */
export async function resolveSourceWalk(
  cat: Catalogue,
  phrase: string,
  options: {
    model: string;
    country: string | null;
    implied: Set<string>;
  }
): Promise<{ facet: FacetDescriptorRef | null; detail: Record<string, unknown> }> {
  const steps: Record<string, unknown>[] = [];
  const recall = [
    ...new Set([...lexicalSourceHits(phrase), ...(await embeddingSourceHits(cat, phrase))]),
  ].filter((code) => cat.belongsTo(code, SOURCE));
  const system = systemSourceMatch();
  const visited = new Set<string>();
  let exact: string | null = null;
  let ambiguous = false;
  const fallbacks: string[] = [];

  const queue: Array<{ code: string; visit: SourceVisit }> = [];
  let current: string | null = null;
  for (const hit of recall) {
    current = cat.parent(hit, SOURCE) ?? hit;
    for (let step = 0; step < CLIMB_LIMIT && current !== null && exact === null && !ambiguous; step++) {
      if (visited.has(current)) break;
      visited.add(current);
      const match = (await matchSourceTerms(
        cat,
        options.model,
        system,
        phrase,
        cat.parent(current, SOURCE) === null
          ? "Natural sources"
          : (cat.term(cat.parent(current, SOURCE)!)?.name ?? "Natural sources"),
        [current],
        options.country
      )).get(current) ?? "none";
      steps.push({ via: "seed", code: current, name: cat.term(current)?.name ?? current, match });
      if (match === "exact" && recordable(cat, current, options.implied)) {
        exact = current;
        break;
      }
      if (match === "broad") {
        queue.push({ code: current, visit: "broad" });
        break;
      }
      if (match !== "narrow") break;
      current = cat.parent(current, SOURCE);
    }
  }

  if (exact === null && !ambiguous && queue.length === 0) {
    for (const root of sourceChildren(cat, "root")) queue.push({ code: root, visit: "root" });
  }

  while (queue.length > 0 && exact === null && !ambiguous) {
    const wave = queue.splice(0, 4);
    const judged = await Promise.all(
      wave.map(async (node) => {
        if (visited.has(node.code) && node.visit !== "broad") return null;
        visited.add(node.code);
        const children = sourceChildren(cat, node.code);
        const labels = await matchSourceTerms(
          cat,
          options.model,
          system,
          phrase,
          cat.term(node.code)?.name ?? node.code,
          children,
          options.country
        );
        steps.push({
          via: "children",
          parent: node.code,
          name: cat.term(node.code)?.name ?? node.code,
          classifications: children.map((code) => ({
            code,
            name: cat.term(code)?.name ?? code,
            match: labels.get(code) ?? "none",
          })),
        });
        return {
          node,
          choice: chooseSourceLevel(
            node.visit,
            node.visit === "broad",
            children.map((code) => ({ code, match: labels.get(code) ?? "none" }))
          ),
        };
      })
    );
    const next: Array<{ code: string; visit: SourceVisit }> = [];
    for (const item of judged) {
      if (item === null) continue;
      const { exact: exacts, descend, useNode } = item.choice;
      if (exacts.length === 1 && recordable(cat, exacts[0]!, options.implied)) exact = exacts[0]!;
      else if (exacts.length > 1) ambiguous = true;
      else if (useNode && recordable(cat, item.node.code, options.implied)) fallbacks.push(item.node.code);
      else for (const child of descend) next.push({ code: child, visit: "broad" });
    }
    if (exact !== null || ambiguous) break;
    queue.push(...next);
  }

  const chosen = exact ?? (ambiguous ? null : deepest(cat, fallbacks));
  const facet = chosen !== null && recordable(cat, chosen, options.implied) ? facetOf(cat, chosen) : null;
  return {
    facet,
    detail: {
      phrase,
      via: "source_walk",
      header: F01,
      recall,
      resolved: facet?.code ?? null,
      ...(facet !== null ? { name: facet.name } : {}),
      ...(ambiguous ? { ambiguousExact: true } : {}),
      steps,
    },
  };
}

/**
 * Among the children of a commodity's implied source: one exact organism is
 * the source. Several exact matches are no choice. Broad children are opened,
 * not taken in list order.
 */
export function chooseCommoditySourceLevel(
  children: ReadonlyArray<{ code: string; match: LadderLabel }>
): { exact: string | null; descend: string[]; ambiguous: boolean } {
  const exact = children.filter((child) => child.match === "exact").map((child) => child.code);
  if (exact.length === 1) return { exact: exact[0]!, descend: [], ambiguous: false };
  if (exact.length > 1) return { exact: null, descend: [], ambiguous: true };
  return {
    exact: null,
    descend: children.filter((child) => child.match === "broad").map((child) => child.code),
    ambiguous: false,
  };
}

export function systemCommoditySource(): string {
  return `You are an expert in food classification.

Your task is to match an organism or other source against source terms in a food catalogue.

You are given:
- \`lookingFor\`: a food.
- \`country\`: the place whose food nomenclature \`lookingFor\` uses. Read \`lookingFor\` as understood there.
- \`parent\`: the source group these terms sit under.
- \`terms\`: the source terms to judge. Each has a \`code\` and a \`name\`. A term that has children also has \`directSubcategories\`. A term that has a scope note also has \`note\`.

Compare the organism \`lookingFor\` is from with the class the term denotes. Use the term's name and, when present, its \`directSubcategories\` and its \`note\`.

For each term, assign one match:
- exact: the term is that organism
- broad: the term is a broader class than that organism
- narrow: the term is a narrower class than that organism
- related: associated, and neither is a broader or a narrower class
- none: none of the above

Reply with JSON only:
{"classifications":[{"code":"<code>","match":"exact|broad|narrow|related|none"}, ...]}
`;
}

const COMMODITY_SOURCE_DEPTH = 4;

/**
 * The organism a single source commodity is from, when a child of the animal
 * or plant that commodity implies matches more tightly. The implied source
 * itself is not returned.
 */
export async function matchCommoditySource(
  cat: Catalogue,
  phrase: string,
  impliedSource: string,
  options: { model: string; country: string }
): Promise<{ facet: FacetDescriptorRef | null; detail: Record<string, unknown> }> {
  const steps: Record<string, unknown>[] = [];
  const system = systemCommoditySource();
  const visited = new Set<string>();
  const broadNodes: string[] = [];
  let exact: string | null = null;
  let ambiguous = false;
  let queue = [impliedSource];

  for (let depth = 0; depth < COMMODITY_SOURCE_DEPTH && queue.length > 0 && exact === null && !ambiguous; depth++) {
    const wave = queue;
    queue = [];
    for (const parent of wave) {
      if (visited.has(parent) || exact !== null || ambiguous) continue;
      visited.add(parent);
      const kids = sourceChildren(cat, parent);
      if (kids.length === 0) continue;
      const allowed = new Set(kids);
      const replied = await chatJson({
        model: options.model,
        system,
        user: JSON.stringify(
          {
            lookingFor: phrase,
            country: options.country,
            parent: cat.term(parent)?.name ?? parent,
            terms: kids.map((code) => termView(cat, code)),
          },
          null,
          2
        ),
      });
      const labels = parseClassifications(replied.content, allowed, "match", LADDER_LABELS);
      const judged = kids.map((code) => ({
        code,
        match: labels?.get(code) ?? "none",
      }));
      steps.push({
        parent,
        name: cat.term(parent)?.name ?? parent,
        classifications: judged.map((child) => ({
          ...child,
          name: cat.term(child.code)?.name ?? child.code,
        })),
      });
      const choice = chooseCommoditySourceLevel(judged);
      if (choice.ambiguous) ambiguous = true;
      else if (choice.exact !== null) exact = choice.exact;
      else {
        broadNodes.push(...choice.descend);
        queue.push(...choice.descend);
      }
    }
  }

  const chosen = exact ?? (ambiguous ? null : deepest(cat, broadNodes));
  const facet = chosen !== null ? facetOf(cat, chosen) : null;
  return {
    facet,
    detail: {
      phrase,
      impliedSource,
      via: "commodity_source",
      resolved: facet?.code ?? null,
      ...(facet !== null ? { name: facet.name } : {}),
      ...(ambiguous ? { ambiguousExact: true } : {}),
      steps,
    },
  };
}

function deepest(cat: Catalogue, codes: string[]): string | null {
  let best: string | null = null;
  let depth = -1;
  const seen = new Set<string>();
  for (const code of codes) {
    if (seen.has(code)) continue;
    seen.add(code);
    let current: string | null = code;
    let n = 0;
    const walked = new Set<string>();
    while (current !== null && !walked.has(current)) {
      walked.add(current);
      n += 1;
      current = cat.parent(current, SOURCE);
    }
    if (n > depth) {
      depth = n;
      best = code;
    }
  }
  return best;
}
