/**
 * Read model replies that name catalogue codes. Every code is checked against
 * the set the model was offered; anything else reads as "no pick".
 */

function asRecord(content: unknown): Record<string, unknown> | null {
  return content !== null && typeof content === "object"
    ? (content as Record<string, unknown>)
    : null;
}

function allowedCode(raw: unknown, allowed: ReadonlySet<string>): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return allowed.has(code) ? code : null;
}

/** `{"code": "<code>"|null}` → the code when it is one of `allowed`. */
export function pickAllowedCode(content: unknown, allowed: ReadonlySet<string>): string | null {
  const body = asRecord(content);
  return body === null ? null : allowedCode(body.code, allowed);
}

/** `{"codes": [...]}` (or a single `code`) → allowed codes, order kept, deduped. */
export function pickAllowedCodes(content: unknown, allowed: ReadonlySet<string>): string[] {
  const body = asRecord(content);
  if (body === null) return [];
  const raw = Array.isArray(body.codes) ? body.codes : [body.code];
  const out: string[] = [];
  for (const item of raw) {
    const code = allowedCode(item, allowed);
    if (code !== null && !out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * `{"classifications": [{"code", <key>}]}` → label per allowed code. Rows with
 * an unknown code or label are skipped. Null when the reply has no
 * classifications array at all; the caller decides whether that is fatal.
 */
export function parseClassifications<T extends string>(
  content: unknown,
  allowed: ReadonlySet<string>,
  key: string,
  labels: ReadonlySet<T>
): Map<string, T> | null {
  const list = asRecord(content)?.classifications;
  if (!Array.isArray(list)) return null;
  const out = new Map<string, T>();
  for (const item of list) {
    const row = asRecord(item);
    if (row === null) continue;
    const code = allowedCode(row.code, allowed);
    const label = row[key];
    if (code === null || typeof label !== "string" || !labels.has(label as T)) continue;
    out.set(code, label as T);
  }
  return out;
}
