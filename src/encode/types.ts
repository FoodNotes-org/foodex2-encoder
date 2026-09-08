/**
 * JSON shapes for encode results.
 *
 * `EncodeResult` is the full internal record (candidates, scored, audit, walks)
 * used by eval, the CLI, and (later) explanation. `EncodeUserResult` is what
 * chat clients see — code, base term, facets, free text, fit, method.
 */

export type EncodeMethod = "lexical" | "traversal";

export interface BaseTermRef {
  code: string;
  name: string;
}

/** An added facet descriptor (never an implicit of the base). */
export interface FacetDescriptorRef {
  header: string;
  code: string;
  name: string;
}

/**
 * A residual fact the FoodEx2 code cannot express.
 * `label` is a role (e.g. "dish"), not a facet header — free text is
 * outside the code, but unlabeled values lose meaning.
 */
export interface FreeTextEntry {
  label: string;
  value: string;
}

/** How the walk judged a term's set against the description's. */
export type CandidateMatch = "exact" | "broad" | "narrow" | "related";

/**
 * How to read the whole description (routed once; reused in traversal + residuals).
 * Asked for every input — single foodstuff and multi-part alike.
 */
export type DescriptionKind =
  | "foodstuff"
  | "dish"
  | "dish_type"
  | "mix"
  | "ingredients";

export interface BaseTermCandidate {
  code: string;
  name: string;
  match: CandidateMatch;
}

export interface ScoredCandidate {
  code: string;
  name: string;
  match: CandidateMatch;
  detailLevel: string | null;
  /** Select-stage fit class (SKOS-aligned labels; judged independently of recall). */
  fit: CandidateFit | null;
  /** Fit-class points + C/E/P detail-level bonus (within class). */
  score?: number;
  fitPoints?: number;
  detailLevelBonus?: number;
  /** True when this candidate was in the winning fit-class shortlist. */
  shortlisted: boolean;
  /** Deterministic tie-break flags when shortlisted. */
  tieBreak?: {
    moreSpecific: boolean;
    /** detailLevel P (Non-specific term). */
    nonSpecific: boolean;
    coreOrExtended: boolean;
  };
}

/**
 * SKOS-style relation between one food and one catalogue term, as answered on
 * the classify ladder (classify-ladder.ts). Recall records it as `match`,
 * selection as `fit`.
 */
export type LadderLabel = "exact" | "broad" | "narrow" | "related" | "none";

/**
 * Select-stage fit for a pool candidate (and residual routing on the pick).
 * Same labels as recall; judged afresh over the full pool.
 * - exact / broad: selectable; broad gates F26 Other / foodstuff name meaning
 * - narrow / related / none: not selectable (v1); diagnostic on the pool
 */
export type CandidateFit = LadderLabel;

/** Fit on the locked base after select (only exact|broad are picked). */
export type SelectFit = "exact" | "broad";

export interface AuditEntry {
  step: string;
  detail: Record<string, unknown>;
}

export interface EncodeOk {
  status: "ok";
  baseTerm: BaseTermRef;
  method: EncodeMethod;
  /** Select-stage fit of the locked base (exact | broad). Broad may follow a tightest-shelf pick. */
  fit?: SelectFit;
  /**
   * Phrase residuals treat as the food name (full input). Kept for dish essence /
   * dish= identity and foodstuff name-meaning.
   */
  food?: string;
  /** From the traversal route; residuals gate essence on dish / dish_type. */
  descriptionKind?: DescriptionKind | null;
  /** Added facet descriptors (implicits of the base are omitted). */
  facets?: FacetDescriptorRef[];
  /** Assembled FoodEx2 code: base, then #Fxx.CODE$Fxx.CODE… */
  code?: string;
  /** Residual facts the code does not express; null when none. */
  freeText?: FreeTextEntry[] | null;
  /** Candidates the walk collected when method is traversal. */
  candidates?: BaseTermCandidate[];
  /** Candidates after select classify + tie-break when method is traversal. */
  scored?: ScoredCandidate[];
  /** How each recall walk ended (traversal only). */
  walks?: WalkSummary[];
  /** Every classify call in order (traversal only). */
  steps?: WalkStep[];
  audit: AuditEntry[];
}

export interface EncodeRejected {
  status: "rejected";
  reason: string;
  message: string;
  audit: AuditEntry[];
}

export type EncodeResult = EncodeOk | EncodeRejected;

/**
 * What chat / MCP clients see. No audit, candidates, scored, or walk dump.
 * Built with `toUserEncodeResult`.
 */
export interface EncodeUserOk {
  status: "ok";
  code: string;
  baseTerm: BaseTermRef;
  facets: FacetDescriptorRef[];
  freeText: FreeTextEntry[];
  fit: SelectFit | null;
  method: EncodeMethod;
  /** Short prose account of how the code was reached (chat-safe). */
  explanation: string[];
}

export interface EncodeUserRejected {
  status: "rejected";
  message: string;
}

export type EncodeUserResult = EncodeUserOk | EncodeUserRejected;

/** Route verdict: one food, or a multi-part description (dish with parts, item + qualifiers). */
export type WholeItemKind = "single" | "multi";

/** Recall walk: the whole input against the exposure tree. */
export type WalkKind = "whole_item";

/** One classify call on a walk: the parent asked about and how each child matched. */
export interface WalkStep {
  walk: WalkKind;
  parent: string;
  classifications: Array<{ code: string; name: string; match: LadderLabel }>;
}

/** How one walk ended. */
export interface WalkSummary {
  walk: WalkKind;
  /** Text the classifier compared terms against. */
  compareAs: string;
  /** partial: stopped early on a provider failure; skipped: never classified anything. */
  status: "completed" | "partial" | "skipped";
  reason?: string;
  classifySteps: number;
}

export interface TraverseCollectResult {
  candidates: BaseTermCandidate[];
  wholeItem: WholeItemKind;
  /** From the route; null if the model omitted or returned an unknown value. */
  descriptionKind: DescriptionKind | null;
  walks: WalkSummary[];
  /** Every classify call in order, across walks. */
  steps: WalkStep[];
  audit: AuditEntry[];
}
