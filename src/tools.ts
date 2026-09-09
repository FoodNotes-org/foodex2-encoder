/**
 * MCP tool surface, shared by the stdio server and (later) the Worker.
 *
 * `encode` is the product: one call, one FoodEx2 code. Handlers return
 * `EncodeUserResult` via `toUserEncodeResult`; the full `EncodeResult`
 * (audit, candidates, walks) stays on the encoder for eval and explanation.
 */

import { z } from "zod";
import { Catalogue } from "./catalogue.js";
import { encodeBaseTerm, MAX_ENCODE_INPUT_CHARS } from "./encode/base-term.js";
import { toUserEncodeResult } from "./encode/user-result.js";
import { searchTerms } from "./search/lexical.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition<Schema extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  readOnly: boolean;
  handler: (args: z.infer<z.ZodObject<Schema>>) => Promise<ToolResult>;
}

function json(value: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

function tool<Schema extends z.ZodRawShape>(def: ToolDefinition<Schema>): ToolDefinition<Schema> {
  return def;
}

export const encodeTool = tool({
  name: "encode",
  title: "Encode a food description as a FoodEx2 code",
  description:
    "Turn one English food description (a food, drink, dish or meal) into a FoodEx2 code from the EFSA MTX catalogue: base term, facet descriptors for stated attributes the term does not imply, and labelled free text for what the code cannot express. Returns a short explanation of how the code was reached. Takes a few seconds for a direct name match, typically 15–25 seconds when the catalogue must be walked.",
  inputSchema: {
    description: z
      .string()
      .describe(
        `The food description, e.g. 'fried rice with chicken' (at most ${MAX_ENCODE_INPUT_CHARS} characters)`
      ),
  },
  readOnly: true,
  handler: async ({ description }) => {
    const result = toUserEncodeResult(await encodeBaseTerm(description));
    return json(result, result.status !== "ok");
  },
});

export const searchTermsTool = tool({
  name: "search_terms",
  title: "Search catalogue terms by name",
  description:
    "Find MTX catalogue terms whose names or common names match a query. Returns code, name and whether the term can be a base term.",
  inputSchema: {
    query: z.string().describe("Words from a food or descriptor name"),
    limit: z.number().int().min(1).max(50).default(10),
  },
  readOnly: true,
  handler: async ({ query, limit }) =>
    json(
      searchTerms(query, { limit }).map((hit) => ({
        code: hit.code,
        name: hit.name,
        baseCandidate: hit.baseCandidate,
        facetCategories: hit.facetCategories,
      }))
    ),
});

export const getTermTool = tool({
  name: "get_term",
  title: "Look up one catalogue term",
  description: "Name, scope note, term type and implied facets of one MTX term by code.",
  inputSchema: {
    code: z.string().describe("MTX term code, e.g. A040Z"),
  },
  readOnly: true,
  handler: async ({ code: raw }) => {
    const cat = Catalogue.load();
    const code = raw.trim().toUpperCase();
    const term = cat.term(code);
    if (term === undefined) return json({ error: `No term ${code}` }, true);
    return json({
      code,
      name: term.name,
      scopeNote: term.scopeNote,
      termType: term.termType,
      detailLevel: term.detailLevel,
      deprecated: cat.isDeprecated(code),
      impliedFacets: cat.impliedFacets(code),
    });
  },
});

export const TOOLS = [encodeTool, searchTermsTool, getTermTool] as const;
