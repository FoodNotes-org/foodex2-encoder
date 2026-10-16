import type { Catalogue } from "../catalogue.js";
import { REPORTING_HIERARCHY } from "./check.js";
import type { RuleFacetCategory, RuleTerm, TermLookup } from "./types.js";

const lookups = new WeakMap<Catalogue, TermLookup>();

/** TermLookup backed by the encoder's catalogue (data/catalogue.json). */
export function catalogueLookup(cat: Catalogue): TermLookup {
  let lookup = lookups.get(cat);
  if (lookup === undefined) {
    lookup = createLookup(cat);
    lookups.set(cat, lookup);
  }
  return lookup;
}

function createLookup(cat: Catalogue): TermLookup {
  const cache = new Map<string, RuleTerm | undefined>();

  function ancestors(code: string, hierarchy: string): string[] {
    const chain: string[] = [];
    const seen = new Set<string>([code]);
    let current = cat.parent(code, hierarchy);
    while (current !== null && !seen.has(current)) {
      chain.unshift(current);
      seen.add(current);
      current = cat.parent(current, hierarchy);
    }
    return chain;
  }

  function build(code: string): RuleTerm | undefined {
    const term = cat.term(code);
    if (term === undefined) return undefined;
    return {
      code,
      name: term.name ?? code,
      scopeNote: term.scopeNote,
      termType: term.termType,
      detailLevel: term.detailLevel,
      status: term.status ?? "APPROVED",
      implied: cat.impliedFacets(code),
      hierarchies: Object.fromEntries(
        Object.entries(term.hierarchies).map(([h, [, reportable]]) => [
          h,
          { ancestors: ancestors(code, h), reportable },
        ])
      ),
      dismissed: cat.isDismissed(code, REPORTING_HIERARCHY),
    };
  }

  return {
    term(code) {
      if (!cache.has(code)) cache.set(code, build(code));
      return cache.get(code);
    },
    facet(code): RuleFacetCategory | undefined {
      const category = cat.facetCategory(code);
      return category === undefined ? undefined : { code, hierarchy: category.hierarchyCode };
    },
  };
}
