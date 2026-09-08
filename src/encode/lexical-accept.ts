/**
 * Identical wording: query and catalogue term name carry the same content words
 * (order-free, after normalization). No fuzzy score path — that cannot be
 * measured or trusted at scale.
 */

import { sameContentTokenSet } from "../search/content-match.js";
import type { SearchCandidate } from "../search/lexical.js";

export interface LexicalAccept {
  hit: SearchCandidate;
}

/** First search hit whose name is identical wording to the query. */
export function evaluateLexicalAccept(
  query: string,
  hits: SearchCandidate[]
): LexicalAccept | null {
  for (const hit of hits) {
    if (sameContentTokenSet(query, hit.name)) {
      return { hit };
    }
  }
  return null;
}
