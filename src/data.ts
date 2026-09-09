/**
 * Data-file access with a pluggable source, so the same modules run on Node
 * and on Cloudflare Workers.
 *
 * - On Node (stdio, CLI, eval): files fall back to `data/` (or FOODEX2_DATA_DIR).
 * - On Workers: the entry point fetches each file once from ASSETS and
 *   registers it with provideDataFile(); all loaders stay synchronous.
 *
 * Names are paths relative to data/, e.g. "catalogue.json".
 */

type FsModule = typeof import("node:fs");

let fs: FsModule | null = null;
let pathJoin: ((...parts: string[]) => string) | null = null;
let defaultDataDir: string | null = null;

try {
  fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  pathJoin = path.join;
  defaultDataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
} catch {
  // No filesystem (Workers): everything must be provided via provideDataFile.
}

/**
 * Every data file the runtime needs (paths relative to data/).
 * The Workers entry loads exactly these from static assets;
 * build-worker-assets stages exactly these for upload.
 */
export const RUNTIME_DATA_FILES = [
  "catalogue.json",
  "search-names.json",
  "embeddings-base.json",
  "embeddings-base.f32",
  "embeddings-facets.json",
  "embeddings-facets.f32",
] as const;

const registry = new Map<string, Uint8Array | string>();

/** Directory used for disk fallback (Node). Throws when no filesystem is available. */
export function dataDir(): string {
  const override = process.env.FOODEX2_DATA_DIR?.trim();
  if (override) return override;
  if (defaultDataDir === null) {
    throw new Error("dataDir() requires a filesystem (or set FOODEX2_DATA_DIR)");
  }
  return defaultDataDir;
}

function diskPath(name: string): string | null {
  if (fs === null || pathJoin === null) return null;
  return pathJoin(dataDir(), name);
}

/** Register a data file's contents (Workers startup path). */
export function provideDataFile(name: string, contents: Uint8Array | string): void {
  registry.set(name, contents);
}

/** True if the file was provided or exists on disk. */
export function dataFileAvailable(name: string): boolean {
  if (registry.has(name)) return true;
  const path = diskPath(name);
  return path !== null && fs !== null && fs.existsSync(path);
}

function missing(name: string): Error {
  const path = diskPath(name);
  if (path !== null) {
    return new Error(
      `Data file missing: ${path} (run npm run build:catalogue / build:embeddings, or set FOODEX2_DATA_DIR)`
    );
  }
  return new Error(
    `Data file '${name}' not provided and no filesystem fallback available ` +
      `(on Workers, register it with provideDataFile at startup)`
  );
}

export function readDataText(name: string): string {
  const provided = registry.get(name);
  if (provided !== undefined) {
    return typeof provided === "string" ? provided : new TextDecoder().decode(provided);
  }
  const path = diskPath(name);
  if (path === null || fs === null) throw missing(name);
  if (!fs.existsSync(path)) throw missing(name);
  return fs.readFileSync(path, "utf8");
}

export function readDataBytes(name: string): Uint8Array {
  const provided = registry.get(name);
  if (provided !== undefined) {
    return typeof provided === "string" ? new TextEncoder().encode(provided) : provided;
  }
  const path = diskPath(name);
  if (path === null || fs === null) throw missing(name);
  if (!fs.existsSync(path)) throw missing(name);
  return fs.readFileSync(path);
}
