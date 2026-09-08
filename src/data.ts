/**
 * Read generated data files under data/ (Node only for this experiment).
 *
 * Override the directory with FOODEX2_DATA_DIR.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultDataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

export function dataDir(): string {
  return process.env.FOODEX2_DATA_DIR?.trim() || defaultDataDir;
}

function diskPath(name: string): string {
  return join(dataDir(), name);
}

export function dataFileAvailable(name: string): boolean {
  return existsSync(diskPath(name));
}

export function readDataText(name: string): string {
  const path = diskPath(name);
  if (!existsSync(path)) {
    throw new Error(
      `Data file missing: ${path} (run npm run build:catalogue, or set FOODEX2_DATA_DIR)`
    );
  }
  return readFileSync(path, "utf8");
}

export function readDataBytes(name: string): Uint8Array {
  const path = diskPath(name);
  if (!existsSync(path)) {
    throw new Error(`Data file missing: ${path}`);
  }
  return readFileSync(path);
}
