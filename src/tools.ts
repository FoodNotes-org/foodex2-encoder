/**
 * MCP tool surface, shared by the stdio server and (later) the Worker.
 *
 * `encode` is the product: one call, one FoodEx2 code. Catalogue lookups,
 * decoding and validation live in the free FoodEx2 Atlas MCP. Handlers return
 * `EncodeUserResult` via `toUserEncodeResult`; the full `EncodeResult`
 * (audit, candidates, walks) stays on the encoder for eval and explanation.
 */

import { z } from "zod";
import { encodeBaseTerm, MAX_ENCODE_INPUT_CHARS } from "./encode/base-term.js";
import { toUserEncodeResult } from "./encode/user-result.js";

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

export const TOOLS = [encodeTool] as const;

export const SERVER_INSTRUCTIONS =
  "This server encodes food descriptions as FoodEx2 codes. To look up catalogue terms, decode or validate codes, or read EFSA's FoodEx2 guidance, the user can connect the free FoodEx2 Atlas MCP: https://foodex2-atlas.foodnotes.org/mcp-service/";
