/**
 * Base-term selection from a recall pool.
 *
 * Recall-stage SKOS match is audit only — it does not gate or score here.
 * Classify against the full input. Residuals also see that input.
 *
 * 1. One model pass: fit class per candidate (exact|broad|narrow|related|none).
 * 2. Prefer exact, else broad; related under a winning broad weighs with that
 *    shelf (same points) and joins the tightest-shelf pick.
 * 3. Shelf pick pool = winning broads + those related children (parents kept);
 *    the model picks the tightest kind-of cover when more than one.
 * 4. Otherwise within the winning class, C/E/P detail-level bonus may prefer a
 *    denser term; ties → deterministic tie-breaks (specificity, non-specific P,
 *    core/extended, code).
 * 5. pickKind / residual fit is the winning tier (exact|broad).
 */

import { Catalogue, DEFAULT_HIERARCHY } from "../catalogue.js";
import { assessSelectClassify, pickClosestParent } from "./select-classify.js";
import type {
  AuditEntry,
  BaseTermCandidate,
  BaseTermRef,
  CandidateFit,
  DescriptionKind,
  ScoredCandidate,
  SelectFit,
} from "./types.js";

/** Selectable fit classes, best first. */
export const SELECTABLE_FITS: SelectFit[] = ["exact", "broad"];

/** Fit class → points (higher is better). Used for ranking / audit. */
const FIT_POINTS: Record<CandidateFit, number> = {
  exact: 4,
  broad: 3,
  narrow: 2,
  related: 3,
  none: 0,
};

export function fitPoints(fit: CandidateFit | null | undefined): number {
  return fit === null || fit === undefined ? 0 : FIT_POINTS[fit];
}

/**
 * Bonus for Core (C), Extended (E), and Non-specific (P).
 * Applied only within the same selectable fit class.
 */
export const DETAIL_LEVEL_BONUS = 2;
const DETAIL_LEVELS = ["C", "E", "P"];

function detailLevelBonus(detailLevel: string | null | undefined): number {
  return detailLevel !== null && detailLevel !== undefined && DETAIL_LEVELS.includes(detailLevel)
    ? DETAIL_LEVEL_BONUS
    : 0;
}

/** Scoring rules as recorded on every select_pick audit entry. */
const SCORING_AUDIT = {
  fit: FIT_POINTS,
  selectable: SELECTABLE_FITS,
  detailLevelBonus: DETAIL_LEVEL_BONUS,
  detailLevels: DETAIL_LEVELS,
  detailBonusScope: "within_fit_class",
};

/** Fit points + detail bonus (for audit). Shortlist uses fit class first. */
export function selectScore(
  cat: Catalogue,
  code: string,
  fit: CandidateFit | null | undefined
): { score: number; fitPoints: number; detailLevelBonus: number } {
  const points = fitPoints(fit);
  const bonus = detailLevelBonus(cat.term(code)?.detailLevel ?? null);
  return { score: points + bonus, fitPoints: points, detailLevelBonus: bonus };
}

export interface SelectOptions {
  model?: string;
  /** How the route read the description; frames the classify system prompt. */
  descriptionKind?: DescriptionKind | null;
}

export interface SelectResult {
  /** Full recall pool after select classify (no recall SKOS gate). */
  pool: BaseTermCandidate[];
  scored: ScoredCandidate[];
  pick: BaseTermRef | null;
  /** Winner's fit class; residual routing uses this (no post-pick call). */
  pickKind: SelectFit | null;
  audit: AuditEntry[];
}

function isCoreOrExtended(detailLevel: string | null): boolean {
  return detailLevel === "C" || detailLevel === "E";
}

function descendantsInSet(
  cat: Catalogue,
  code: string,
  codes: Set<string>
): string[] {
  const out: string[] = [];
  for (const other of codes) {
    if (other !== code && cat.isAncestor(code, other, DEFAULT_HIERARCHY)) {
      out.push(other);
    }
  }
  return out;
}

/** Prefer exact, else broad. Empty if neither present. */
export function selectableFitTier(
  byCode: Map<string, CandidateFit>,
  pool: BaseTermCandidate[]
): { fit: SelectFit; codes: Set<string> } | null {
  for (const fit of SELECTABLE_FITS) {
    const codes = new Set(
      pool.filter((c) => (byCode.get(c.code) ?? "none") === fit).map((c) => c.code)
    );
    if (codes.size > 0) return { fit, codes };
  }
  return null;
}

/**
 * Related-fit candidates that sit under at least one of the broad shelf codes.
 * Used to reopen tightest-shelf pick when classify parked a cover as related.
 */
export function relatedUnderBroad(
  cat: Catalogue,
  byCode: Map<string, CandidateFit>,
  pool: BaseTermCandidate[],
  broadCodes: Set<string>
): BaseTermCandidate[] {
  return pool.filter((c) => {
    if ((byCode.get(c.code) ?? "none") !== "related") return false;
    if (broadCodes.has(c.code)) return false;
    for (const broad of broadCodes) {
      if (cat.isAncestor(broad, c.code, DEFAULT_HIERARCHY)) return true;
    }
    return false;
  });
}

/** Lower rank is better. Compared only among score-tied candidates. */
export function tieBreakRank(
  cat: Catalogue,
  candidate: BaseTermCandidate,
  shortlistCodes: Set<string>
): {
  rank: [number, number, number, string];
  moreSpecific: boolean;
  nonSpecific: boolean;
  coreOrExtended: boolean;
} {
  const term = cat.term(candidate.code);
  const detailLevel = term?.detailLevel ?? null;
  const moreSpecific =
    descendantsInSet(cat, candidate.code, shortlistCodes).length === 0;
  const nonSpecific = detailLevel === "P";
  const coreOrExtended = isCoreOrExtended(detailLevel);
  return {
    rank: [
      moreSpecific ? 0 : 1,
      nonSpecific ? 0 : 1,
      coreOrExtended ? 0 : 1,
      candidate.code,
    ],
    moreSpecific,
    nonSpecific,
    coreOrExtended,
  };
}

function compareTieBreak(
  a: [number, number, number, string],
  b: [number, number, number, string]
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[2] !== b[2]) return a[2] - b[2];
  return a[3].localeCompare(b[3]);
}

function toScored(
  cat: Catalogue,
  candidate: BaseTermCandidate,
  fit: CandidateFit | null,
  shortlisted: boolean,
  shortlistCodes: Set<string>,
  scoreParts: { score: number; fitPoints: number; detailLevelBonus: number }
): ScoredCandidate {
  const term = cat.term(candidate.code);
  const detailLevel = term?.detailLevel ?? null;
  const tb = tieBreakRank(cat, candidate, shortlistCodes);
  return {
    code: candidate.code,
    name: candidate.name,
    match: candidate.match,
    detailLevel,
    fit,
    score: scoreParts.score,
    fitPoints: scoreParts.fitPoints,
    detailLevelBonus: scoreParts.detailLevelBonus,
    shortlisted,
    ...(shortlisted
      ? {
          tieBreak: {
            moreSpecific: tb.moreSpecific,
            nonSpecific: tb.nonSpecific,
            coreOrExtended: tb.coreOrExtended,
          },
        }
      : {}),
  };
}

export async function scoreTraversalCandidates(
  input: string,
  candidates: BaseTermCandidate[],
  options: SelectOptions = {}
): Promise<SelectResult> {
  const cat = Catalogue.load();
  const audit: AuditEntry[] = [];

  audit.push({
    step: "select_start",
    detail: {
      input,
      candidateCount: candidates.length,
    },
  });

  const pool = candidates;

  if (pool.length === 0) {
    return {
      pool,
      scored: [],
      pick: null,
      pickKind: null,
      audit,
    };
  }

  const assessed = await assessSelectClassify(input, pool, options);
  audit.push(...assessed.audit);
  const byCode = assessed.byCode;

  const scores = new Map(
    pool.map((c) => {
      const fit = byCode.get(c.code) ?? "none";
      const parts = selectScore(cat, c.code, fit);
      return [c.code, parts] as const;
    })
  );

  const tier = selectableFitTier(byCode, pool);
  if (tier === null) {
    const scored = pool
      .map((candidate) =>
        toScored(
          cat,
          candidate,
          byCode.get(candidate.code) ?? "none",
          false,
          new Set(),
          scores.get(candidate.code)!
        )
      )
      .sort((a, b) => {
        const af = a.fitPoints ?? 0;
        const bf = b.fitPoints ?? 0;
        if (bf !== af) return bf - af;
        return a.code.localeCompare(b.code);
      });
    audit.push({
      step: "select_pick",
      detail: {
        reason: "no_exact_or_broad",
        scoring: SCORING_AUDIT,
        pick: null,
        scored,
      },
    });
    return { pool, scored, pick: null, pickKind: null, audit };
  }

  const tierPool = pool.filter((c) => tier.codes.has(c.code));
  const promotedRelated =
    tier.fit === "broad"
      ? relatedUnderBroad(cat, byCode, pool, tier.codes)
      : [];
  // Do not densify: related children must not drop their broad parent before
  // the model sees the pool. The parent-pick prompt decides the cover.
  const shelfPickPool =
    promotedRelated.length > 0 ? [...tierPool, ...promotedRelated] : tierPool;

  let shortlistCodes: Set<string>;
  let shortlist: BaseTermCandidate[];
  let maxScore: number;
  let parentPickVia: "model" | "tie_break" | null = null;

  if (tier.fit === "broad" && shelfPickPool.length > 1) {
    const parentPick = await pickClosestParent(input, shelfPickPool, options);
    audit.push(...parentPick.audit);
    const chosen =
      parentPick.code !== null
        ? shelfPickPool.find((c) => c.code === parentPick.code) ?? null
        : null;
    if (chosen !== null) {
      shortlistCodes = new Set([chosen.code]);
      shortlist = [chosen];
      maxScore = scores.get(chosen.code)!.score;
      parentPickVia = "model";
    } else {
      // Model abstained — prefer winning broads still in the pool, not related
      // siblings that densest/tie-break would otherwise elevate.
      const broadInPool = shelfPickPool.filter((c) => tier.codes.has(c.code));
      const fallback =
        broadInPool.length > 0 ? broadInPool : shelfPickPool;
      shortlistCodes = new Set(fallback.map((c) => c.code));
      shortlist = [...fallback].sort((a, b) =>
        compareTieBreak(
          tieBreakRank(cat, a, shortlistCodes).rank,
          tieBreakRank(cat, b, shortlistCodes).rank
        )
      );
      maxScore = scores.get(shortlist[0]!.code)!.score;
      parentPickVia = "tie_break";
    }
  } else if (tier.fit === "broad" && shelfPickPool.length === 1) {
    const only = shelfPickPool[0]!;
    shortlistCodes = new Set([only.code]);
    shortlist = [only];
    maxScore = scores.get(only.code)!.score;
  } else {
    maxScore = Math.max(...tierPool.map((c) => scores.get(c.code)!.score));
    shortlistCodes = new Set(
      tierPool.filter((c) => scores.get(c.code)!.score === maxScore).map((c) => c.code)
    );
    shortlist = pool.filter((c) => shortlistCodes.has(c.code));
    shortlist.sort((a, b) =>
      compareTieBreak(
        tieBreakRank(cat, a, shortlistCodes).rank,
        tieBreakRank(cat, b, shortlistCodes).rank
      )
    );
  }

  const pickCandidate = shortlist[0] ?? null;

  const scored = pool
    .map((candidate) =>
      toScored(
        cat,
        candidate,
        byCode.get(candidate.code) ?? "none",
        shortlistCodes.has(candidate.code),
        shortlistCodes,
        scores.get(candidate.code)!
      )
    )
    .sort((a, b) => {
      const af = a.fitPoints ?? 0;
      const bf = b.fitPoints ?? 0;
      if (bf !== af) return bf - af;
      const ds = (b.score ?? 0) - (a.score ?? 0);
      if (ds !== 0) return ds;
      return a.code.localeCompare(b.code);
    });

  const pick =
    pickCandidate === null
      ? null
      : { code: pickCandidate.code, name: pickCandidate.name };

  audit.push({
    step: "select_pick",
    detail: {
      scoring: SCORING_AUDIT,
      winningFit: tier.fit,
      maxScore,
      tierSize: tier.codes.size,
      ...(promotedRelated.length > 0
        ? {
            promotedRelated: promotedRelated.map((c) => ({
              code: c.code,
              name: c.name,
            })),
            shelfPickPool: shelfPickPool.map((c) => ({
              code: c.code,
              name: c.name,
            })),
          }
        : {}),
      ...(parentPickVia !== null ? { parentPickVia } : {}),
      shortlist: shortlist.map((c) => ({ code: c.code, name: c.name })),
      tieBreakOrder: [
        "more_specific",
        "non_specific",
        "core_or_extended",
        "code",
      ],
      pick,
      scored,
    },
  });

  return {
    pool,
    scored,
    pick,
    pickKind: pick === null ? null : tier.fit,
    audit,
  };
}
