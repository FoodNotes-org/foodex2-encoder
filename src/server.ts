/**
 * FoodEx2 encoder MCP server over stdio.
 *
 * Run: npm run server   (or: npx tsx src/server.ts)
 * Model configuration: see src/llm.ts (FOODEX2_LLM_* / FOODEX2_MODEL, or .env).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnv } from "./env.js";
import { TOOLS } from "./tools.js";

loadEnv();

const server = new McpServer({ name: "foodex2-encoder", version: "0.1.0" });

for (const tool of TOOLS) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { title: tool.title, readOnlyHint: tool.readOnly, openWorldHint: false },
    },
    tool.handler as Parameters<typeof server.registerTool>[2]
  );
}

await server.connect(new StdioServerTransport());
