/**
 * Catalogue data access. Loads data/catalogue.json (built by
 * scripts/build-catalogue.py from MTX.ecf) once at startup.
 *
 * Hierarchy semantics mirror EFSA's Catalogue Browser (Term.java):
 * - a term is considered its own ancestor;
 * - reportability defaults to true unless the term carries an explicit
 *   reportable="false" assignment in that hierarchy;
 * - "dismissed" is derived: not reportable, not deprecated, and nothing
 *   usable (reportable, non-deprecated) anywhere in the sub-tree.
 *
 * This experiment uses the **exposure** hierarchy (EFSA rev2 §3.2.3) for
 * base-term search and traversal — consumption-oriented food groups, not the
 * MTX master tree (Plant commodities / RPC, etc.).
 */

import { readDataText } from "./data.js";

/** Exposure hierarchy — food-section grouping for search and traversal. */
export const DEFAULT_HIERARCHY = "expo";

/** Parent key for top-level exposure groups in catalogue.json. */
export const EXPO_ROOT = "root";

/** MTX termType flag values (FoodEx2 Guidance rev 2, Table 12). */
export const TERM_TYPE_LABELS: Record<string, string> = {
  n: "Natural source",
  r: "Raw primary commodity (RPC)",
  d: "RPC derivative / ingredient",
  s: "Composite food (simple)",
  c: "Composite food (aggregated)",
  g: "Broad or mixed term",
  f: "Facet descriptor",
};

/** MTX detailLevel (corex) flag values. */
export const DETAIL_LEVEL_LABELS: Record<string, string> = {
  C: "Core term",
  E: "Extended term",
  F: "Facet descriptor",
  H: "Hierarchy term",
  M: "Generic term",
  P: "Non-specific term",
};

/**
 * A term preferred as a base term: reportable in the exposure hierarchy and not
 * a hierarchy term (Corex H). EFSA §5.2 discourages hierarchy terms but allows
 * them as a last resort when nothing more specific fits.
 */
export function isBaseCandidate(term: CatalogueTerm): boolean {
  if (term.detailLevel === "H") return false;
  return DEFAULT_HIERARCHY in term.hierarchies && term.hierarchies[DEFAULT_HIERARCHY]?.[1] === true;
}

/** Term belongs to the exposure food tree (has an expo assignment). */
export function isInExposureTree(term: CatalogueTerm): boolean {
  return DEFAULT_HIERARCHY in term.hierarchies;
}

export interface FacetCategory {
  label: string | null;
  /** Hierarchy code the descriptors of this category live in, e.g. "process". */
  hierarchyCode: string;
  cardinality: "single" | "repeatable";
  scopeNote: string | null;
}

export interface CatalogueTerm {
  name: string | null;
  termType: string | null;
  detailLevel: string | null;
  scopeNote: string | null;
  /** Normalized implicit facets the term itself declares, e.g. ["F27.A000M"]. */
  implicitFacets: string[];
  /**
   * Index into `inheritedFacetSets`. Absent when none. Use
   * `Catalogue.inheritedFacets`.
   */
  inherited?: number;
  /** hierarchyCode -> [parentCode, reportable] */
  hierarchies: Record<string, [string | null, boolean]>;
  /** Absent means APPROVED. */
  status?: string;
}

export interface CatalogueData {
  catalogue: string;
  version: string;
  facetCategories: Record<string, FacetCategory>;
  inheritedFacetSets: string[];
  terms: Record<string, CatalogueTerm>;
}

export class Catalogue {
  private childrenIndex = new Map<string, Map<string, string[]>>();
  private altNameTable: Record<string, string[]> | null = null;

  private constructor(readonly data: CatalogueData) {}

  private static instance: Catalogue | null = null;

  static load(): Catalogue {
    if (Catalogue.instance === null) {
      const data = JSON.parse(readDataText("catalogue.json")) as CatalogueData;
      if (!Array.isArray(data.inheritedFacetSets)) {
        throw new Error(
          "data/catalogue.json predates inherited implicit facets — run npm run build:catalogue"
        );
      }
      Catalogue.instance = new Catalogue(data);
    }
    return Catalogue.instance;
  }

  get version(): string {
    return this.data.version;
  }

  get termCount(): number {
    return Object.keys(this.data.terms).length;
  }

  term(code: string): CatalogueTerm | undefined {
    return this.data.terms[code];
  }

  facetCategory(category: string): FacetCategory | undefined {
    return this.data.facetCategories[category];
  }

  inheritedFacets(term: CatalogueTerm): string[] {
    if (term.inherited === undefined) return [];
    return (this.data.inheritedFacetSets[term.inherited] ?? "").split("$");
  }

  /** Declared plus inherited implicit facets (what a coder must not restate). */
  impliedFacets(code: string): string[] {
    const term = this.term(code);
    if (term === undefined) return [];
    return [...term.implicitFacets, ...this.inheritedFacets(term)].sort();
  }

  isDeprecated(code: string): boolean {
    return this.term(code)?.status === "DEPRECATED";
  }

  /** Alternative names (common, short, scientific) from data/search-names.json. */
  altNames(code: string): string[] {
    return this.altNamesByCode()[code] ?? [];
  }

  /** Every term that has alternative names, with those names. */
  altNameEntries(): Array<[string, string[]]> {
    return Object.entries(this.altNamesByCode());
  }

  private altNamesByCode(): Record<string, string[]> {
    if (this.altNameTable === null) {
      this.altNameTable = JSON.parse(readDataText("search-names.json")) as Record<
        string,
        string[]
      >;
    }
    return this.altNameTable;
  }

  belongsTo(code: string, hierarchy: string): boolean {
    const term = this.term(code);
    return term !== undefined && hierarchy in term.hierarchies;
  }

  parent(code: string, hierarchy: string): string | null {
    const parent = this.term(code)?.hierarchies[hierarchy]?.[0];
    return parent === undefined || parent === "root" ? null : parent;
  }

  /** True if `ancestor` is at or above `descendant` (a term is its own ancestor). */
  isAncestor(ancestor: string, descendant: string, hierarchy: string): boolean {
    const seen = new Set<string>();
    let current: string | null = descendant;
    while (current !== null && !seen.has(current)) {
      if (current === ancestor) return true;
      seen.add(current);
      current = this.parent(current, hierarchy);
    }
    return false;
  }

  isReportable(code: string, hierarchy: string): boolean {
    const assignment = this.term(code)?.hierarchies[hierarchy];
    return assignment === undefined ? true : assignment[1];
  }

  children(code: string, hierarchy: string): string[] {
    let index = this.childrenIndex.get(hierarchy);
    if (index === undefined) {
      index = new Map();
      for (const [termCode, term] of Object.entries(this.data.terms)) {
        const parent = term.hierarchies[hierarchy]?.[0];
        if (parent === undefined || parent === null) continue;
        const siblings = index.get(parent);
        if (siblings === undefined) index.set(parent, [termCode]);
        else siblings.push(termCode);
      }
      this.childrenIndex.set(hierarchy, index);
    }
    return index.get(code) ?? [];
  }

  /** Direct children of the exposure hierarchy (Table 15 top-level groups). */
  exposureTopLevel(): string[] {
    return this.children(EXPO_ROOT, DEFAULT_HIERARCHY);
  }

  /**
   * Derived dismissal (mirrors Term.isDismissed): not reportable, not
   * deprecated, and nothing usable hangs beneath it.
   */
  isDismissed(code: string, hierarchy: string): boolean {
    const term = this.term(code);
    if (term === undefined) return false;
    if (this.isReportable(code, hierarchy) || term.status === "DEPRECATED") {
      return false;
    }
    const stack = [...this.children(code, hierarchy)];
    const seen = new Set<string>(stack);
    while (stack.length > 0) {
      const child = stack.pop() as string;
      if (this.isReportable(child, hierarchy) && !this.isDeprecated(child)) {
        return false;
      }
      for (const grandchild of this.children(child, hierarchy)) {
        if (!seen.has(grandchild)) {
          seen.add(grandchild);
          stack.push(grandchild);
        }
      }
    }
    return true;
  }
}
