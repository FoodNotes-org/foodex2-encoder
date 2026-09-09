/**
 * Embedding backend for semantic term retrieval.
 *
 * Default model is bge-small-en-v1.5 (same weights Workers AI serves as
 * `@cf/baai/bge-small-en-v1.5`). Local inference uses transformers.js;
 * the hosted Worker swaps in Workers AI via setQueryEmbedder at isolate
 * startup so transformers.js never enters the Worker bundle.
 *
 * Alternatives stay in the registry for recall checks
 * (`npm run build:embeddings -- --model e5-small`).
 */

import type { FeatureExtractionPipeline } from "@huggingface/transformers";

export interface EmbeddingModelSpec {
  /** Registry key, also used in index filenames. */
  id: string;
  /** transformers.js (Hugging Face) model id for local inference. */
  hfModel: string;
  /** Workers AI model serving the same weights, if any. */
  workersAiModel: string | null;
  dim: number;
  queryPrefix: string;
  passagePrefix: string;
}

export const EMBEDDING_MODELS: Record<string, EmbeddingModelSpec> = {
  "e5-small": {
    id: "e5-small",
    hfModel: "intfloat/multilingual-e5-small",
    workersAiModel: null,
    dim: 384,
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
  },
  "bge-small-en": {
    id: "bge-small-en",
    hfModel: "Xenova/bge-small-en-v1.5",
    workersAiModel: "@cf/baai/bge-small-en-v1.5",
    dim: 384,
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    passagePrefix: "",
  },
};

export const DEFAULT_EMBEDDING_MODEL_ID = "bge-small-en";

const defaultSpec = EMBEDDING_MODELS[DEFAULT_EMBEDDING_MODEL_ID]!;

/**
 * Pluggable query embedder. Receives the already-prefixed query text and must
 * return an L2-normalized vector from the same model as the corpus index.
 * Default: local transformers.js. Workers: Workers AI (set at startup).
 */
export type QueryEmbedder = (prefixedText: string) => Promise<Float32Array>;

let queryEmbedder: QueryEmbedder | null = null;

/** Install a query embedder, or pass `null` to restore the local default. */
export function setQueryEmbedder(fn: QueryEmbedder | null): void {
  queryEmbedder = fn;
}

const extractors = new Map<string, Promise<FeatureExtractionPipeline>>();

function getExtractor(hfModel: string): Promise<FeatureExtractionPipeline> {
  let p = extractors.get(hfModel);
  if (p === undefined) {
    // Computed specifier so bundlers (wrangler/esbuild) cannot statically
    // resolve it: transformers.js is local-only and must not enter the
    // Workers bundle, where setQueryEmbedder(Workers AI) is used.
    const specifier = "@huggingface/transformers";
    p = import(specifier).then((m: typeof import("@huggingface/transformers")) =>
      (m.pipeline as (
        task: string,
        model: string,
        options?: { dtype?: string }
      ) => Promise<FeatureExtractionPipeline>)("feature-extraction", hfModel, {
        dtype: "fp32",
      })
    );
    extractors.set(hfModel, p);
  }
  return p;
}

async function embed(model: EmbeddingModelSpec, texts: string[]): Promise<Float32Array[]> {
  const pipe = await getExtractor(model.hfModel);
  const output = await pipe(texts, { pooling: "mean", normalize: true });
  const rows = output.tolist() as number[][];
  return rows.map((row) => Float32Array.from(row));
}

export async function embedPassagesWith(
  model: EmbeddingModelSpec,
  texts: string[]
): Promise<Float32Array[]> {
  return embed(model, texts.map((t) => `${model.passagePrefix}${t}`));
}

export async function embedQueryWith(
  model: EmbeddingModelSpec,
  text: string
): Promise<Float32Array> {
  const [vector] = await embed(model, [`${model.queryPrefix}${text}`]);
  return vector as Float32Array;
}

/** Embed a search query with the default model (the one the indices are built with). */
export async function embedQuery(text: string): Promise<Float32Array> {
  if (queryEmbedder !== null) {
    return queryEmbedder(`${defaultSpec.queryPrefix}${text}`);
  }
  return embedQueryWith(defaultSpec, text);
}

/** Cosine similarity of two L2-normalized vectors (dot product). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}
