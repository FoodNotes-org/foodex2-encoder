/**
 * Vector (semantic) search over embedding indices.
 *
 * Local brute-force cosine over the f32 index from scripts/build-embeddings.ts;
 * query embeddings from transformers.js. A few thousand normalized vectors is
 * fine without ANN.
 *
 *   base   — expo food terms (base-term walk tips)
 *   facets — Facets (A0B8V) descriptors (residual dimension / leaf tips)
 */

import { dataFileAvailable, readDataBytes, readDataText } from "../data.js";
import { cosineSimilarity, embedQuery } from "./embeddings.js";

export type IndexName = "base" | "facets";

export interface VectorHit {
  code: string;
  similarity: number;
}

interface VectorIndex {
  model: string;
  dim: number;
  codes: string[];
  vectors: Float32Array;
}

const indices = new Map<IndexName, VectorIndex>();

function indexFiles(name: IndexName): { meta: string; data: string } {
  return {
    meta: `embeddings-${name}.json`,
    data: `embeddings-${name}.f32`,
  };
}

function getIndex(name: IndexName): VectorIndex {
  const cached = indices.get(name);
  if (cached !== undefined) return cached;

  const { meta: metaFile, data: dataFile } = indexFiles(name);
  const meta = JSON.parse(readDataText(metaFile)) as {
    model: string;
    dim: number;
    codes: string[];
  };
  const raw = readDataBytes(dataFile);
  const aligned =
    raw.byteOffset % 4 === 0
      ? new Float32Array(raw.buffer as ArrayBuffer, raw.byteOffset, raw.byteLength / 4)
      : new Float32Array(
          raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
        );
  const built: VectorIndex = { ...meta, vectors: aligned };
  indices.set(name, built);
  return built;
}

export function vectorIndexAvailable(name: IndexName = "base"): boolean {
  const { meta, data } = indexFiles(name);
  return dataFileAvailable(meta) && dataFileAvailable(data);
}

async function vectorSearch(
  name: IndexName,
  query: string,
  limit: number
): Promise<VectorHit[]> {
  if (!vectorIndexAvailable(name)) {
    throw new Error(
      `${name} embedding index missing — run npm run build:embeddings -- --index ${name}`
    );
  }
  const idx = getIndex(name);
  const q = await embedQuery(query);
  const hits: VectorHit[] = [];
  for (let i = 0; i < idx.codes.length; i++) {
    const vector = idx.vectors.subarray(i * idx.dim, (i + 1) * idx.dim);
    hits.push({ code: idx.codes[i] as string, similarity: cosineSimilarity(q, vector) });
  }
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, limit);
}

export async function vectorSearchBase(query: string, limit = 10): Promise<VectorHit[]> {
  return vectorSearch("base", query, limit);
}

export async function vectorSearchFacets(query: string, limit = 10): Promise<VectorHit[]> {
  return vectorSearch("facets", query, limit);
}
