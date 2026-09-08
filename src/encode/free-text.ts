/**
 * Format free-text residual entries.
 *
 * Free text is not part of the FoodEx2 code string, but unlabeled values lose
 * meaning — so we keep role=value entries (e.g. dish=boeuf bourguignon).
 */

import type { FreeTextEntry } from "./types.js";

export function formatFreeText(entries: FreeTextEntry[] | null | undefined): string | null {
  if (entries === null || entries === undefined || entries.length === 0) return null;
  return entries.map((e) => `${e.label}=${e.value}`).join("; ");
}
