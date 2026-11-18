/**
 * For a foodstuff: name the processes the description states, from the whole
 * catalogue process list. A stated process that is in guidance Tables 4 and 5
 * (rules/efsa-processes.yaml) is then judged on whether, for this food, it makes
 * a different kind of food; that process stays in the description. Every other
 * stated process is taken out of the description the base is matched against
 * and passed on as a treatment, unless a catalogue group that already implies
 * it is this food. The model names the words that state each process, and code
 * cuts them out. Separately, the parts the description says the food includes
 * or leaves out (with skin, drained) are named from the catalogue part list,
 * cut out the same way, and passed on as parts. The original description is
 * what the facets are read from. A dish or a mix is not handled here.
 */

import { Catalogue, DEFAULT_HIERARCHY, isInExposureTree } from "../catalogue.js";
import { isHierarchyTerm } from "../rules/check.js";
import { countryParagraph } from "../country.js";
import { chatJson } from "../llm.js";
import { FACET_ONLY_ROWS, NEW_FOOD_TREATMENTS, type FacetOnlyRow, type NewFoodTreatment } from "../rules/processes.js";

const PROCESS_HIERARCHY = "process";
const PART_HIERARCHY = "partcon";

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
let cachedPartCodes: Set<string> | null = null;
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

/** The process, then each parent, nearest first. */
function processChain(cat: Catalogue, code: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null = code;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = cat.parent(current, PROCESS_HIERARCHY);
  }
  return chain;
}

function nearestNewFood(cat: Catalogue, processCode: string): NewFoodTreatment | undefined {
  for (const code of processChain(cat, processCode)) {
    const row = NEW_FOOD_TREATMENTS.find((treatment) => treatment.code === code);
    if (row !== undefined) return row;
  }
  return undefined;
}

function nearestFacetOnly(cat: Catalogue, processCode: string): FacetOnlyRow | undefined {
  for (const code of processChain(cat, processCode)) {
    const row = FACET_ONLY_ROWS.find((entry) => entry.codes.includes(code));
    if (row !== undefined) return row;
  }
  return undefined;
}

/**
 * The table sentence for a stated process, still conditional on which food it
 * was applied to. Null when no table mentions the process.
 */
export function processTableFact(
  cat: Catalogue,
  processCode: string
): { name: string; rule: string } | null {
  const name = cat.term(processCode)?.name ?? processCode;
  const row = nearestNewFood(cat, processCode);
  if (row !== undefined) {
    const covered = row.code === processCode ? "" : `${name} is covered by ${row.process}. `;
    return {
      name,
      rule: `${covered}${row.process} creates a new food only for ${row.appliedTo}, and that food is ${row.leadsTo}. For any other food it is a process of that food.`,
    };
  }
  const facet = nearestFacetOnly(cat, processCode);
  if (facet === undefined) return null;
  const exception = facet.exceptions?.trim();
  const rule =
    exception !== undefined && exception !== ""
      ? `${name} does not create a new food. It is a process of that food. Exception: ${exception}`
      : `${name} does not create a new food. It is a process of that food.`;
  return { name, rule };
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

/**
 * Every part term the catalogue still uses, without its headings. A part the
 * food is only (Only skin, Only peel) names the food itself, so it is left out.
 */
export function partCodes(cat: Catalogue): ReadonlySet<string> {
  if (cachedPartCodes !== null) return cachedPartCodes;
  cachedPartCodes = new Set(
    Object.entries(cat.data.terms)
      .filter(
        ([code, term]) =>
          term.status !== "DEPRECATED" &&
          cat.belongsTo(code, PART_HIERARCHY) &&
          !isHierarchyTerm(term) &&
          !(term.name ?? "").startsWith("Only ")
      )
      .map(([code]) => code)
  );
  return cachedPartCodes;
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
  allowed: ReadonlySet<string>,
  key: "processes" | "parts" = "processes"
): StatedProcess[] | null {
  if (content === null || typeof content !== "object") return null;
  const processes = (content as Record<string, unknown>)[key];
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
- \`processes\`: each has a \`code\` and a \`name\`, and a \`note\` when the catalogue defines it. A process and the processes under it are both listed.
${countryParagraph(withCountry, "description")}
Return the most specific process the description states.
When no listed process is the one the words state, leave those words out rather than name a broader process.

For each process, \`phrase\` is the words from the description that state it, with any detail that qualifies it. A phrase never includes the words that name the food.

Reply with JSON only:
{"processes":[{"code":"<code>","phrase":"<text>"}]}

An empty list means the description states none of these processes.`;
}

function systemStatedParts(withCountry: boolean): string {
  return `You are an expert in food classification.

Task: name which of these parts, if any, the description says the food includes or leaves out, and the words that state each.

Given:
- \`description\`: the food description.
- \`parts\`: each has a \`code\` and a \`name\`.
${countryParagraph(withCountry, "description")}
Words that say what the food is packed in do not say whether that medium is eaten.

For each part, \`phrase\` is the whole run of words from the description that states it. Parts stated together share one phrase. A phrase never includes the words that name the food.

Reply with JSON only:
{"parts":[{"code":"<code>","phrase":"<text>"}]}

An empty list means the description states none of these parts.`;
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
  /** Words taken out of the description, each stating parts the food includes or leaves out. */
  partsApplied: string[];
  /** Every part found stated. */
  statedParts: string[];
  /** The stated processes and parts with their words, for the facets. */
  named: NamedFacets;
}

/** Processes and parts a foodstuff's description states, named once from the full catalogue lists. */
export interface NamedFacets {
  processes: StatedProcess[];
  parts: StatedProcess[];
}

function listedProcesses(
  cat: Catalogue,
  codes: Iterable<string>,
  withNotes = false
): Array<{ code: string; name: string; note?: string }> {
  return [...codes]
    .filter((code) => cat.term(code) !== undefined)
    .map((code) => {
      const term = cat.term(code);
      const note = withNotes ? term?.scopeNote?.trim() : undefined;
      return { code, name: term?.name ?? code, ...(note ? { note } : {}) };
    })
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

/** Part phrases to cut, once each. A phrase that overlaps words stating a kept process stays. */
export function partPhrasesToRemove(
  parts: readonly StatedProcess[],
  keptPhrases: readonly string[]
): string[] {
  const kept = keptPhrases.map((phrase) => phrase.toLowerCase());
  const out: string[] = [];
  for (const part of parts) {
    if (part.phrase === null || out.includes(part.phrase)) continue;
    const phrase = part.phrase.toLowerCase();
    if (kept.some((k) => k.includes(phrase) || phrase.includes(k))) continue;
    out.push(part.phrase);
  }
  return out;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function findPhraseSpan(text: string, phrase: string): number {
  const lowerText = text.toLowerCase();
  const lowerPhrase = phrase.toLowerCase();
  if (lowerPhrase === "") return -1;
  const checkStart = WORD_CHAR.test(lowerPhrase[0]!);
  const checkEnd = WORD_CHAR.test(lowerPhrase[lowerPhrase.length - 1]!);
  let from = 0;
  while (from <= lowerText.length - lowerPhrase.length) {
    const at = lowerText.indexOf(lowerPhrase, from);
    if (at < 0) return -1;
    const beforeOk = !checkStart || at === 0 || !WORD_CHAR.test(lowerText[at - 1]!);
    const end = at + lowerPhrase.length;
    const afterOk = !checkEnd || end === lowerText.length || !WORD_CHAR.test(lowerText[end]!);
    if (beforeOk && afterOk) return at;
    from = at + 1;
  }
  return -1;
}

/**
 * The description with each phrase cut out where it occurs, and the phrases
 * that were. A phrase not found on word boundaries is left. Empty brackets and
 * comma parts are dropped; when nothing would remain the description is kept whole.
 */
export function removePhrases(
  description: string,
  phrases: readonly string[]
): { text: string; removed: string[] } {
  let text = description;
  const removed: string[] = [];
  for (const phrase of phrases) {
    const at = findPhraseSpan(text, phrase);
    if (at < 0) continue;
    removed.push(text.slice(at, at + phrase.length));
    text = `${text.slice(0, at)} ${text.slice(at + phrase.length)}`;
  }
  const cleaned = text
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .split(",")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part !== "")
    .join(", ");
  return cleaned === "" ? { text: description, removed: [] } : { text: cleaned, removed };
}

/** Name the processes and parts a description states, without deciding the base term. */
export async function nameStatedFacets(
  description: string,
  country: string | null,
  model: string
): Promise<NamedFacets> {
  const cat = Catalogue.load();
  const withCountry = country !== null && country !== "";
  const countryField = withCountry ? { country } : {};
  const [statedCall, partsCall] = await Promise.all([
    chatJson({
      model,
      system: systemStatedProcesses(withCountry),
      user: JSON.stringify(
        { description, ...countryField, processes: listedProcesses(cat, processCodes(cat), true) },
        null,
        2
      ),
    }),
    chatJson({
      model,
      system: systemStatedParts(withCountry),
      user: JSON.stringify(
        { description, ...countryField, parts: listedProcesses(cat, partCodes(cat)) },
        null,
        2
      ),
    }),
  ]);
  return {
    processes: parseStatedProcesses(statedCall.content, processCodes(cat)) ?? [],
    parts: parseStatedProcesses(partsCall.content, partCodes(cat), "parts") ?? [],
  };
}

/** Foodstuff only. A dish or a mix keeps the description as given. */
export async function resolveBaseCompare(
  description: string,
  country: string | null,
  model: string
): Promise<BaseCompare> {
  const cat = Catalogue.load();
  const withCountry = country !== null && country !== "";
  const named = await nameStatedFacets(description, country, model);
  const stated = named.processes;
  const parts = named.parts;
  const treatments =
    stated.length > 0
      ? await resolveTreatments(cat, description, country, withCountry, model, stated)
      : null;

  const asidePhrases = (treatments?.aside ?? [])
    .map((process) => process.phrase)
    .filter((phrase): phrase is string => phrase !== null);
  const { text: afterTreatments, removed } = removePhrases(description, asidePhrases);
  const asideCodes = new Set((treatments?.aside ?? []).map((process) => process.code));
  const keptPhrases = stated
    .filter((process) => !asideCodes.has(process.code))
    .map((process) => process.phrase)
    .filter((phrase): phrase is string => phrase !== null);
  const partPhrases = partPhrasesToRemove(parts, keptPhrases);
  const { text: compareAs, removed: partsRemoved } = removePhrases(afterTreatments, partPhrases);
  const processGroup = treatments?.processGroup ?? null;

  return {
    compareAs,
    termTypes: null,
    processGroup,
    seeds: processGroup === null ? [] : [processGroup.code],
    detail: {
      processes: stated,
      parts,
      ...(treatments?.detail ?? { nature: [] }),
      removed,
      partsRemoved,
      processGroup: processGroup?.code ?? null,
      compareAs,
    },
    treatmentsApplied: removed,
    statedTreatments: treatments?.stated ?? [],
    partsApplied: partsRemoved,
    statedParts: parts.map((part) => part.code),
    named: { processes: stated, parts },
  };
}

/** New-food judgement and group choice for the stated processes. */
async function resolveTreatments(
  cat: Catalogue,
  description: string,
  country: string | null,
  withCountry: boolean,
  model: string,
  stated: readonly StatedProcess[]
): Promise<{
  aside: StatedProcess[];
  processGroup: ProcessGroup | null;
  stated: string[];
  detail: Record<string, unknown>;
}> {
  const countryField = withCountry ? { country } : {};
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

  return {
    aside,
    processGroup,
    stated: [...nature, ...others].map((process) => process.code),
    detail: {
      ...(natureModel !== null ? { natureModel } : {}),
      ...(groupModel !== null ? { groupModel } : {}),
      newFoodCandidates: candidates.map((candidate) => candidate.code),
      nature: nature.map((process) => process.code),
      natureJudged: natureParts.judged,
      natureSkipped: natureParts.skipped,
      natureGroups: natureParts.groups.map((group) => group.code),
      judged: otherParts.judged,
      skipped: otherParts.skipped,
      groups: otherParts.groups.map((group) => group.code),
      aside: aside.map((process) => process.code),
    },
  };
}
