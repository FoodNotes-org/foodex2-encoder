/**
 * For a foodstuff: name the processes the description states, from the whole
 * catalogue process list. A stated process that is in guidance Tables 4 and 5
 * (rules/efsa-processes.yaml) is then judged on whether, for this food, it makes
 * a different kind of food; that process stays in the description. Every other
 * stated process is taken out of the description the base is matched against
 * and passed on as a treatment, unless a catalogue group that already implies
 * it is this food. The model names the words that state each process, and code
 * cuts them out. The original description is what the facets are read from. A
 * dish or a mix is not handled here.
 */

import { Catalogue, DEFAULT_HIERARCHY, isInExposureTree } from "../catalogue.js";
import { isHierarchyTerm } from "../rules/check.js";
import { countryParagraph } from "../country.js";
import { chatJson } from "../llm.js";
import { NEW_FOOD_TREATMENTS } from "../rules/processes.js";

const PROCESS_HIERARCHY = "process";

/**
 * A process with more groups than this is the broad parent (cooking, chilling).
 * The specific process the description states is the one to judge.
 */
const MAX_IMPLIED_GROUPS = 15;

export interface StatedProcess {
  code: string;
  /** The words from the description that state it, or null when not given. */
  phrase: string | null;
}

export interface ProcessGroup {
  code: string;
  name: string;
  /** Stated processes this term already implies. */
  processes: string[];
}

interface ImpliedGroup {
  code: string;
  name: string;
  note: string | null;
}

let cachedProcessCodes: Set<string> | null = null;
let cachedImplied: Map<string, ImpliedGroup[]> | null = null;

/**
 * Stated processes that are, or sit under, a Tables 4 and 5 process, each with
 * that row's foods and outcomes. Only these can make a new food.
 */
export function newFoodCandidates(
  cat: Catalogue,
  stated: readonly StatedProcess[]
): Array<{ code: string; name: string; applied_to: string; leads_to: string }> {
  const out: Array<{ code: string; name: string; applied_to: string; leads_to: string }> = [];
  for (const process of stated) {
    const row = NEW_FOOD_TREATMENTS.find(
      (r) =>
        cat.term(r.code) !== undefined &&
        (r.code === process.code || cat.isAncestor(r.code, process.code, PROCESS_HIERARCHY))
    );
    if (row === undefined) continue;
    out.push({
      code: process.code,
      name: cat.term(process.code)?.name ?? process.code,
      applied_to: row.appliedTo,
      leads_to: row.leadsTo,
    });
  }
  return out;
}

/** Every process term the catalogue still uses. */
export function processCodes(cat: Catalogue): ReadonlySet<string> {
  if (cachedProcessCodes !== null) return cachedProcessCodes;
  cachedProcessCodes = new Set(
    Object.entries(cat.data.terms)
      .filter(([code, term]) => term.status !== "DEPRECATED" && cat.belongsTo(code, PROCESS_HIERARCHY))
      .map(([code]) => code)
  );
  return cachedProcessCodes;
}

function impliedIndex(cat: Catalogue): Map<string, ImpliedGroup[]> {
  if (cachedImplied !== null) return cachedImplied;
  const index = new Map<string, ImpliedGroup[]>();
  for (const [code, term] of Object.entries(cat.data.terms)) {
    if (term.termType === "f" || term.status === "DEPRECATED") continue;
    if (!isInExposureTree(term) || !cat.isReportable(code, DEFAULT_HIERARCHY)) continue;
    if (isHierarchyTerm(term)) continue;
    for (const facet of cat.impliedFacets(code)) {
      if (!facet.startsWith("F28.")) continue;
      const process = facet.slice("F28.".length);
      const entry: ImpliedGroup = {
        code,
        name: term.name ?? code,
        note: term.scopeNote,
      };
      const list = index.get(process);
      if (list === undefined) index.set(process, [entry]);
      else list.push(entry);
    }
  }
  for (const list of index.values()) {
    list.sort((a, b) => a.code.localeCompare(b.code));
  }
  cachedImplied = index;
  return index;
}

/**
 * Exposure terms that already imply this process and can be a base: reportable,
 * and neither a facet descriptor nor a hierarchy term.
 */
export function termsImplyingProcess(cat: Catalogue, processCode: string): ImpliedGroup[] {
  return impliedIndex(cat).get(processCode) ?? [];
}

export function termImpliesProcesses(
  cat: Catalogue,
  code: string,
  processes: readonly string[]
): boolean {
  const implied = new Set(cat.impliedFacets(code));
  return processes.some((process) => implied.has(`F28.${process}`));
}

export function parseStatedProcesses(
  content: unknown,
  allowed: ReadonlySet<string>
): StatedProcess[] | null {
  if (content === null || typeof content !== "object") return null;
  const processes = (content as { processes?: unknown }).processes;
  if (!Array.isArray(processes)) return null;
  const out: StatedProcess[] = [];
  const seen = new Set<string>();
  for (const item of processes) {
    if (item === null || typeof item !== "object") continue;
    const raw = (item as { code?: unknown }).code;
    if (typeof raw !== "string") continue;
    const code = raw.trim().toUpperCase();
    if (!allowed.has(code) || seen.has(code)) continue;
    seen.add(code);
    const phrase = (item as { phrase?: unknown }).phrase;
    out.push({ code, phrase: typeof phrase === "string" && phrase.trim() !== "" ? phrase.trim() : null });
  }
  return out;
}

/** `null` when the body is unusable. `code: null` when none of the terms is the food. */
export function parseProcessGroup(
  content: unknown,
  allowed: ReadonlySet<string>
): { code: string | null } | null {
  if (content === null || typeof content !== "object") return null;
  const raw = (content as { code?: unknown }).code;
  if (raw === null) return { code: null };
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  if (!allowed.has(code)) return null;
  return { code };
}

function systemNewFood(withCountry: boolean): string {
  return `You are an expert in food classification.

Task: decide which of these treatments, applied to this food, make a different kind of food.

Given:
- \`description\`: the food description.
- \`treatments\`: treatments the description states. Each has a \`code\`, a \`name\`, \`applied_to\` (the foods it makes a different kind of food from) and \`leads_to\` (the kinds of food it makes).
${countryParagraph(withCountry, "description")}
A treatment counts only when the food it was applied to is one of its \`applied_to\` foods.

Reply with JSON only:
{"processes":[{"code":"<code>"}]}

An empty list means none of these treatments makes this food a different kind of food.`;
}

function systemStatedProcesses(withCountry: boolean): string {
  return `You are an expert in food classification.

Task: name which of these processes, if any, the description states, and the words that state each.

Given:
- \`description\`: the food description.
- \`processes\`: each has a \`code\` and a \`name\`. A process and the processes under it are both listed.
${countryParagraph(withCountry, "description")}
Return the most specific process the description states.

For each process, \`phrase\` is the words from the description that state it, with any detail that qualifies it. A phrase never includes the words that name the food.

Reply with JSON only:
{"processes":[{"code":"<code>","phrase":"<text>"}]}

An empty list means the description states none of these processes.`;
}

function systemProcessGroup(withCountry: boolean): string {
  return `You are an expert in food classification.

Task: decide which of these catalogue terms, if any, is the food described.

Given:
- \`description\`: the food description.
- \`terms\`: each has a \`code\` and a \`name\`. A term that has a scope note also has \`note\`.
${countryParagraph(withCountry, "description")}
A term counts when the food is that term. A term that is only an ingredient, or only the food before the process, does not count.
A term does not count when it is a different product from the one the description names.

Reply with JSON only:
{"code":"<code>"|null}`;
}

export interface BaseCompare {
  compareAs: string;
  /** Always null: a match is kept whatever its catalogue type. */
  termTypes: null;
  /** Term that already implies a stated process and is this food. Seeded into the walk. */
  processGroup: ProcessGroup | null;
  seeds: string[];
  detail: Record<string, unknown>;
  /** Words taken out of the description, each stating a treatment that does not make a new food. */
  treatmentsApplied: string[];
  /** Every treatment found stated: new-food ones first, then the others. */
  statedTreatments: string[];
}

function unchanged(description: string, detail: Record<string, unknown>): BaseCompare {
  return {
    compareAs: description,
    termTypes: null,
    processGroup: null,
    seeds: [],
    detail: { ...detail, compareAs: description, processGroup: null },
    treatmentsApplied: [],
    statedTreatments: [],
  };
}

function listedProcesses(
  cat: Catalogue,
  codes: Iterable<string>
): Array<{ code: string; name: string }> {
  return [...codes]
    .filter((code) => cat.term(code) !== undefined)
    .map((code) => ({ code, name: cat.term(code)?.name ?? code }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

function groupsForProcesses(
  cat: Catalogue,
  stated: readonly StatedProcess[]
): { judged: string[]; skipped: string[]; groups: ImpliedGroup[] } {
  const judged: string[] = [];
  const skipped: string[] = [];
  const groups: ImpliedGroup[] = [];
  const seen = new Set<string>();
  for (const process of stated) {
    const implied = termsImplyingProcess(cat, process.code);
    if (implied.length === 0 || implied.length > MAX_IMPLIED_GROUPS) {
      if (implied.length > MAX_IMPLIED_GROUPS) skipped.push(process.code);
      continue;
    }
    judged.push(process.code);
    for (const group of implied) {
      if (seen.has(group.code)) continue;
      seen.add(group.code);
      groups.push(group);
    }
  }
  return { judged, skipped, groups };
}

async function chooseProcessGroup(
  cat: Catalogue,
  description: string,
  country: string | null,
  withCountry: boolean,
  model: string,
  stated: readonly StatedProcess[],
  groups: readonly ImpliedGroup[]
): Promise<{ processGroup: ProcessGroup | null; model: string | null }> {
  if (groups.length === 0) return { processGroup: null, model: null };
  const allowedGroups = new Set(groups.map((group) => group.code));
  const groupCall = await chatJson({
    model,
    system: systemProcessGroup(withCountry),
    user: JSON.stringify(
      {
        description,
        ...(withCountry ? { country } : {}),
        terms: groups.map((group) => ({
          code: group.code,
          name: group.name,
          ...(group.note !== null && group.note !== "" ? { note: group.note } : {}),
        })),
      },
      null,
      2
    ),
  });
  const picked = parseProcessGroup(groupCall.content, allowedGroups);
  if (picked?.code === null || picked === null) {
    return { processGroup: null, model: groupCall.model };
  }
  const term = cat.term(picked.code);
  const implied = stated
    .map((process) => process.code)
    .filter((process) => termImpliesProcesses(cat, picked.code as string, [process]));
  return {
    processGroup: {
      code: picked.code,
      name: term?.name ?? picked.code,
      processes: implied,
    },
    model: groupCall.model,
  };
}

/** Treatments to take out of the description. A treatment the chosen group already covers stays. */
export function processesToSetAside(
  stated: readonly StatedProcess[],
  covered: readonly string[]
): StatedProcess[] {
  const keep = new Set(covered);
  return stated.filter((process) => !keep.has(process.code));
}

/**
 * The description with each phrase cut out where it occurs, and the phrases
 * that were. A phrase not found as written is left. Empty comma parts are
 * dropped; when nothing would remain the description is kept whole.
 */
export function removePhrases(
  description: string,
  phrases: readonly string[]
): { text: string; removed: string[] } {
  let text = description;
  const removed: string[] = [];
  for (const phrase of phrases) {
    const at = text.toLowerCase().indexOf(phrase.toLowerCase());
    if (at < 0) continue;
    removed.push(text.slice(at, at + phrase.length));
    text = `${text.slice(0, at)} ${text.slice(at + phrase.length)}`;
  }
  const cleaned = text
    .split(",")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part !== "")
    .join(", ");
  return cleaned === "" ? { text: description, removed: [] } : { text: cleaned, removed };
}

/** Foodstuff only. A dish or a mix keeps the description as given. */
export async function resolveBaseCompare(
  description: string,
  country: string | null,
  model: string
): Promise<BaseCompare> {
  const cat = Catalogue.load();
  const withCountry = country !== null && country !== "";
  const countryField = withCountry ? { country } : {};

  const statedCall = await chatJson({
    model,
    system: systemStatedProcesses(withCountry),
    user: JSON.stringify(
      { description, ...countryField, processes: listedProcesses(cat, processCodes(cat)) },
      null,
      2
    ),
  });
  const stated = parseStatedProcesses(statedCall.content, processCodes(cat)) ?? [];
  if (stated.length === 0) {
    return unchanged(description, {
      model: statedCall.model,
      parsed: statedCall.content !== null,
      nature: [],
      processes: [],
    });
  }

  const candidates = newFoodCandidates(cat, stated);
  let nature: StatedProcess[] = [];
  let natureModel: string | null = null;
  if (candidates.length > 0) {
    const natureCall = await chatJson({
      model,
      system: systemNewFood(withCountry),
      user: JSON.stringify({ description, ...countryField, treatments: candidates }, null, 2),
    });
    natureModel = natureCall.model;
    const chosen = new Set(
      (parseStatedProcesses(natureCall.content, new Set(candidates.map((c) => c.code))) ?? []).map(
        (process) => process.code
      )
    );
    nature = stated.filter((process) => chosen.has(process.code));
  }
  const natureCodes = new Set(nature.map((process) => process.code));
  const others = stated.filter((process) => !natureCodes.has(process.code));

  const natureParts = groupsForProcesses(cat, nature);
  const natureChoice = await chooseProcessGroup(
    cat,
    description,
    country,
    withCountry,
    model,
    nature,
    natureParts.groups
  );
  const otherParts = groupsForProcesses(cat, others);
  let processGroup = natureChoice.processGroup;
  let groupModel = natureChoice.model;
  if (processGroup === null) {
    const otherChoice = await chooseProcessGroup(
      cat,
      description,
      country,
      withCountry,
      model,
      others,
      otherParts.groups
    );
    processGroup = otherChoice.processGroup;
    groupModel = otherChoice.model ?? groupModel;
  }

  const aside = processesToSetAside(others, processGroup?.processes ?? []);
  const { text: compareAs, removed } = removePhrases(
    description,
    aside.map((process) => process.phrase).filter((phrase): phrase is string => phrase !== null)
  );

  return {
    compareAs,
    termTypes: null,
    processGroup,
    seeds: processGroup === null ? [] : [processGroup.code],
    detail: {
      model: statedCall.model,
      ...(natureModel !== null ? { natureModel } : {}),
      ...(groupModel !== null ? { groupModel } : {}),
      processes: stated,
      newFoodCandidates: candidates.map((candidate) => candidate.code),
      nature: nature.map((process) => process.code),
      natureJudged: natureParts.judged,
      natureSkipped: natureParts.skipped,
      natureGroups: natureParts.groups.map((group) => group.code),
      judged: otherParts.judged,
      skipped: otherParts.skipped,
      groups: otherParts.groups.map((group) => group.code),
      aside: aside.map((process) => process.code),
      removed,
      processGroup: processGroup?.code ?? null,
      compareAs,
    },
    treatmentsApplied: removed,
    statedTreatments: [...nature, ...others].map((process) => process.code),
  };
}
