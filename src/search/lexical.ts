/**
 * Lexical search over the MTX catalogue.
 *
 * Token / fuzzy / phonetic ranking ported from the Round 3 encoder (itself from
 * foodex2-atlas). Index is built in-process from catalogue.json + search-names.json.
 *
 * For this experiment's base-term slice, callers typically pass
 * `{ baseOnly: true, underFood: true }` — `underFood` means in the exposure tree.
 */

import { Catalogue, isBaseCandidate, isInExposureTree } from "../catalogue.js";
import { FUNCTION_WORDS, sameContentTokenSetFuzzy } from "./content-match.js";
import {
  doubleMetaphone,
  tokenize,
  trigrams,
} from "./encode.js";

export interface SearchCandidate {
  code: string;
  name: string;
  termType: string | null;
  detailLevel: string | null;
  deprecated: boolean;
  /** Facet categories (e.g. ["F27"]) this term is a descriptor of. */
  facetCategories: string[];
  /** Reportable non-hierarchy term in the report hierarchy. */
  baseCandidate: boolean;
  /** Under Food (A0B6Z) in the report hierarchy (includes the root). */
  underFood: boolean;
  score: number;
}

interface IndexedTerm {
  code: string;
  name: string;
  termType: string | null;
  detailLevel: string | null;
  deprecated: boolean;
  facetCategories: string[];
  baseCandidate: boolean;
  underFood: boolean;
  nameTokenCount: number;
}

interface LexicalIndex {
  terms: IndexedTerm[];
  /** token -> postings, each = termIndex * 4 + tier. Tiers: 0 name, 1 code, 2 extra names. */
  tokens: Map<string, number[]>;
  sortedTokens: string[];
  phonetic: Map<string, string[]>;
  trigrams: Map<string, string[]>;
}

// Ranking weights (from atlas query.mjs).
const COVERAGE_WEIGHT = 10;
const EXACT_TOKEN_SCORE = 1.0;
const PREFIX_TOKEN_FACTOR = 0.6;
const LABEL_COVERAGE_WEIGHT = 3;
const FIELD_WEIGHTS = [1.0, 1.0, 0.7]; // name, code, extra names
const MIN_QUERY_LENGTH = 2;
const MIN_FUZZY_QUERY_LENGTH = 3;
const MAX_LENGTH_DELTA = 2;
const FUZZY_WEIGHT = 0.95;
const MIN_TOKEN_SCORE = 0.6;

const TERM_CODE_PATTERN = /^(?=.*[0-9])[A-Z][A-Z0-9]{4}$/;

let index: LexicalIndex | null = null;

function buildIndex(): LexicalIndex {
  const cat = Catalogue.load();
  const facetCategoryHierarchies: Array<[string, string]> = Object.entries(
    cat.data.facetCategories
  ).map(([code, def]) => [code, def.hierarchyCode]);

  const terms: IndexedTerm[] = [];
  const tokens = new Map<string, number[]>();
  const phonetic = new Map<string, string[]>();
  const trigramIndex = new Map<string, string[]>();

  for (const [code, term] of Object.entries(cat.data.terms)) {
    const name = term.name ?? "";
    if (name === "") continue;

    const facetCategories = facetCategoryHierarchies
      .filter(([, hierarchy]) => hierarchy in term.hierarchies)
      .map(([category]) => category);

    const termIndex = terms.length;
    const nameTokens = new Set(tokenize(name));
    terms.push({
      code,
      name,
      termType: term.termType,
      detailLevel: term.detailLevel,
      deprecated: term.status === "DEPRECATED",
      facetCategories,
      baseCandidate: isBaseCandidate(term),
      underFood: isInExposureTree(term),
      nameTokenCount: nameTokens.size,
    });

    const sources: Array<[number, string[]]> = [
      [0, [name]],
      [1, [code]],
      [2, cat.altNames(code)],
    ];
    const seen = new Set<string>();
    for (const [tier, texts] of sources) {
      for (const text of texts) {
        for (const token of tokenize(text)) {
          if (seen.has(token)) continue;
          seen.add(token);
          const bucket = tokens.get(token);
          const posting = termIndex * 4 + tier;
          if (bucket === undefined) tokens.set(token, [posting]);
          else bucket.push(posting);
        }
      }
    }
  }

  for (const token of tokens.keys()) {
    if (token.length < 3) continue;
    const code = doubleMetaphone(token);
    if (code !== "") {
      const bucket = phonetic.get(code);
      if (bucket === undefined) phonetic.set(code, [token]);
      else bucket.push(token);
    }
    for (const gram of trigrams(token)) {
      const bucket = trigramIndex.get(gram);
      if (bucket === undefined) trigramIndex.set(gram, [token]);
      else bucket.push(token);
    }
  }

  return {
    terms,
    tokens,
    sortedTokens: [...tokens.keys()].sort(),
    phonetic,
    trigrams: trigramIndex,
  };
}

function getIndex(): LexicalIndex {
  if (index === null) index = buildIndex();
  return index;
}

// -- fuzzy scoring (from atlas) --------------------------------------------

const ADJACENT_KEYS = new Set([
  "qw", "wq", "we", "ew", "er", "re", "rt", "tr", "ty", "yt", "yu", "uy", "ui", "iu", "io", "oi", "op", "po",
  "as", "sa", "sd", "ds", "df", "fd", "fg", "gf", "gh", "hg", "hj", "jh", "jk", "kj", "kl", "lk",
  "zx", "xz", "xc", "cx", "cv", "vc", "vb", "bv", "bn", "nb", "nm", "mn",
]);

function damerauLevenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const d: number[][] = [];
  for (let i = 0; i <= al; i++) d[i] = [i];
  for (let j = 0; j <= bl; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const di = d[i] as number[];
      const dim1 = d[i - 1] as number[];
      di[j] = Math.min(
        (dim1[j] as number) + 1,
        (di[j - 1] as number) + 1,
        (dim1[j - 1] as number) + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        di[j] = Math.min(di[j] as number, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
    }
  }
  return (d[al] as number[])[bl] as number;
}

function singleAdjacentSubstitution(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      if (diff !== -1) return false;
      diff = i;
    }
  }
  return diff !== -1 && ADJACENT_KEYS.has(a[diff]! + b[diff]!);
}

function charOverlapRatio(a: string, b: string): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let shared = 0;
  for (const c of sa) if (sb.has(c)) shared++;
  return shared / Math.max(sa.size, sb.size);
}

function scoreToken(queryToken: string, candidate: string): number {
  if (queryToken === candidate) return 1;
  const dist = damerauLevenshtein(queryToken, candidate);
  const maxLen = Math.max(queryToken.length, candidate.length);
  let edit = 0;
  if (dist === 1) edit = singleAdjacentSubstitution(queryToken, candidate) ? 0.9 : 0.85;
  else if (dist === 2 && maxLen >= 6) edit = 0.6;
  let phon = 0;
  const qm = doubleMetaphone(queryToken);
  const cm = doubleMetaphone(candidate);
  if (qm !== "" && cm !== "") {
    if (qm === cm) {
      const overlap = charOverlapRatio(queryToken, candidate);
      phon = overlap >= 0.6 ? 0.8 : overlap >= 0.4 ? 0.72 : 0.62;
    } else if (cm.startsWith(qm) && cm.length === qm.length + 1) {
      phon = 0.62;
    }
  }
  return Math.max(edit, phon);
}

function candidateTokens(idx: LexicalIndex, queryToken: string): Set<string> {
  const set = new Set<string>();
  const code = doubleMetaphone(queryToken);
  for (const t of (code !== "" ? idx.phonetic.get(code) : undefined) ?? []) set.add(t);
  const grams = trigrams(queryToken);
  const overlap = new Map<string, number>();
  for (const gram of grams) {
    for (const t of idx.trigrams.get(gram) ?? []) {
      overlap.set(t, (overlap.get(t) ?? 0) + 1);
    }
  }
  const need = grams.length <= 2 ? 1 : 2;
  for (const [t, count] of overlap) if (count >= need) set.add(t);
  return set;
}

function lowerBound(sorted: string[], prefix: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as string) < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface TokenMatch {
  score: number;
  labelHit: boolean;
}

function postingsForQueryToken(idx: LexicalIndex, queryToken: string): Map<number, TokenMatch> {
  const best = new Map<number, TokenMatch>();
  const consider = (token: string, score: number, isFuzzy = false): void => {
    const postings = idx.tokens.get(token);
    if (postings === undefined) return;
    for (const posting of postings) {
      const termIndex = posting >> 2;
      const tier = posting & 3;
      const weighted = score * (FIELD_WEIGHTS[tier] as number);
      const entry = best.get(termIndex);
      if (entry === undefined) {
        best.set(termIndex, { score: weighted, labelHit: tier === 0 && !isFuzzy });
      } else {
        if (weighted > entry.score) entry.score = weighted;
        if (tier === 0 && !isFuzzy) entry.labelHit = true;
      }
    }
  };

  consider(queryToken, EXACT_TOKEN_SCORE);

  const list = idx.sortedTokens;
  for (let i = lowerBound(list, queryToken); i < list.length; i++) {
    const token = list[i] as string;
    if (!token.startsWith(queryToken)) break;
    if (token === queryToken) continue;
    consider(token, PREFIX_TOKEN_FACTOR * (queryToken.length / token.length));
  }

  if (queryToken.length >= MIN_FUZZY_QUERY_LENGTH) {
    for (const candidate of candidateTokens(idx, queryToken)) {
      if (candidate === queryToken) continue;
      if (Math.abs(candidate.length - queryToken.length) > MAX_LENGTH_DELTA) continue;
      const s = scoreToken(queryToken, candidate);
      if (s >= MIN_TOKEN_SCORE) consider(candidate, s * FUZZY_WEIGHT, true);
    }
  }

  return best;
}

export interface SearchOptions {
  limit?: number;
  /** Keep only base-term candidates. */
  baseOnly?: boolean;
  /** Keep only terms in the exposure food hierarchy. */
  underFood?: boolean;
  /** Keep only descriptors of this facet category (e.g. "F28"). */
  facetCategory?: string;
  /** Keep only facet descriptors (any category). */
  descriptorsOnly?: boolean;
  /** Keep only Corex-M generic base terms. */
  genericOnly?: boolean;
  /** Include deprecated terms (default false). */
  includeDeprecated?: boolean;
}

function toCandidate(term: IndexedTerm, score: number): SearchCandidate {
  return {
    code: term.code,
    name: term.name,
    termType: term.termType,
    detailLevel: term.detailLevel,
    deprecated: term.deprecated,
    facetCategories: term.facetCategories,
    baseCandidate: term.baseCandidate,
    underFood: term.underFood,
    score,
  };
}

export function searchTerms(rawQuery: string, options: SearchOptions = {}): SearchCandidate[] {
  const {
    limit = 10,
    baseOnly = false,
    underFood = false,
    facetCategory,
    descriptorsOnly = false,
    includeDeprecated = false,
    genericOnly = false,
  } = options;
  const idx = getIndex();
  const query = String(rawQuery ?? "").trim();
  if (query.length < MIN_QUERY_LENGTH) return [];

  const keep = (term: IndexedTerm): boolean => {
    if (!includeDeprecated && term.deprecated) return false;
    if (baseOnly && !term.baseCandidate) return false;
    if (underFood && !term.underFood) return false;
    if (facetCategory !== undefined && !term.facetCategories.includes(facetCategory)) return false;
    if (descriptorsOnly && term.facetCategories.length === 0) return false;
    if (genericOnly && !(term.baseCandidate && term.detailLevel === "M")) return false;
    return true;
  };

  const codeCandidate = query.toUpperCase();
  if (TERM_CODE_PATTERN.test(codeCandidate)) {
    const term = idx.terms.find((t) => t.code === codeCandidate);
    return term !== undefined && keep(term) ? [toCandidate(term, 1)] : [];
  }

  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const content = tokens.filter((t) => !FUNCTION_WORDS.has(t));
  const queryTokens = content.length > 0 ? content : tokens;

  const acc = new Map<number, { matched: number; score: number; labelMatched: number }>();
  for (const queryToken of queryTokens) {
    for (const [termIndex, { score, labelHit }] of postingsForQueryToken(idx, queryToken)) {
      const entry = acc.get(termIndex) ?? { matched: 0, score: 0, labelMatched: 0 };
      entry.matched += 1;
      entry.score += score;
      if (labelHit) entry.labelMatched += 1;
      acc.set(termIndex, entry);
    }
  }

  const results: SearchCandidate[] = [];
  for (const [termIndex, { matched, score, labelMatched }] of acc) {
    const term = idx.terms[termIndex] as IndexedTerm;
    if (!keep(term)) continue;
    const coverage = matched / queryTokens.length;
    const labelCoverage = term.nameTokenCount
      ? Math.min(labelMatched / term.nameTokenCount, 1)
      : 0;
    results.push(
      toCandidate(
        term,
        coverage * COVERAGE_WEIGHT + score + labelCoverage * LABEL_COVERAGE_WEIGHT
      )
    );
  }

  // Content-set matches (same words both ways, order-free) outrank partial recall hits.
  results.sort((a, b) => {
    const aSet = sameContentTokenSetFuzzy(query, a.name);
    const bSet = sameContentTokenSetFuzzy(query, b.name);
    if (aSet !== bSet) return aSet ? -1 : 1;
    return b.score - a.score || a.name.length - b.name.length;
  });
  return results.slice(0, limit);
}
