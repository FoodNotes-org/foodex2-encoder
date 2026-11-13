/**
 * EFSA's process tables (guidance Tables 4, 5, 6 and 22, built from
 * rules/efsa-processes.yaml): does a stated treatment make a new food for this
 * food, or is it a facet, and which treatment ranks first when several do.
 */

import rulesData from "./rules-data.json" with { type: "json" };
import { isAtOrUnder, REPORTING_HIERARCHY, warnGroup } from "./check.js";
import type { RuleTerm, TermLookup } from "./types.js";

const PROCESS_HIERARCHY = "process";

export interface NewFoodTreatment {
  code: string;
  table: number;
  /** EFSA's wording; the catalogue name may differ. */
  process: string;
  appliedTo: string;
  leadsTo: string;
  /** EFSA validator groups (BR_Data) that list this process. */
  validatorGroups: string[];
  /** Our reading of `appliedTo`, where the validator data is silent. */
  alsoGroups: string[];
  /** Code as printed in the guidance, when it differs from today's. */
  efsaCode: string | null;
  note: string | null;
}

export interface FacetOnlyRow {
  codes: string[];
  descriptors: string;
  exceptions: string | null;
}

export interface PriorityRow {
  group: string;
  processes: string[];
}

const TABLES = rulesData.processTables as {
  newFood: NewFoodTreatment[];
  facetOnly: FacetOnlyRow[];
  priority: PriorityRow[];
};

export const NEW_FOOD_TREATMENTS: readonly NewFoodTreatment[] = TABLES.newFood;
export const FACET_ONLY_ROWS: readonly FacetOnlyRow[] = TABLES.facetOnly;
export const TREATMENT_PRIORITY: readonly PriorityRow[] = TABLES.priority;

const NEW_FOOD_BY_CODE = new Map(NEW_FOOD_TREATMENTS.map((row) => [row.code, row]));
const FACET_ONLY_CODES = new Set(FACET_ONLY_ROWS.flatMap((row) => row.codes));

export type TreatmentVerdict =
  /** Tables 4/5 row whose foods include this one. */
  | { kind: "new_food"; row: string; source: "validator" | "ours" }
  /** A Tables 4/5 row for other foods, or a Table 22 treatment. */
  | { kind: "facet"; row: string; source: "applied_to" | "table22" }
  /** A Tables 4/5 row with EFSA's words only: a model must judge the food. */
  | { kind: "judge"; row: string }
  /** In no table. */
  | { kind: "unlisted" };

/** The treatment, then its parents nearest first. */
function processChain(lookup: TermLookup, treatment: string): string[] {
  const ancestors = lookup.term(treatment)?.hierarchies[PROCESS_HIERARCHY]?.ancestors ?? [];
  return [treatment, ...[...ancestors].reverse()];
}

function underAny(food: RuleTerm, groups: readonly string[]): boolean {
  return groups.some((group) => isAtOrUnder(food, group, REPORTING_HIERARCHY));
}

/**
 * How one stated treatment counts for one food (the food before treatment,
 * e.g. Potatoes for "boiled potatoes"). The nearest table row on the
 * treatment's process chain decides; the validator data first, since it is
 * EFSA's newer word.
 */
export function judgeTreatment(lookup: TermLookup, treatment: string, foodCode: string): TreatmentVerdict {
  const food = lookup.term(foodCode);
  const group = food === undefined ? null : warnGroup(food);
  const chain = processChain(lookup, treatment);

  const forbidden = group === null ? [] : ((rulesData.forbiddenProcesses as Record<string, string[]>)[group] ?? []);
  const row = chain.map((code) => NEW_FOOD_BY_CODE.get(code)).find((r) => r !== undefined);
  if (forbidden.includes(treatment)) return { kind: "new_food", row: row?.code ?? treatment, source: "validator" };

  if (row !== undefined) {
    if (group !== null && row.validatorGroups.includes(group)) {
      return { kind: "new_food", row: row.code, source: "validator" };
    }
    if (food !== undefined && underAny(food, row.alsoGroups)) {
      return { kind: "new_food", row: row.code, source: "ours" };
    }
    if (row.validatorGroups.length > 0 || row.alsoGroups.length > 0) {
      return { kind: "facet", row: row.code, source: "applied_to" };
    }
    return { kind: "judge", row: row.code };
  }

  const listed = chain.find((code) => FACET_ONLY_CODES.has(code));
  return listed === undefined ? { kind: "unlisted" } : { kind: "facet", row: listed, source: "table22" };
}

/** Table 6 rank, 0 highest, by the nearest listed process on the chain; null when unranked. */
export function treatmentPriority(lookup: TermLookup, treatment: string): number | null {
  for (const code of processChain(lookup, treatment)) {
    const rank = TREATMENT_PRIORITY.findIndex((row) => row.processes.includes(code));
    if (rank >= 0) return rank;
  }
  return null;
}
