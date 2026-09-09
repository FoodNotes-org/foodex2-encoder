/**
 * Compact human-readable account of an encode — defend the code without
 * dumping classifications. Built from the typed result; no extra model call.
 */

import type {
  AuditEntry,
  DescriptionKind,
  EncodeOk,
  FacetDescriptorRef,
  FreeTextEntry,
} from "./types.js";

function kindPhrase(kind: DescriptionKind): string {
  switch (kind) {
    case "foodstuff":
      return "a single foodstuff";
    case "dish":
      return "a named dish";
    case "dish_type":
      return "a dish type";
    case "mix":
      return "a mix";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function facetRef(value: unknown): FacetDescriptorRef | null {
  if (!isRecord(value)) return null;
  const header = value.header;
  const code = value.code;
  const name = value.name;
  if (
    typeof header !== "string" ||
    typeof code !== "string" ||
    typeof name !== "string"
  ) {
    return null;
  }
  return { header, code, name };
}

function freeTextRef(value: unknown): FreeTextEntry | null {
  if (!isRecord(value)) return null;
  const label = value.label;
  const text = value.value;
  if (typeof label !== "string" || typeof text !== "string") return null;
  return { label, value: text };
}

/** Lines from residual place resolutions (phrase → facet or free text). */
function placementLines(audit: AuditEntry[]): string[] {
  const lines: string[] = [];
  for (const entry of audit) {
    if (entry.step !== "residuals_place") continue;
    const resolutions = entry.detail.resolutions;
    if (!Array.isArray(resolutions)) continue;
    for (const raw of resolutions) {
      if (!isRecord(raw)) continue;
      const phrase = typeof raw.phrase === "string" ? raw.phrase : null;
      if (raw.placed === "facet") {
        const facet = facetRef(raw.facet);
        if (facet === null) continue;
        lines.push(
          phrase !== null
            ? `"${phrase}" encoded as ${facet.name} (${facet.header}.${facet.code}).`
            : `Added facet ${facet.name} (${facet.header}.${facet.code}).`
        );
      } else if (raw.placed === "freeText") {
        const ft = freeTextRef(raw.freeText);
        if (ft === null) continue;
        lines.push(
          phrase !== null
            ? `"${phrase}" left as ${ft.label}=${ft.value} (no matching facet).`
            : `Left as ${ft.label}=${ft.value}.`
        );
      }
    }
  }
  return lines;
}

const MAX_LINES = 10;

/**
 * 5–10 prose lines: how the base was found, what fit means, and how each
 * residual was placed. Safe to show in chat.
 */
export function buildExplanation(result: EncodeOk): string[] {
  const lines: string[] = [];

  if (result.method === "lexical") {
    lines.push(
      `Matched the catalogue name "${result.baseTerm.name}" (${result.baseTerm.code}) by identical wording.`
    );
  } else {
    if (result.descriptionKind) {
      lines.push(`Read the description as ${kindPhrase(result.descriptionKind)}.`);
    }

    const walked = (result.walks ?? []).some(
      (w) => w.status === "completed" && w.classifySteps > 0
    );
    if (walked) {
      lines.push("Walked the food tree for the whole description.");
    }

    const shortlisted = (result.scored ?? []).filter((s) => s.shortlisted);
    let pick = `Chose ${result.baseTerm.name} (${result.baseTerm.code})`;
    if (result.fit !== undefined) {
      pick += result.fit === "exact" ? " as an exact fit" : ` as a ${result.fit} fit`;
    }
    if (shortlisted.length > 1) {
      pick += ` among ${shortlisted.length} shortlisted candidates`;
    }
    lines.push(`${pick}.`);
  }

  const placements = placementLines(result.audit);
  if (placements.length > 0) {
    lines.push(...placements);
  } else {
    for (const facet of result.facets ?? []) {
      lines.push(`Added facet ${facet.name} (${facet.header}.${facet.code}).`);
    }
    for (const ft of result.freeText ?? []) {
      lines.push(`Left as ${ft.label}=${ft.value}.`);
    }
  }

  if (lines.length <= MAX_LINES) return lines;
  const kept = lines.slice(0, MAX_LINES - 1);
  kept.push(`…and ${lines.length - (MAX_LINES - 1)} more placement lines omitted.`);
  return kept;
}
