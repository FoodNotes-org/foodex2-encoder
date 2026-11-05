/**
 * English rendering used only as the embedding search query.
 *
 * The walk, the term choice and the facets keep the description as reported.
 * A null rendering means that description is already how the food is named in
 * English, so the search uses it unchanged. A failed call does the same.
 */

import { chatJson } from "../llm.js";

export function embeddingQuerySystem(): string {
  return `You are rendering a food description in English, so it can be compared with English names of foods.

You are given:
- \`description\`: the food as reported.
- \`country\`: where it was reported. Present only when the user supplied it.

State the food in English, without adding unstated detail.

If \`description\` is already how that food is named in English, \`english\` is null.
Reply with JSON only:
{"english":"<text>"|null}
`;
}

export function embeddingQueryUser(description: string, country: string | null): string {
  return JSON.stringify(
    {
      description,
      ...(country !== null && country.trim() !== "" ? { country } : {}),
    },
    null,
    2
  );
}

/** English rendering, or null when the description is already the English name. */
export function parseEmbeddingEnglish(content: unknown): string | null {
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("Embedding query model returned a non-object");
  }
  const english = (content as { english?: unknown }).english;
  if (english === null) return null;
  if (typeof english !== "string") {
    throw new Error("Embedding query model returned a non-string english");
  }
  const trimmed = english.trim();
  return trimmed === "" ? null : trimmed;
}

/** Text to embed. A rendering replaces the description; null or blank keeps it. */
export function embeddingSearchText(description: string, english: string | null): string {
  const rendered = english?.trim() ?? "";
  return rendered === "" ? description : rendered;
}

export interface EmbeddingQuery {
  /** Text passed to the embedding index. */
  query: string;
  /** English rendering, or null when the description is already the English name. */
  english: string | null;
  /** Set when the call failed and the original description was searched. */
  error?: string;
}

export async function renderEmbeddingQuery(
  description: string,
  country: string | null,
  model: string
): Promise<EmbeddingQuery> {
  try {
    const reply = await chatJson({
      model,
      system: embeddingQuerySystem(),
      user: embeddingQueryUser(description, country),
    });
    const english = parseEmbeddingEnglish(reply.content);
    return { english, query: embeddingSearchText(description, english) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { english: null, query: description, error: message };
  }
}
