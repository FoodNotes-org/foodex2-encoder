/**
 * Base-term attribute eval: per foodstuff, did the encoder judge the stated
 * treatments the way the fixture expects (new food or facet only), keep the
 * words that show form, and land on the expected base?
 *
 * Facts come from the encode audit (route, base_compare, process_group), so a
 * run is one base-only encode.
 */

import type { Catalogue } from "../catalogue.js";
import type { AuditEntry, EncodeResult } from "../encode/types.js";
import { bool, codeList, list, loadCaseRecords, requiredText, text } from "./cases.js";

const PROCESS_HIERARCHY = "process";

export interface BaseAttributeCase {
  id: string;
  input: string;
  country: string;
  source: string;
  families: string[];
  rules: string[];
  base: string[];
  forbidBase: string[];
  /** Each entry is one treatment; `A|B` accepts either. */
  newFood: string[];
  facetOnly: string[];
  misread: string[];
  form: string[];
  open: boolean;
  note?: string;
}

export function loadBaseAttributeCases(path: string): BaseAttributeCase[] {
  return loadCaseRecords(path).map((rec) => {
    const base = codeList(rec, "base");
    if (!base || base.length === 0) {
      throw new Error(`case ${String(rec.id)}: base must list at least one code`);
    }
    return {
      id: requiredText(rec, "id"),
      input: requiredText(rec, "input"),
      country: requiredText(rec, "country"),
      source: requiredText(rec, "source"),
      families: list(rec, "families") ?? [],
      rules: list(rec, "rules") ?? [],
      base,
      forbidBase: codeList(rec, "forbid_base") ?? [],
      newFood: codeList(rec, "new_food") ?? [],
      facetOnly: codeList(rec, "facet_only") ?? [],
      misread: codeList(rec, "misread") ?? [],
      form: (list(rec, "form") ?? []).map((word) => word.toLowerCase()),
      open: bool(rec, "open") ?? false,
      note: text(rec, "note"),
    };
  });
}

/** Every code a case names, for checking against the catalogue. */
export function caseCodes(c: BaseAttributeCase): string[] {
  return [
    ...c.base,
    ...c.forbidBase,
    ...c.newFood.flatMap((entry) => entry.split("|")),
    ...c.facetOnly,
    ...c.misread,
  ];
}

/** What one encode decided, read from its audit. */
export interface BaseAttributeFacts {
  status: string;
  reason: string | null;
  pick: string | null;
  pickName: string | null;
  method: string | null;
  route: string | null;
  /** Treatments judged to make a new food. */
  nature: string[];
  /** Table 22 treatments recognised as stated. */
  stated: string[];
  processGroup: string | null;
  compareAs: string | null;
  /** Words taken out of the description and passed to the classifier as treatments applied. */
  removed: string[];
  /** Pick replaced by the process group: [from, to]. */
  override: [string | null, string] | null;
}

function auditDetail(audit: readonly AuditEntry[], step: string): Record<string, unknown> | null {
  const entry = audit.find((e) => e.step === step);
  return (entry?.detail as Record<string, unknown> | undefined) ?? null;
}

function codesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "string"
        ? item
        : item !== null && typeof item === "object" && typeof (item as { code?: unknown }).code === "string"
          ? (item as { code: string }).code
          : null
    )
    .filter((code): code is string => code !== null);
}

export function factsFromEncode(result: EncodeResult): BaseAttributeFacts {
  const audit = result.audit ?? [];
  const route = auditDetail(audit, "route");
  const compare = auditDetail(audit, "base_compare");
  const override = auditDetail(audit, "process_group");
  const ok = result.status === "ok";
  return {
    status: result.status,
    reason: !ok && "reason" in result ? result.reason : null,
    pick: ok ? (result.baseTerm?.code ?? null) : null,
    pickName: ok ? (result.baseTerm?.name ?? null) : null,
    method: ok ? (result.method ?? null) : null,
    route: typeof route?.descriptionKind === "string" ? route.descriptionKind : null,
    nature: codesOf(compare?.nature),
    stated: codesOf(compare?.processes),
    processGroup: typeof compare?.processGroup === "string" ? compare.processGroup : null,
    compareAs: typeof compare?.compareAs === "string" ? compare.compareAs : null,
    removed: Array.isArray(compare?.removed)
      ? compare.removed.filter((w): w is string => typeof w === "string")
      : [],
    override:
      override !== null && typeof override.to === "string"
        ? [typeof override.from === "string" ? override.from : null, override.to]
        : null,
  };
}

function atOrUnder(cat: Catalogue, expected: string, got: string): boolean {
  return got === expected || cat.isAncestor(expected, got, PROCESS_HIERARCHY);
}

function related(cat: Catalogue, a: string, b: string): boolean {
  return atOrUnder(cat, a, b) || atOrUnder(cat, b, a);
}

export interface BaseAttributeCheck {
  basePass: boolean;
  /** Null when no treatment step ran: identical wording, or routed as other than a foodstuff. */
  treatmentsPass: boolean | null;
  newFoodMissing: string[];
  /** facet_only or misread treatments that were judged to make a new food. */
  wronglyNewFood: string[];
  formLost: string[];
  /** facet_only treatments recognised by any treatment step. */
  facetSeen: string[];
}

export function checkRun(
  cat: Catalogue,
  c: BaseAttributeCase,
  facts: BaseAttributeFacts
): BaseAttributeCheck {
  const basePass =
    facts.pick !== null && c.base.includes(facts.pick) && !c.forbidBase.includes(facts.pick);

  const newFoodMissing = c.newFood.filter(
    (entry) => !entry.split("|").some((alt) => facts.nature.some((got) => atOrUnder(cat, alt, got)))
  );
  const wronglyNewFood = [...c.facetOnly, ...c.misread].filter((code) =>
    facts.nature.some((got) => related(cat, code, got))
  );
  const compared = [facts.compareAs ?? c.input, ...facts.removed].join(" ").toLowerCase();
  const formLost = c.form.filter((word) => !compared.includes(word));
  const recognised = [...facts.nature, ...facts.stated];
  const facetSeen = c.facetOnly.filter((code) => recognised.some((got) => related(cat, code, got)));

  const treatmentStepRan = facts.method === "traversal" && facts.route === "foodstuff";
  const treatmentsPass = treatmentStepRan
    ? newFoodMissing.length === 0 && wronglyNewFood.length === 0 && formLost.length === 0
    : null;

  return { basePass, treatmentsPass, newFoodMissing, wronglyNewFood, formLost, facetSeen };
}
