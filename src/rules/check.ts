import rulesData from "./rules-data.json" with { type: "json" };
import {
  EFSA_RULES,
  GENERIC_PROCESSES,
  RAW_FORBIDDEN_STATES,
  RECONSTITUTION_PROCESSES,
} from "./efsa.js";
import { parseCode } from "./parse.js";
import type { ConflictRef, Finding, ParsedCode, RuleTerm, TermLookup } from "./types.js";

export const REPORTING_HIERARCHY = "report";
export const EXPOSURE_HIERARCHY = "expo";

interface FacetCardinality {
  label: string;
  flag: string;
  description: string | null;
  second: "error" | "warning" | "allowed";
  except: string[];
  perGroup: boolean;
  conflict: string | null;
}

const FACETS = rulesData.facets as Record<string, FacetCardinality>;
const CONFLICTS = rulesData.conflicts as Record<string, Omit<ConflictRef, "id">>;
const FORBIDDEN_PROCESSES = rulesData.forbiddenProcesses as Record<string, string[]>;

/**
 * EFSA's "warn group" for BR16 and BR19: the nearest of the term and its
 * Reporting-hierarchy ancestors that has forbidden processes listed.
 */
function warnGroup(term: RuleTerm): string | null {
  const ancestors = term.hierarchies[REPORTING_HIERARCHY]?.ancestors ?? [];
  return [term.code, ...[...ancestors].reverse()].find((code) => code in FORBIDDEN_PROCESSES) ?? null;
}

export const RULES_MTX_RELEASE: string = rulesData.mtxRelease;

export function facetCardinality(facet: string): FacetCardinality | undefined {
  return FACETS[facet];
}

export function conflict(id: string | null): ConflictRef | undefined {
  const entry = id === null ? undefined : CONFLICTS[id];
  return entry === undefined ? undefined : { id: id as string, ...entry };
}

/** EFSA §5.2 discourages hierarchy terms (detail level H) as base terms. */
export function isHierarchyTerm(term: Pick<RuleTerm, "detailLevel">): boolean {
  return term.detailLevel === "H";
}

/** `term` is `ancestor` or sits beneath it in `hierarchy`. */
export function isAtOrUnder(term: RuleTerm, ancestor: string, hierarchy: string): boolean {
  return term.code === ancestor || (term.hierarchies[hierarchy]?.ancestors.includes(ancestor) ?? false);
}

/**
 * Which stated descriptors compete for one place under the facet's limit.
 * Descriptors with the same key count towards the same limit; null means the
 * descriptor is not limited (repeatable facet, or an exception like F17 A07ND).
 */
export function cardinalityKey(lookup: TermLookup, facet: string, code: string): string | null {
  const entry = FACETS[facet];
  if (entry === undefined || entry.second === "allowed" || entry.except.includes(code)) return null;
  if (!entry.perGroup) return facet;
  const hierarchy = lookup.facet(facet)?.hierarchy;
  const top = hierarchy === undefined ? undefined : lookup.term(code)?.hierarchies[hierarchy]?.ancestors[0];
  return `${facet}/${top ?? code}`;
}

export type ImpliedRelation = "repeats" | "broader" | "narrower" | "contradicts" | "none";

/**
 * How a stated descriptor relates to the base term's implied descriptors of the
 * same facet. "contradicts" only applies to facets limited to one descriptor:
 * a different descriptor that is neither the implied one nor beneath it.
 */
export function impliedRelation(
  lookup: TermLookup,
  facet: string,
  code: string,
  implied: string[]
): ImpliedRelation {
  const prefix = `${facet}.`;
  const same = implied.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  if (same.length === 0) return "none";
  if (same.includes(code)) return "repeats";
  const hierarchy = lookup.facet(facet)?.hierarchy;
  const stated = lookup.term(code);
  if (hierarchy === undefined || stated === undefined) return "none";
  if (same.some((imp) => isAtOrUnder(stated, imp, hierarchy))) return "narrower";
  if (
    same.some((imp) => {
      const impliedTerm = lookup.term(imp);
      return impliedTerm !== undefined && isAtOrUnder(impliedTerm, code, hierarchy);
    })
  ) {
    return "broader";
  }
  return cardinalityKey(lookup, facet, code) !== null && FACETS[facet]?.second === "error"
    ? "contradicts"
    : "none";
}

function efsa(rule: string, terms: string[], detail?: string): Finding {
  const def = EFSA_RULES[rule];
  if (def === undefined) throw new Error(`Unknown EFSA rule ${rule}`);
  return {
    severity: def.severity,
    rule,
    by: "EFSA business rule",
    message: detail === undefined ? def.message : `${def.message} ${detail}`,
    terms,
  };
}

const COMPOSITE = new Set(["s", "c"]);

function baseTermChecks(bt: RuleTerm, parsed: ParsedCode, out: Finding[]): void {
  const report = bt.hierarchies[REPORTING_HIERARCHY];
  if (!bt.dismissed && report !== undefined && !report.reportable) out.push(efsa("BR08", [bt.code]));
  if (bt.detailLevel === "P") {
    const onlyOrigin =
      parsed.facets.length > 0 && parsed.facets.every((f) => f.facet === "F01" || f.facet === "F27");
    if (!onlyOrigin) out.push(efsa("BR10", [bt.code]));
  }
  if (bt.termType === "f") out.push(efsa("BR17", [bt.code]));
  if (bt.status === "DEPRECATED") out.push(efsa("BR20", [bt.code]));
  if (bt.dismissed) out.push(efsa("BR21", [bt.code]));
  if (isHierarchyTerm(bt)) {
    out.push(efsa(EXPOSURE_HIERARCHY in bt.hierarchies ? "BR23" : "BR24", [bt.code]));
  }
}

function facetChecks(bt: RuleTerm, facet: string, d: RuleTerm, lookup: TermLookup, out: Finding[]): void {
  const code = d.code;
  const type = bt.termType ?? "";
  if (facet === "F28" && GENERIC_PROCESSES.has(code)) out.push(efsa("BR11", [code]));
  if (facet === "F04" && (type === "r" || type === "d") && !bt.name.toLowerCase().includes("flavoured")) {
    const hierarchy = lookup.facet("F04")?.hierarchy ?? "ingred";
    const impliedF04 = bt.implied.filter((k) => k.startsWith("F04.")).map((k) => k.slice(4));
    if (!impliedF04.some((imp) => isAtOrUnder(d, imp, hierarchy))) out.push(efsa("BR12", [code]));
  }
  if (COMPOSITE.has(type) && facet === "F01") out.push(efsa("BR03", [bt.code, code]));
  if (COMPOSITE.has(type) && facet === "F27") out.push(efsa("BR04", [bt.code, code]));
  if (facet === "F28" && RECONSTITUTION_PROCESSES.has(code)) {
    const text = `${bt.name} ${bt.scopeNote ?? ""}`;
    if (text.includes("concentrate") || text.includes("powder")) out.push(efsa("BR28", [bt.code, code]));
  }
  if (type === "r" && facet === "F03" && RAW_FORBIDDEN_STATES.has(code)) out.push(efsa("BR13", [bt.code, code]));
  if (type === "r" && facet === "F28") {
    const group = warnGroup(bt);
    if (group !== null && FORBIDDEN_PROCESSES[group]!.includes(code)) out.push(efsa("BR19", [bt.code, code]));
  }
  if (d.status === "DEPRECATED") {
    out.push({
      severity: "warning",
      rule: "deprecated-descriptor",
      by: "FoodNotes",
      message: `Facet descriptor ${code} is deprecated in the catalogue.`,
      terms: [code],
    });
  }
}

function impliedChecks(bt: RuleTerm, facet: string, code: string, lookup: TermLookup, out: Finding[]): void {
  const relation = impliedRelation(lookup, facet, code, bt.implied);
  if (relation === "repeats") {
    out.push({
      severity: "warning",
      rule: "repeats-implied",
      by: "EFSA guidance",
      message: `${facet}.${code} is already implied by the base term ${bt.code}; EFSA suggests never reporting implicit facets (FoodEx2 guidance rev 2, §5.1.3, p. 40).`,
      terms: [bt.code, code],
    });
  } else if (relation === "broader" && warnGroup(bt) !== null) {
    const hierarchy = lookup.facet(facet)?.hierarchy;
    const narrower = bt.implied
      .filter((k) => k.startsWith(`${facet}.`))
      .map((k) => k.slice(facet.length + 1))
      .filter((imp) => {
        const t = lookup.term(imp);
        return hierarchy !== undefined && t !== undefined && isAtOrUnder(t, code, hierarchy);
      });
    out.push({
      ...efsa("BR16", [bt.code, code, ...narrower], `(${bt.code} already implies ${narrower.map((c) => `${facet}.${c}`).join(", ")})`),
      conflict: conflict("severity-BR16"),
    });
  } else if (relation === "broader") {
    out.push({
      severity: "warning",
      rule: "broader-than-implied",
      by: "FoodNotes",
      message: `${facet}.${code} is less detailed than what the base term ${bt.code} already implies, so it adds nothing.`,
      terms: [bt.code, code],
    });
  } else if (relation === "contradicts") {
    out.push({
      severity: "warning",
      rule: "implied-contradiction",
      by: "FoodNotes",
      message: `${facet} allows one descriptor, and the base term ${bt.code} already implies a different one; ${code} is not a more specific version of it.`,
      terms: [bt.code, code],
    });
  }
}

function cardinalityChecks(stated: Array<{ facet: string; code: string }>, lookup: TermLookup, out: Finding[]): void {
  const groups = new Map<string, Array<{ facet: string; code: string }>>();
  for (const f of stated) {
    const key = cardinalityKey(lookup, f.facet, f.code);
    if (key === null) continue;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const facet = group[0]!.facet;
    const entry = FACETS[facet]!;
    const terms = group.map((f) => f.code);
    const conflictRef = conflict(entry.conflict);
    if (entry.second === "error") {
      const finding = efsa("BR25", terms, `(${facet} ${entry.label}: ${terms.join(", ")})`);
      out.push(conflictRef === undefined ? finding : { ...finding, conflict: conflictRef });
    } else {
      out.push({
        severity: "warning",
        rule: "facet-allows-one",
        by: conflictRef?.ours ? "FoodNotes" : "EFSA guidance",
        message: `${facet} ${entry.label} has ${terms.length} descriptors (${terms.join(", ")}). EFSA's checker accepts this, but the facet description says: "${entry.description}"`,
        terms,
        ...(conflictRef === undefined ? {} : { conflict: conflictRef }),
      });
    }
  }
}

export interface CheckResult {
  parsed: ParsedCode;
  findings: Finding[];
}

/**
 * Check one full FoodEx2 code. The lookup must answer for the base term, every
 * stated descriptor, and the descriptors the base term implies.
 */
export function checkCode(raw: string, lookup: TermLookup): CheckResult {
  const parsed = parseCode(raw);
  const findings: Finding[] = parsed.problems.map((p) => efsa("BR29", [], p));
  if (parsed.base === null) return { parsed, findings };

  const bt = lookup.term(parsed.base);
  if (bt === undefined) {
    findings.push(efsa("BR29", [parsed.base], `Unknown term ${parsed.base}.`));
    return { parsed, findings };
  }
  baseTermChecks(bt, parsed, findings);

  const valid: Array<{ facet: string; code: string }> = [];
  for (const { facet, code } of parsed.facets) {
    const category = lookup.facet(facet);
    if (category === undefined) {
      findings.push(efsa("BR30", [], `(${facet})`));
      continue;
    }
    const d = lookup.term(code);
    if (d === undefined) {
      findings.push(efsa("BR29", [code], `Unknown term ${code}.`));
      continue;
    }
    if (!(category.hierarchy in d.hierarchies)) {
      findings.push(efsa("BR31", [code], `(${code} is not a ${facet} descriptor)`));
      continue;
    }
    facetChecks(bt, facet, d, lookup, findings);
    impliedChecks(bt, facet, code, lookup, findings);
    valid.push({ facet, code });
  }
  cardinalityChecks(valid, lookup, findings);
  return { parsed, findings };
}
