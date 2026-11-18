/**
 * Base-term selection from a recall pool.
 *
 * Recall-stage SKOS match is audit only — it does not gate or score here.
 * Classify against the full input. Residuals also see that input.
 *
 * 1. One model pass: fit class per candidate (exact|broad|narrow|related|none).
 * 2. Exact and broad are both shelves. A term that contains another accepted
 *    shelf is dropped. Narrow, related, and none stay on the audit.
 * 3. For a mix, a generic group the named foods share is the base when the
 *    walk already accepted it. A strict majority is enough when every food
 *    outside that group is a minor share.
 * 4. When more than one shelf remains, the model chooses the term that best
 *    describes the food. Stated process rules are shown beside the terms.
 *    Only when it gives no usable answer does fit, then detail level, then
 *    the deterministic tie-break decide. A process a term already carries
 *    does not decide.
 * 5. pickKind / residual fit is the chosen term's class (exact|broad).
 */

import { Catalogue, DEFAULT_HIERARCHY } from "../catalogue.js";
import { DEFAULT_COUNTRY_CODE, resolveCountry } from "../country.js";
import { chatJson, defaultModel } from "../llm.js";
import { contentTokens } from "../search/content-match.js";
import { assessSelectClassify, pickProductKind } from "./select-classify.js";
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
/**
 * A broad shelf that already carries a process. Once, however many processes
 * it lists. Larger than the detail bonus, so the process stands over core.
 */
export const PROCESS_BONUS = 3;
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
  /** Set only for a mix. The walk no longer decides a description kind. */
  descriptionKind?: DescriptionKind | null;
  /** English name of the country the description comes from. */
  country?: string | null;
  /** Words taken out of the input, each stating a treatment applied to it. */
  treatments?: readonly string[];
  /** Words taken out of the input, each stating parts it includes or leaves out. */
  parts?: readonly string[];
  /** Conditional table rule for each process the description states. */
  processes?: readonly { name: string; rule: string }[];
}

export interface SelectResult {
  /** Full recall pool after select classify (no recall SKOS gate). */
  pool: BaseTermCandidate[];
  scored: ScoredCandidate[];
  pick: BaseTermRef | null;
  /** Winner's fit class; residual routing uses this (no post-pick call). */
  pickKind: SelectFit | null;
  /**
   * Named foods outside the shared generic group, kept because each is a minor
   * share. Residuals record these as ingredients.
   */
  minorFoods?: string[];
  audit: AuditEntry[];
}

function isCoreOrExtended(detailLevel: string | null): boolean {
  return detailLevel === "C" || detailLevel === "E";
}

/** True when the term already carries a process, declared or inherited. */
export function carriesProcess(cat: Catalogue, code: string): boolean {
  return cat.impliedFacets(code).some((facet) => facet.startsWith("F28."));
}

/**
 * Score for choosing among broad shelves: fit, detail level, and one process
 * bonus. An exact match is scored without the process bonus.
 */
export function broadShelfScore(
  cat: Catalogue,
  code: string
): { score: number; fitPoints: number; detailLevelBonus: number; processBonus: number } {
  const points = fitPoints("broad");
  const detail = detailLevelBonus(cat.term(code)?.detailLevel ?? null);
  const process = carriesProcess(cat, code) ? PROCESS_BONUS : 0;
  return {
    score: points + detail + process,
    fitPoints: points,
    detailLevelBonus: detail,
    processBonus: process,
  };
}

/** The nearest generic group above `code` in the exposure hierarchy, or `code` itself when it is generic. */
export function nearestGenericGroup(cat: Catalogue, code: string): string | null {
  const seen = new Set<string>();
  let current: string | null = code;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    if (cat.term(current)?.detailLevel === "M") return current;
    current = cat.parent(current, DEFAULT_HIERARCHY);
  }
  return null;
}

/** True when every word of the catalogue name appears in the description. */
export function nameStatedIn(name: string, input: string): boolean {
  const nameTokens = contentTokens(name);
  const inputTokens = contentTokens(input);
  if (nameTokens.size === 0) return false;
  for (const token of nameTokens) if (!inputTokens.has(token)) return false;
  return true;
}

export interface SameNatureGroup {
  /** Generic group that contains every stated component, or a strict majority of them. */
  group: string;
  /** Stated components whose own generic group is a different one. */
  outside: string[];
}

/**
 * For a mix, the generic group of the foods the description names.
 * A food counts when selection called it related and its name is in the
 * description. The group has to be one the walk already called broad. A group
 * that contains only half, or that the walk did not accept, is no result.
 */
export function sameNatureGroup(
  cat: Catalogue,
  input: string,
  candidates: readonly { code: string; name: string; fit: CandidateFit | null }[],
  broadCodes: ReadonlySet<string>
): SameNatureGroup | null {
  const stated = candidates.filter(
    (candidate) => candidate.fit === "related" && nameStatedIn(candidate.name, input)
  );
  if (stated.length < 2) return null;

  const members = new Map<string, string[]>();
  for (const component of stated) {
    const generic = nearestGenericGroup(cat, component.code);
    if (generic === null) continue;
    const list = members.get(generic) ?? [];
    list.push(component.code);
    members.set(generic, list);
  }

  let best: { code: string; members: string[] } | null = null;
  for (const [code, list] of members) {
    if (best === null || list.length > best.members.length) best = { code, members: list };
  }
  if (best === null || best.members.length * 2 <= stated.length) return null;
  if (!broadCodes.has(best.code)) return null;

  return {
    group: best.code,
    outside: stated
      .filter((component) => !best.members.includes(component.code))
      .map((component) => component.code),
  };
}

export function systemMinorShare(): string {
  return `You are an expert in food classification.

Decide whether every food in \`foods\` makes up a minor share of the food product in \`description\`, compared to the other foods in it.

Given:
- \`description\`: the food product.
- \`country\`: the place whose food nomenclature \`description\` uses. Read \`description\` as understood there.
- \`foods\`: foods named in \`description\`.

Reply with JSON only:
{"minor":true|false}
`;
}

/** True only when the reply explicitly says every listed food is a minor share. */
export function parseMinorShare(content: unknown): boolean {
  if (content === null || typeof content !== "object") return false;
  return (content as { minor?: unknown }).minor === true;
}

function promptCountry(country: string | null | undefined): string {
  const given = country?.trim() ?? "";
  if (given !== "") return given;
  const resolved = resolveCountry(DEFAULT_COUNTRY_CODE);
  return resolved.ok ? resolved.name : "European Union";
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

/** The terms in `pool` that contain no other term in `pool`. */
export function narrowestTerms(
  cat: Catalogue,
  pool: readonly BaseTermCandidate[]
): BaseTermCandidate[] {
  const codes = new Set(pool.map((c) => c.code));
  return pool.filter((c) => descendantsInSet(cat, c.code, codes).length === 0);
}

/**
 * Exact and broad candidates, after a term that contains another of them is
 * dropped. Hierarchy terms already held back are left out.
 */
export function shelfCandidates(
  cat: Catalogue,
  pool: readonly BaseTermCandidate[],
  byCode: Map<string, CandidateFit>,
  heldBack: readonly string[]
): BaseTermCandidate[] {
  const held = new Set(heldBack);
  const accepted = pool.filter((candidate) => {
    const fit = byCode.get(candidate.code) ?? "none";
    return (fit === "exact" || fit === "broad") && !held.has(candidate.code);
  });
  return narrowestTerms(cat, accepted);
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
 * Accepted hierarchy terms (detail level H) to leave out because a term of any
 * other detail level was accepted too. Empty when only hierarchy terms fit.
 */
export function hierarchyTermsHeldBack(
  cat: Catalogue,
  byCode: Map<string, CandidateFit>,
  pool: BaseTermCandidate[]
): string[] {
  const accepted = pool.filter((c) =>
    (SELECTABLE_FITS as CandidateFit[]).includes(byCode.get(c.code) ?? "none")
  );
  const isHierarchy = (code: string) => cat.term(code)?.detailLevel === "H";
  if (accepted.every((c) => isHierarchy(c.code))) return [];
  return accepted.filter((c) => isHierarchy(c.code)).map((c) => c.code);
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
  scoreParts: {
    score: number;
    fitPoints: number;
    detailLevelBonus: number;
    processBonus?: number;
  }
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
    ...(scoreParts.processBonus !== undefined ? { processBonus: scoreParts.processBonus } : {}),
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
      return [c.code, selectScore(cat, c.code, fit)] as const;
    })
  );

  const hierarchyHeldBack = hierarchyTermsHeldBack(cat, byCode, pool);
  const shelves = shelfCandidates(cat, pool, byCode, hierarchyHeldBack);
  if (shelves.length === 0) {
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

  let shortlistCodes = new Set<string>();
  let shortlist: BaseTermCandidate[] = [];
  let maxScore = 0;
  let parentPickVia: "model" | "tie_break" | "narrowest" | "same_nature" | null = null;
  let shelfPool: BaseTermCandidate[] | null = null;
  let minorFoods: string[] | undefined;
  let winningFit: SelectFit = (byCode.get(shelves[0]!.code) ?? "broad") as SelectFit;

  const sameNature =
    options.descriptionKind === "mix" && shelves.every((candidate) => byCode.get(candidate.code) === "broad")
      ? sameNatureGroup(
          cat,
          input,
          pool.map((candidate) => ({
            code: candidate.code,
            name: candidate.name,
            fit: byCode.get(candidate.code) ?? null,
          })),
          new Set(
            pool.filter((candidate) => candidate.match === "broad").map((candidate) => candidate.code)
          )
        )
      : null;
  let sameNaturePick: BaseTermCandidate | null = null;
  if (sameNature !== null) {
    const group = pool.find((candidate) => candidate.code === sameNature.group) ?? null;
    const outside = sameNature.outside.flatMap((code) => {
      const name = pool.find((candidate) => candidate.code === code)?.name;
      return name === undefined ? [] : [name];
    });
    if (group !== null && outside.length === 0) {
      sameNaturePick = group;
    } else if (group !== null && outside.length > 0) {
      const country = promptCountry(options.country);
      const answered = await chatJson({
        model: options.model?.trim() || defaultModel(),
        system: systemMinorShare(),
        user: JSON.stringify(
          { description: input, country, foods: outside },
          null,
          2
        ),
      });
      const minor = parseMinorShare(answered.content);
      audit.push({
        step: "select_minor_share",
        detail: {
          group: group.code,
          name: group.name,
          foods: outside,
          minor,
          model: answered.model,
        },
      });
      if (minor) {
        sameNaturePick = group;
        minorFoods = outside;
      }
    }
  }

  function take(candidate: BaseTermCandidate, via: typeof parentPickVia): void {
    shortlistCodes = new Set([candidate.code]);
    shortlist = [candidate];
    maxScore = scores.get(candidate.code)!.score;
    shelfPool = shelves;
    parentPickVia = via;
    winningFit = (byCode.get(candidate.code) ?? "broad") as SelectFit;
  }

  if (sameNaturePick !== null) {
    take(sameNaturePick, "same_nature");
    audit.push({
      step: "select_same_nature",
      detail: {
        group: sameNaturePick.code,
        name: sameNaturePick.name,
        ...(minorFoods !== undefined ? { minorFoods } : {}),
      },
    });
  } else if (shelves.length === 1) {
    take(shelves[0]!, null);
  } else {
    shelfPool = shelves;
    const kindPick = await pickProductKind(input, shelves, options);
    audit.push(...kindPick.audit);
    const chosen =
      kindPick.code !== null ? shelves.find((c) => c.code === kindPick.code) ?? null : null;
    if (chosen !== null) {
      take(chosen, "model");
    } else {
      const ranked = [...shelves].sort((a, b) => {
        const delta = (scores.get(b.code)?.score ?? 0) - (scores.get(a.code)?.score ?? 0);
        if (delta !== 0) return delta;
        return compareTieBreak(
          tieBreakRank(cat, a, new Set(shelves.map((c) => c.code))).rank,
          tieBreakRank(cat, b, new Set(shelves.map((c) => c.code))).rank
        );
      });
      const top = ranked[0]!;
      shortlistCodes = new Set(
        ranked.filter((c) => scores.get(c.code)!.score === scores.get(top.code)!.score).map((c) => c.code)
      );
      shortlist = ranked.filter((c) => shortlistCodes.has(c.code));
      maxScore = scores.get(top.code)!.score;
      parentPickVia = "tie_break";
      winningFit = (byCode.get(shortlist[0]!.code) ?? "broad") as SelectFit;
    }
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
      winningFit,
      ...(hierarchyHeldBack.length > 0 ? { hierarchyHeldBack } : {}),
      maxScore,
      tierSize: shelves.length,
      ...(shelfPool !== null
        ? {
            shelfPickPool: shelfPool.map((c) => ({
              code: c.code,
              name: c.name,
              detailLevel: cat.term(c.code)?.detailLevel ?? null,
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
    pickKind: pick === null ? null : winningFit,
    ...(minorFoods !== undefined ? { minorFoods } : {}),
    audit,
  };
}
