# foodex2-encoder

Library and stdio MCP server that turns a food description into an EFSA
FoodEx2 code (MTX catalogue): base term, facet descriptors, and labelled free
text for what the code cannot express. The description may be in any language;
an optional country says how to read it, since food names can mean different
foods in different countries.

This repository is the core. A hosted version is available at https://foodex2-encoder.foodnotes.org/ .

## Limitations

Check every code before you use it. In particular:

- **Tested with a limited set of descriptions** in English, German, French,
  Italian, Spanish and Dutch. Other languages should work too, but results vary
  more for uncommon food names.
- **A category's members can end up broader than stated.** When a category
  names several foods it may consist of, the code records the nearest group
  that covers them all, and the words go to free text. *Canned crabs and
  lobsters* is coded as *Canned seafood* from *Crustaceans*, with the crabs
  and lobsters kept in free text. When no group covers them, as for
  *canned shellfish* (crustaceans and molluscs), only the free text keeps them.
  The code is not wrong, but it is broader than the description.

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

The coding rules in `src/rules/` (EFSA business rules, facet cardinality, our
own checks) are shared with the FoodEx2 Atlas validator. Their data comes from
`rules/cardinality.yaml`, `rules/conflicts.yaml` and
`vendor/efsa-business-rules/`; after editing those, regenerate the committed
`src/rules/rules-data.json` with `npm run build:rules`. Sources, licence and
limits are in `rules/efsa-business-rules.md`.

## Model endpoint

Copy `.env` (or export the same variables). OpenRouter needs only a key:

```bash
FOODEX2_LLM_API_KEY=sk-or-…          # or OPENROUTER_API_KEY
# optional:
# FOODEX2_LLM_BASE_URL=https://openrouter.ai/api/v1
# FOODEX2_MODEL=openai/gpt-6.1-sol
```

Any other OpenAI-compatible endpoint works the same way (`FOODEX2_LLM_BASE_URL`,
`FOODEX2_LLM_API_KEY`, `FOODEX2_MODEL`). The **server** calls that endpoint for
classify / select / residual steps; your chat client’s subscription is separate.

## Try it (CLI)

```bash
npm run cli -- encode "orange juice"
npm run cli -- encode "fried rice with chicken"
npm run cli -- encode "Kabeljauw gekookt" --country NL
npm run cli -- traverse "eggplant"    # walk only (debug)
```

`--country` takes an ISO 3166-1 code such as `NL`, or `EU`, the default.
Lexical hits return in about a second. Descriptions that need a catalogue walk
typically take 60–120 seconds.

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

Tool: `encode`, with the description and an optional `country`. It returns the code, base term, facets, free text, fit,
method, and a short `explanation`. Catalogue lookups, decoding, validation
and EFSA guidance are in the free
[FoodEx2 Atlas MCP](https://foodex2-atlas.foodnotes.org/mcp-service/).

## Tests and eval

```bash
npm test                 # unit tests (no model)
npm run lexical-eval     # lexical base-term cases (no model)
npm run encode-eval      # end-to-end capability cases (needs a model key)
npm run base-eval        # base-term decisions for foodstuffs (needs a model key)
npm run reference-eval   # full codes against the FoodEx2 reference set (needs a model key)
```

- `eval/encode-base-term.yaml` is a small regression set: one realistic case
  per capability (catalogue synonym, named dish, category, restraint, and so
  on). Cases can require or forbid facets and free-text fragments; `expected`
  may list several acceptable base codes (any-of).
- `eval/base-attributes.yaml` tests the base-term decision for a foodstuff:
  which stated treatments make a new food, and which stay facets. The rules it
  refers to are in `rules/base-term.yaml`.
- `npm run reference-eval` encodes every coded food in the
  [FoodEx2 reference set](https://github.com/FoodNotes-org/foodex2-reference-set)
  (the `vendor/foodex2-reference-set` submodule, pinned to a release tag) and
  scores the base term and the full code, every facet included. It also scores
  against the source's own published code where there is one. Many of the
  set's codes are drafts, some of them first drafted with this encoder, so read
  its numbers as a regression check, not as a benchmark.

Each eval records the model and MTX version in its results file under
`eval/results/` on a complete run. Always cite the model named in that file’s
`_provenance`.

## Layout

```
src/encode/     lexical → traverse → select → residuals
src/search/     lexical + embedding retrieval
src/server.ts   stdio MCP
src/tools.ts    tool handlers (shared surface for a future Worker wrapper)
data/           generated catalogue + embeddings (local)
src/eval/       eval runners and the reference-set loader
eval/           eval cases + results artifacts
vendor/         EFSA catalogues and the FoodEx2 reference set (submodules)
```

## Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 e-accent BV.

That grant covers this software. EFSA catalogue files under `vendor/efsa-catalogues/`
(and generated `data/` derived from them) remain subject to EFSA’s terms.

### Attribution (eval inputs)

The FoodEx2 reference set under `vendor/foodex2-reference-set/` has its own
licence: its food descriptions stay under each source's terms, and the codes
added there are CC BY 4.0. See its `LICENSE.md`.


Some food names used as evaluation cases under `eval/` were drawn from national
food composition databases. We use food names only (not nutrient values). Those
databases remain under their publishers’ terms:

- **CIQUAL** (ANSES, France) — [ciqual.anses.fr](https://ciqual.anses.fr/).
  Cite as: Anses. Table de composition nutritionnelle des aliments Ciqual.
  Data are available under the [Etalab Open Licence 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/).
- **CoFID** (UK) — McCance and Widdowson’s Composition of Foods Integrated
  Dataset, [GOV.UK](https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid).
  Contains public sector information licensed under the
  [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

