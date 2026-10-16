import type { ParsedCode, ParsedFacet } from "./types.js";

const TERM_CODE = /^[A-Z0-9]{5}$/;
const FACET_CODE = /^F\d\d$/;

/**
 * Split a full FoodEx2 code (BASE or BASE#Fxx.CODE$Fyy.CODE...). Never throws;
 * every part that does not fit the format is reported in `problems`.
 */
export function parseCode(raw: string): ParsedCode {
  const input = String(raw).trim().toUpperCase();
  const problems: string[] = [];
  const [basePart, facetPart, ...rest] = input.split("#");
  if (rest.length > 0) problems.push("More than one '#' separator.");

  const base = basePart ? basePart : null;
  if (base === null) problems.push("Missing base term before '#'.");
  else if (!TERM_CODE.test(base)) problems.push(`Base term '${base}' is not a 5-character term code.`);

  const facets: ParsedFacet[] = [];
  if (facetPart !== undefined) {
    if (facetPart === "") problems.push("Nothing after '#'.");
    for (const part of facetPart === "" ? [] : facetPart.split("$")) {
      const [facet, code, ...extra] = part.split(".");
      if (!facet || !code || extra.length > 0 || !FACET_CODE.test(facet) || !TERM_CODE.test(code)) {
        problems.push(`'${part}' is not a facet in the form Fxx.CODE.`);
        continue;
      }
      facets.push({ facet, code });
    }
  }

  return { input, base: base !== null && TERM_CODE.test(base) ? base : null, facets, problems };
}

/** Term codes a parsed code states (base term and facet descriptors). */
export function statedCodes(parsed: ParsedCode): string[] {
  const codes = new Set<string>();
  if (parsed.base !== null) codes.add(parsed.base);
  for (const f of parsed.facets) codes.add(f.code);
  return [...codes];
}

/** Descriptor codes from "F27.A000M"-style implied facet keys. */
export function impliedCodes(implied: string[]): string[] {
  return implied.map((key) => key.slice(key.indexOf(".") + 1));
}
