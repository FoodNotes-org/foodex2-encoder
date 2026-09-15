/**
 * Identical wording: query and catalogue term name carry the same words
 * (order-free, exact). Function words count — "from" is not noise.
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
