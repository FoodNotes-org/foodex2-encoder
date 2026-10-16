/**
 * The "look up a term" interface the coding rules run against. The encoder
 * backs it with data/catalogue.json; the FoodEx2 Atlas with its KV term records.
 */

export interface RuleTermHierarchy {
  /** Ancestors from the top of the hierarchy down to the parent. */
  ancestors: string[];
  reportable: boolean;
}

export interface RuleTerm {
  code: string;
  name: string;
  scopeNote: string | null;
  /** MTX termType value: n, r, d, s, c, g, f. */
  termType: string | null;
  /** MTX detailLevel value: C, E, F, H, M, P. */
  detailLevel: string | null;
  /** APPROVED, DEPRECATED or PRELIMINARY. */
  status: string;
  /** Implied facet descriptors (declared and inherited), as "F27.A000M". */
  implied: string[];
  /** Membership per hierarchy code; absent means not in that hierarchy. */
  hierarchies: Record<string, RuleTermHierarchy>;
  /**
   * EFSA's "dismissed" in the Reporting hierarchy: not reportable, not
   * deprecated, and nothing reportable and non-deprecated beneath it.
   */
  dismissed: boolean;
}

export interface RuleFacetCategory {
  code: string;
  /** Hierarchy holding this facet's descriptors, e.g. "process" for F28. */
  hierarchy: string;
}

export interface TermLookup {
  term(code: string): RuleTerm | undefined;
  facet(code: string): RuleFacetCategory | undefined;
}

export interface ConflictSide {
  source: string;
  says: string;
}

export interface ConflictRef {
  id: string;
  topic: string;
  sources: ConflictSide[];
  verdict: string;
  why: string;
  /** The verdict is a FoodNotes interpretation rather than an EFSA source. */
  ours: boolean;
}

export interface Finding {
  severity: "error" | "warning";
  /** EFSA business rule ID (e.g. "BR25") or one of ours (e.g. "implied-contradiction"). */
  rule: string;
  /**
   * Whose rule this is: an EFSA business rule, EFSA guidance wording, or a
   * FoodNotes interpretation.
   */
  by: "EFSA business rule" | "EFSA guidance" | "FoodNotes";
  message: string;
  /** Term codes the finding is about. */
  terms: string[];
  conflict?: ConflictRef;
}

export interface ParsedFacet {
  facet: string;
  code: string;
}

export interface ParsedCode {
  input: string;
  base: string | null;
  facets: ParsedFacet[];
  problems: string[];
}
