/**
 * Eval helpers for `scripts/lexical-eval.ts` — search recall benchmark only.
 * Identical-word acceptance is specified in `encode/lexical-accept.ts`, not tuned here.
 */

import { evaluateLexicalAccept } from "../encode/lexical-accept.js";
import { searchTerms } from "../search/lexical.js";

export interface LexicalCaseExpect {
  recall_top?: number;
  recall_expect?: "hit" | "miss";
  auto_accept: boolean;
  forbid_accept?: string[];
}

export interface LexicalEvalCase {
  id: string;
  input: string;
  expected?: string;
  source?: string;
  tags?: string[];
  expect: LexicalCaseExpect;
  note?: string;
}

export interface LexicalCaseResult {
  id: string;
  input: string;
  expected: string | null;
  recallTop: number;
  recallRank: number | null;
  recallPass: boolean | null;
  autoAcceptCode: string | null;
  autoAcceptPass: boolean;
  pass: boolean;
  tags: string[];
  note?: string;
}

export function evaluateLexicalCase(
  c: LexicalEvalCase,
  options: { defaultRecallTop?: number } = {}
): LexicalCaseResult {
  const recallTop = c.expect.recall_top ?? options.defaultRecallTop ?? 10;
  const hits = searchTerms(c.input, {
    limit: Math.max(recallTop, 10),
    baseOnly: true,
    underFood: true,
  });
  const accept = evaluateLexicalAccept(c.input, hits);
  const acceptCode = accept?.hit.code ?? null;

  let recallRank: number | null = null;
  let recallPass: boolean | null = null;
  if (c.expected !== undefined) {
    const idx = hits.findIndex((h) => h.code === c.expected);
    recallRank = idx >= 0 ? idx + 1 : null;
    const inTop = recallRank !== null && recallRank <= recallTop;
    recallPass = c.expect.recall_expect === "miss" ? !inTop : inTop;
  }

  const forbid = new Set((c.expect.forbid_accept ?? []).map((code) => code.toUpperCase()));
  const forbidHit = acceptCode !== null && forbid.has(acceptCode);

  let autoAcceptPass: boolean;
  if (c.expect.auto_accept) {
    autoAcceptPass = acceptCode === c.expected && acceptCode !== null;
  } else {
    autoAcceptPass = acceptCode === null;
  }
  if (forbidHit) autoAcceptPass = false;

  return {
    id: c.id,
    input: c.input,
    expected: c.expected ?? null,
    recallTop,
    recallRank,
    recallPass,
    autoAcceptCode: acceptCode,
    autoAcceptPass,
    pass: (recallPass === null || recallPass) && autoAcceptPass,
    tags: c.tags ?? [],
    note: c.note,
  };
}
