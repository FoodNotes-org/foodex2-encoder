/**
 * Local embedding backend for semantic term retrieval (transformers.js).
 *
 * Default model is bge-small-en-v1.5. Alternatives stay in the registry for
 * later recall checks (`npm run build:embeddings -- --model e5-small`).
 */

import type { FeatureExtractionPipeline } from "@huggingface/transformers";

export interface EmbeddingModelSpec {
  /** Registry key, also used in index filenames. */
  id: string;
  /** transformers.js (Hugging Face) model id for local inference. */
  hfModel: string;
  dim: number;
  queryPrefix: string;
  passagePrefix: string;
}

export const EMBEDDING_MODELS: Record<string, EmbeddingModelSpec> = {
  "e5-small": {
    id: "e5-small",
    hfModel: "intfloat/multilingual-e5-small",
    dim: 384,
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
  },
  "bge-small-en": {
    id: "bge-small-en",
    hfModel: "Xenova/bge-small-en-v1.5",
    dim: 384,
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    passagePrefix: "",
  },
};

export const DEFAULT_EMBEDDING_MODEL_ID = "bge-small-en";

const defaultSpec = EMBEDDING_MODELS[DEFAULT_EMBEDDING_MODEL_ID]!;

const extractors = new Map<string, Promise<FeatureExtractionPipeline>>();

function getExtractor(hfModel: string): Promise<FeatureExtractionPipeline> {
  let p = extractors.get(hfModel);
  if (p === undefined) {
    // transformers.js pipeline typing is too wide for tsc; cast the factory.
    p = import("@huggingface/transformers").then((m) =>
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

/** Embed a search query with the default model (the one the indices are built with). */
export async function embedQuery(text: string): Promise<Float32Array> {
  const [vector] = await embed(defaultSpec, [`${defaultSpec.queryPrefix}${text}`]);
  return vector as Float32Array;
}

/** Cosine similarity of two L2-normalized vectors (dot product). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}
