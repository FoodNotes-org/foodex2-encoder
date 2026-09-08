/**
 * Project the full encode result to the chat-facing shape.
 */

import { buildExplanation } from "./explanation.js";
import { formatFoodEx2Code } from "./foodex2-code.js";
import type { EncodeResult, EncodeUserResult } from "./types.js";

/** Drop audit / candidates / scored / walks — keep what a user needs to read the code. */
export function toUserEncodeResult(result: EncodeResult): EncodeUserResult {
  if (result.status !== "ok") {
    return { status: "rejected", message: result.message };
  }
  const facets = result.facets ?? [];
  return {
    status: "ok",
    code: result.code ?? formatFoodEx2Code(result.baseTerm.code, facets),
    baseTerm: result.baseTerm,
    facets,
    freeText: result.freeText ?? [],
    fit: result.fit ?? null,
    method: result.method,
    explanation: buildExplanation(result),
  };
}
