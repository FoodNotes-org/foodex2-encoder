/**
 * For a foodstuff, a process normally applied straight to a raw commodity
 * (guidance Table 22) is a facet only when no catalogue group already implies
 * that process. A group that does is a candidate for the base, and the walk
 * keeps the whole description. When none of those groups is the food, the walk
 * compares the food without that process. Drying is not in the table, so it
 * stays in the description. A dish or a mix is not handled here.
 */

import { Catalogue, isInExposureTree } from "../catalogue.js";
import { countryParagraph } from "../country.js";
import { chatJson } from "../llm.js";

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
  exception: boolean;
}

export interface ProcessGroup {
  code: string;
  name: string;
  /** Table 22 processes this term already implies, among those stated. */
  processes: string[];
}

interface ImpliedGroup {
  code: string;
  name: string;
  note: string | null;
}

let cachedProcessCodes: Set<string> | null = null;
let cachedImplied: Map<string, ImpliedGroup[]> | null = null;

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
  const allowed = table22ProcessCodes(cat);
  const index = new Map<string, ImpliedGroup[]>();
  for (const [code, term] of Object.entries(cat.data.terms)) {
    if (term.termType === "f" || term.status === "DEPRECATED") continue;
    if (!isInExposureTree(term)) continue;
    for (const facet of cat.impliedFacets(code)) {
      if (!facet.startsWith("F28.")) continue;
      const process = facet.slice("F28.".length);
      if (!allowed.has(process)) continue;
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

/** Exposure terms, other than facet descriptors, that already imply this process. */
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
    out.push({ code, exception: (item as { exception?: unknown }).exception === true });
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

export function parseRemainingFood(content: unknown): string | null {
  if (content === null || typeof content !== "object") return null;
  const food = (content as { food?: unknown }).food;
  if (typeof food !== "string") return null;
  const trimmed = food.trim();
  return trimmed === "" ? null : trimmed;
}

function systemStatedProcesses(withCountry: boolean): string {
  return `You are an expert in food classification.

Task: name which of these processes, if any, the description states.

Given:
- \`description\`: the food description.
- \`processes\`: each has a \`code\` and a \`name\`. A process and the processes under it are both listed.
${countryParagraph(withCountry, "description")}
Return the most specific process the description states.

Frying or roasting potatoes, cooking eggs, caramelising or browning sugar or milk, mincing meat, milling cereal grains, and mashing that produces a purée are exceptions: a group for that food already exists. For an exception, \`exception\` is true. Otherwise it is false.

Reply with JSON only:
{"processes":[{"code":"<code>","exception":true|false}]}

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

Reply with JSON only:
{"code":"<code>"|null}`;
}

function systemRemainingFood(withCountry: boolean): string {
  return `You are an expert in food classification.

Task: name the food these processes are applied to.

Given:
- \`description\`: the food description.
- \`processes\`: the processes to set aside. Each has a \`code\` and a \`name\`.
${countryParagraph(withCountry, "description")}
The answer is that food, without those processes. A minor ingredient used only to carry a process out is not part of the answer.

Reply with JSON only:
{"food":"<food>"}`;
}

export interface BaseCompare {
  compareAs: string;
  /** Always null: a match is kept whatever its catalogue type. */
  termTypes: null;
  /** Term that already implies a stated process and is this food. Seeded into the walk. */
  processGroup: ProcessGroup | null;
  seeds: string[];
  detail: Record<string, unknown>;
}

function unchanged(description: string, detail: Record<string, unknown>): BaseCompare {
  return {
    compareAs: description,
    termTypes: null,
    processGroup: null,
    seeds: [],
    detail: { ...detail, compareAs: description, processGroup: null },
  };
}

/** Foodstuff only. A dish or a mix keeps the description as given. */
export async function resolveBaseCompare(
  description: string,
  country: string | null,
  model: string
): Promise<BaseCompare> {
  const cat = Catalogue.load();
  const allowed = table22ProcessCodes(cat);
  const withCountry = country !== null && country !== "";
  const processes = [...allowed]
    .map((code) => ({ code, name: cat.term(code)?.name ?? code }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const statedCall = await chatJson({
    model,
    system: systemStatedProcesses(withCountry),
    user: JSON.stringify(
      { description, ...(withCountry ? { country } : {}), processes },
      null,
      2
    ),
  });
  const stated = parseStatedProcesses(statedCall.content, allowed);
  if (stated === null || stated.length === 0) {
    return unchanged(description, {
      model: statedCall.model,
      parsed: stated !== null,
      processes: [],
    });
  }

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

  let processGroup: ProcessGroup | null = null;
  let groupModel: string | null = null;
  if (groups.length > 0) {
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
    groupModel = groupCall.model;
    const picked = parseProcessGroup(groupCall.content, allowedGroups);
    if (picked?.code !== null && picked !== null) {
      const term = cat.term(picked.code);
      const implied = stated
        .map((process) => process.code)
        .filter((process) => termImpliesProcesses(cat, picked.code as string, [process]));
      processGroup = {
        code: picked.code,
        name: term?.name ?? picked.code,
        processes: implied,
      };
    }
  }

  let compareAs = description;
  let remainingModel: string | null = null;
  if (processGroup === null) {
    const aside = stated.filter((process) => !process.exception);
    if (aside.length > 0) {
      const remainingCall = await chatJson({
        model,
        system: systemRemainingFood(withCountry),
        user: JSON.stringify(
          {
            description,
            ...(withCountry ? { country } : {}),
            processes: aside.map((process) => ({
              code: process.code,
              name: cat.term(process.code)?.name ?? process.code,
            })),
          },
          null,
          2
        ),
      });
      remainingModel = remainingCall.model;
      compareAs = parseRemainingFood(remainingCall.content) ?? description;
    }
  }

  return {
    compareAs,
    termTypes: null,
    processGroup,
    seeds: processGroup === null ? [] : [processGroup.code],
    detail: {
      model: statedCall.model,
      ...(groupModel !== null ? { groupModel } : {}),
      ...(remainingModel !== null ? { remainingModel } : {}),
      processes: stated,
      judged,
      skipped,
      groups: groups.map((group) => group.code),
      processGroup: processGroup?.code ?? null,
      compareAs,
    },
  };
}
