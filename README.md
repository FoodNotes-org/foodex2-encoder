# foodex2-encoder

Library and stdio MCP server that turns an English food description into an
EFSA FoodEx2 code (MTX catalogue): base term, facet descriptors, and labelled
free text for what the code cannot express.

This repository is the **inspectable core** — the encoding procedure and how it
talks to a model. The hosted product at foodnotes.org wraps this core with
auth, billing and ops. Organisations can audit this code, run it themselves, or
build their own wrapper around it.

## What you need

- Node.js 20+
- Python 3 (one-time catalogue build from the vendored EFSA `.ecf`)
- An OpenAI-compatible model endpoint and API key (OpenRouter is the default)

## Install

```bash
git clone https://github.com/FoodNotes-org/foodex2-encoder.git
cd foodex2-encoder
git submodule update --init
npm install
npm run build:catalogue
npm run build:embeddings
```

`data/` is generated locally (~25 MB) and is gitignored. Rebuild after updating
the `vendor/efsa-catalogues` submodule.

## Model endpoint

Copy `.env` (or export the same variables). OpenRouter needs only a key:

```bash
FOODEX2_LLM_API_KEY=sk-or-…          # or OPENROUTER_API_KEY
# optional:
# FOODEX2_LLM_BASE_URL=https://openrouter.ai/api/v1
# FOODEX2_MODEL=openai/gpt-5.4
```

Any other OpenAI-compatible endpoint works the same way (`FOODEX2_LLM_BASE_URL`,
`FOODEX2_LLM_API_KEY`, `FOODEX2_MODEL`). The **server** calls that endpoint for
classify / select / residual steps; your chat client’s subscription is separate.

## Try it (CLI)

```bash
npm run cli -- encode "orange juice"
npm run cli -- encode "fried rice with chicken"
npm run cli -- traverse "eggplant"    # walk only (debug)
```

Lexical hits return in about a second. Descriptions that need a catalogue walk
typically take 15–25 seconds.

## Try it (MCP stdio)

```bash
npm run server
```

Point a client at that process. Cursor example (`mcp.json`):

```json
{
  "mcpServers": {
    "foodex2-encoder": {
      "command": "npx",
      "args": ["tsx", "/ABS/PATH/TO/foodex2-encoder/src/server.ts"],
      "env": {
        "FOODEX2_LLM_API_KEY": "sk-or-…"
      }
    }
  }
}
```

Tools: `encode` (main), `search_terms`, `get_term`. `encode` returns the code,
base term, facets, free text, fit, method, and a short `explanation`.

## Tests and eval

```bash
npm test                 # unit tests (no model)
npm run lexical-eval     # lexical base-term cases
npm run encode-eval      # end-to-end (needs a model key)
```

## Layout

```
src/encode/     lexical → traverse → select → residuals
src/search/     lexical + embedding retrieval
src/server.ts   stdio MCP
src/tools.ts    tool handlers (shared surface for a future Worker wrapper)
data/           generated catalogue + embeddings (local)
eval/           gold cases
vendor/         EFSA catalogues (submodule)
```

## Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 e-accent BV.

That grant covers this software. EFSA catalogue files under `vendor/efsa-catalogues/`
(and generated `data/` derived from them) remain subject to EFSA’s terms.
