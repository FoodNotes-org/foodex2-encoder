import type { Catalogue } from "../catalogue.js";

/** One characteristic a catalogue class already entails. */
export interface EntailedProperty {
  kind: string;
  name: string;
}

/**
 * Characteristics the class entails, for a classify payload.
 * Empty when the term carries none. Callers omit the field in that case.
 */
export function entailedProperties(cat: Catalogue, code: string): EntailedProperty[] {
  const out: EntailedProperty[] = [];
  for (const key of cat.impliedFacets(code)) {
    const dot = key.indexOf(".");
    if (dot <= 0) continue;
    const header = key.slice(0, dot);
    const termCode = key.slice(dot + 1);
    if (termCode === "") continue;
    out.push({
      kind: cat.facetCategory(header)?.label ?? header,
      name: cat.term(termCode)?.name ?? termCode,
    });
  }
  return out;
}
