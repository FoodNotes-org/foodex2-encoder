/**
 * Order-free word matching shared by lexical search and identical-word accept.
 *
 * Function words are *not* stripped here: words like "from" / "with" can change
 * meaning ("orange juice from concentrate" ≠ "Juice concentrate, orange").
 * Lexical *search* still drops function words when building query postings.
 */

import { tokenize } from "./encode.js";

/** Dropped only when building lexical search query tokens (recall), not for identity. */
export const FUNCTION_WORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it",
  "its", "of", "on", "or", "that", "the", "then", "there", "these", "this", "to", "was", "were",
]);

/** All tokens after normalize/tokenize — including function words. */
export function contentTokens(text: string): Set<string> {
  return new Set(tokenize(text));
}

/** Bidirectional word-set equality ("orange juice" = "Juice, orange"; "cabbage" ≠ "Red cabbages"). */
export function sameContentTokenSet(query: string, termName: string): boolean {
  const q = contentTokens(query);
  const n = contentTokens(termName);
  if (q.size === 0 || q.size !== n.size) return false;
  for (const t of q) if (!n.has(t)) return false;
  return true;
}

/** One edit or shared prefix — catches yogurt/yoghurt (and minor typos) per token. */
function tokenMatchesOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  if (a.length < 4 || b.length < 4) return false;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    if (m > n) i++;
    else if (n > m) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (m - i) + (n - j) <= 1;
}

/** Every query word pairs (one edit allowed) with a distinct name word; name words may be left over. */
function eachQueryWordPairs(queryWords: string[], nameWords: string[]): boolean {
  const used = new Set<number>();
  for (const word of queryWords) {
    const i = nameWords.findIndex((n, idx) => !used.has(idx) && tokenMatchesOneEdit(word, n));
    if (i === -1) return false;
    used.add(i);
  }
  return true;
}

/**
 * Like sameContentTokenSet but allows one edit per token pairing (yogurt/yoghurt).
 * Still bidirectional: equal-sized sets, every query word paired to a distinct name word.
 */
export function sameContentTokenSetFuzzy(query: string, termName: string): boolean {
  const q = [...contentTokens(query)];
  const n = [...contentTokens(termName)];
  if (q.length === 0 || q.length !== n.length) return false;
  return eachQueryWordPairs(q, n);
}

/**
 * Every query word appears in the name (fuzzy); the name may carry extra words.
 * For identical wording use sameContentTokenSet instead.
 */
export function queryContentWordsInNameFuzzy(query: string, termName: string): boolean {
  const q = [...contentTokens(query)];
  const n = [...contentTokens(termName)];
  if (q.length === 0) return false;
  return eachQueryWordPairs(q, n);
}

function contentTokenList(text: string): string[] {
  return [...contentTokens(text)];
}

/** Longest phrase first: full content-set, then suffix subphrases. */
function seedSubphrases(query: string): string[] {
  const tokens = contentTokenList(query);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    out.push(tokens.slice(i).join(" "));
  }
  return out;
}

export interface ContentSetSeedPick {
  hit: { code: string; name: string; score: number };
  matchedPhrase: string;
}

/**
 * Pick a lexical seed for a phrase walk.
 * Single-word phrases: bidirectional content-set (cabbage ≠ Red cabbages).
 * Multi-word phrases: every phrase word in the name; name may add detail (ice cream → Ice cream, milk-based).
 */
export function pickContentSetSeedHit(
  query: string,
  hits: ContentSetSeedPick["hit"][]
): ContentSetSeedPick | undefined {
  for (const phrase of seedSubphrases(query)) {
    const words = contentTokenList(phrase);
    for (const hit of hits) {
      const matches =
        words.length === 1
          ? sameContentTokenSetFuzzy(phrase, hit.name)
          : queryContentWordsInNameFuzzy(phrase, hit.name);
      if (matches) return { hit, matchedPhrase: phrase };
    }
  }
  return undefined;
}
