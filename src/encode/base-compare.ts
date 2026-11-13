/**
 * For a foodstuff, a process that produces a different kind of food from the
 * foods it applies to (guidance Tables 4 and 5, rules/efsa-processes.yaml) is
 * checked first. A group that already implies it can be the
 * base, and that process stays in the description. A process normally applied
 * straight to a raw commodity (guidance Table 22) is then taken out of the
 * description the base is matched against, unless a catalogue group that
 * already implies it is this food: the model names the words that state it,
 * and code cuts them out. The original description is what the facets
 * are read from. A Table 22 process that only restates a process already found
 * is not taken. A dish or a mix is not handled here.
 */

import { Catalogue, DEFAULT_HIERARCHY, isInExposureTree } from "../catalogue.js";
import { isHierarchyTerm } from "../rules/check.js";
import { countryParagraph } from "../country.js";
import { chatJson } from "../llm.js";
import { NEW_FOOD_TREATMENTS } from "../rules/processes.js";

/** Process hierarchy, where Table 22 child descriptors sit. */
const PROCESS_HIERARCHY = "process";

/**
 * A process with more groups than this is the broad parent (cooking, chilling).
 * The specific process the description states is the one to judge.
 */
const MAX_IMPLIED_GROUPS = 15;

/**
 * Codes named in guidance Table 22. Descendants in the process hierarchy are
 * included: the table covers those processes and their child descriptors.
 */
const TABLE22_ROOTS = [
  "A07KS",
  "A07KT",
  "A07KV",
  "A07KX",
  "A07KY",
  "A07KZ",
  "A07LA",
  "A0C6N",
  "A07JB",
  "A0BZG",
  "A0BZL",
  "A07JE",
  "A07JF",
  "A07JG",
  "A07JH",
  "A07JC",
  "A07JD",
  "A07JJ",
  "A0CSQ",
  "A07KN",
  "A07KP",
  "A07KQ",
  "A07KR",
  "A07HR",
  "A07HT",
  "A07HV",
  "A07HX",
  "A07HY",
  "A07HZ",
  "A07JA",
  "A0BA1",
  "A0BYN",
  "A07JK",
  "A07HK",
  "A07HL",
  "A07HM",
  "A07HN",
  "A07HP",
  "A07HQ",
] as const;

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
let cachedNatureCodes: Set<string> | null = null;
let cachedImplied: Map<string, ImpliedGroup[]> | null = null;

/** Processes named in Tables 4 and 5 that this catalogue still contains. */
export function natureProcessCodes(cat: Catalogue): ReadonlySet<string> {
  if (cachedNatureCodes !== null) return cachedNatureCodes;
  cachedNatureCodes = new Set(
    NEW_FOOD_TREATMENTS.map((row) => row.code).filter((code) => cat.term(code) !== undefined)
  );
  return cachedNatureCodes;
}

/** Tables 4 and 5 rows as the model sees them: EFSA's foods and outcomes for each. */
function listedNatureTreatments(
  cat: Catalogue
): Array<{ code: string; name: string; applied_to: string; leads_to: string }> {
  const codes = natureProcessCodes(cat);
  return NEW_FOOD_TREATMENTS.filter((row) => codes.has(row.code)).map((row) => ({
    code: row.code,
    name: cat.term(row.code)?.name ?? row.code,
    applied_to: row.appliedTo,
    leads_to: row.leadsTo,
  }));
}

export function table22ProcessCodes(cat: Catalogue): ReadonlySet<string> {
  if (cachedProcessCodes !== null) return cachedProcessCodes;
  const codes = new Set<string>();
  const stack: string[] = [...TABLE22_ROOTS];
  while (stack.length > 0) {
    const code = stack.pop() as string;
    if (codes.has(code) || cat.term(code) === undefined) continue;
    codes.add(code);
    for (const child of cat.children(code, PROCESS_HIERARCHY)) stack.push(child);
  }
  cachedProcessCodes = codes;
  return codes;
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

function systemNatureProcesses(withCountry: boolean): string {
  return `You are an expert in food classification.

Task: name which of these treatments, if any, the description states and, for this food, make a different kind of food.

Given:
- \`description\`: the food description.
- \`treatments\`: each has a \`code\`, a \`name\`, \`applied_to\` (the foods it makes a different kind of food from) and \`leads_to\` (the kinds of food it makes).
${countryParagraph(withCountry, "description")}
A treatment counts only when the food it was applied to is one of its \`applied_to\` foods.

Reply with JSON only:
{"processes":[{"code":"<code>"}]}

An empty list means no stated treatment makes this food a different kind of food.`;
}

function systemStatedProcesses(withCountry: boolean): string {
  return `You are an expert in food classification.

Task: name which of these processes, if any, the description states, and the words that state each.

Given:
- \`description\`: the food description.
- \`processes\`: each has a \`code\` and a \`name\`. A process and the processes under it are both listed.
- \`already\`: processes already found. Each has a \`code\` and a \`name\`.
${countryParagraph(withCountry, "description")}
Return the most specific process the description states. A process that only restates a process in \`already\` is not stated.

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
  /** Words taken out of the description, each stating a Table 22 treatment. */
  treatmentsApplied: string[];
  /** Every treatment found stated: new-food ones first, then Table 22 ones. */
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

/** Table 22 treatments to take out of the description. A treatment the chosen group already covers stays. */
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

  const natureCall = await chatJson({
    model,
    system: systemNatureProcesses(withCountry),
    user: JSON.stringify(
      { description, ...countryField, treatments: listedNatureTreatments(cat) },
      null,
      2
    ),
  });
  const nature = parseStatedProcesses(natureCall.content, natureProcessCodes(cat)) ?? [];
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

  const already = listedProcesses(
    cat,
    nature.map((process) => process.code)
  );
  const statedCall = await chatJson({
    model,
    system: systemStatedProcesses(withCountry),
    user: JSON.stringify(
      {
        description,
        ...countryField,
        processes: listedProcesses(cat, table22ProcessCodes(cat)),
        already,
      },
      null,
      2
    ),
  });
  const stated = parseStatedProcesses(statedCall.content, table22ProcessCodes(cat)) ?? [];
  const natureCodes = new Set(nature.map((process) => process.code));
  const table22Only = stated.filter((process) => !natureCodes.has(process.code));
  const table22Parts = groupsForProcesses(cat, table22Only);

  let processGroup = natureChoice.processGroup;
  let groupModel = natureChoice.model;
  if (processGroup === null) {
    const table22Choice = await chooseProcessGroup(
      cat,
      description,
      country,
      withCountry,
      model,
      table22Only,
      table22Parts.groups
    );
    processGroup = table22Choice.processGroup;
    groupModel = table22Choice.model ?? groupModel;
  }

  const aside = processesToSetAside(table22Only, processGroup?.processes ?? []);
  const { text: compareAs, removed } = removePhrases(
    description,
    aside.map((process) => process.phrase).filter((phrase): phrase is string => phrase !== null)
  );

  if (nature.length === 0 && stated.length === 0) {
    return unchanged(description, {
      model: natureCall.model,
      table22Model: statedCall.model,
      parsed: natureCall.content !== null && statedCall.content !== null,
      nature: [],
      processes: [],
    });
  }

  return {
    compareAs,
    termTypes: null,
    processGroup,
    seeds: processGroup === null ? [] : [processGroup.code],
    detail: {
      model: natureCall.model,
      table22Model: statedCall.model,
      ...(groupModel !== null ? { groupModel } : {}),
      nature: nature.map((process) => process.code),
      natureJudged: natureParts.judged,
      natureSkipped: natureParts.skipped,
      natureGroups: natureParts.groups.map((group) => group.code),
      processes: stated,
      judged: table22Parts.judged,
      skipped: table22Parts.skipped,
      groups: table22Parts.groups.map((group) => group.code),
      aside: aside.map((process) => process.code),
      removed,
      processGroup: processGroup?.code ?? null,
      compareAs,
    },
    treatmentsApplied: removed,
    statedTreatments: [...nature, ...table22Only].map((process) => process.code),
  };
}
