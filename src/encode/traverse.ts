/**
 * Top-down exposure-tree traversal for base-term candidate recall.
 *
 * The router picks one descriptionKind for the whole description. That kind is
 * reused for classify / select wording and for residuals. Every input is
 * traversed as a whole — the base term is chosen against that full string.
 *
 * Embeddings tip the walk toward opaque branches: a few high cosine hits contribute
 * their expo parents as extra seeds. The search query is an English rendering of
 * the description when that is not already its English name; the walk still
 * classifies the description as reported. Neither mints pool candidates with a preset
 * match — only the classify ladder assigns exact/broad/narrow/related. Related is
 * collected and descended when it has children. Broad is always collected (the
 * shelf judgment); children are enqueued only if that node was not already
 * visited. A broad parent with only none/related-leaf children is still collected
 * (dead-end shelf → F26 Other later).
 *
 * Scoring the pool and picking a base term is select.ts.
 */

import {
  Catalogue,
  DEFAULT_HIERARCHY,
  EXPO_ROOT,
  isInExposureTree,
} from "../catalogue.js";
import { countryContextLine } from "../country.js";
import { chatJson, defaultModel, LlmError } from "../llm.js";
import { vectorIndexAvailable, vectorSearchBase } from "../search/vector.js";
import { parseClassifications } from "./answers.js";
import { renderEmbeddingQuery, type EmbeddingQuery } from "./embed-query.js";
import {
  LADDER_LABELS,
  classifySystemPrompt,
} from "./classify-ladder.js";
import type {
  AuditEntry,
  BaseTermCandidate,
  DescriptionKind,
  LadderLabel,
  TraverseCollectResult,
  WalkKind,
  WalkStep,
  WalkSummary,
} from "./types.js";

/** Default how many embedding hits may contribute walk seeds. */
export const DEFAULT_EMBEDDING_SEED_LIMIT = 5;

export interface TraverseOptions {
  model?: string;
  /** Top-K embedding hits used only as walk-seed hints (default 5). */
  embeddingSeedLimit?: number;
  /** English name of the country the description comes from. */
  country?: string | null;
}

type CandidateMatch = BaseTermCandidate["match"];

interface ChildRef {
  code: string;
  name: string;
}

interface TraversalChildView {
  code: string;
  name: string;
  /** Direct subgroup names — present when this item has children. */
  contains?: string[];
  /** Catalogue scope note, when the term has one. */
  note?: string;
}

interface RawCandidate {
  code: string;
  match: CandidateMatch;
}

function routeSystem(withCountry: boolean): string {
  return `Assign exactly one descriptionKind to the input:

- "foodstuff": a food, beverage, food product or food commodity
- "category": a food group or group of foods taken together for statistical reporting
- "dish": a prepared dish or meal, including a named dish with sides or accompaniments
- "dish_type": a type of dish, without a specific dish name
- "mix": a product you can buy that is a blend of several foods
${withCountry ? `\n${countryContextLine("input")}\n` : ""}
Reply with JSON only:
{"descriptionKind":"foodstuff|category|dish|dish_type|mix"}
`;
}

/** Display name for the classify parent. */
function parentDisplayName(cat: Catalogue, parentCode: string): string {
  if (parentCode === EXPO_ROOT) return "Food";
  return cat.term(parentCode)?.name ?? parentCode;
}

function classifyTermEntry(child: TraversalChildView): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    code: child.code,
    name: child.name,
  };
  if (child.contains !== undefined && child.contains.length > 0) {
    entry.directSubcategories = child.contains;
  }
  if (child.note !== undefined && child.note !== "") {
    entry.note = child.note;
  }
  return entry;
}

function buildClassifyUser(
  item: string,
  children: TraversalChildView[],
  parentName: string,
  descriptionKind: DescriptionKind | null,
  country: string | null
): string {
  return JSON.stringify(
    {
      item,
      ...(country !== null ? { country } : {}),
      ...(descriptionKind !== null ? { descriptionKind } : {}),
      parent: parentName,
      terms: children.map((child) => classifyTermEntry(child)),
    },
    null,
    2
  );
}

const DESCRIPTION_KINDS = new Set<string>([
  "foodstuff",
  "category",
  "dish",
  "dish_type",
  "mix",
]);

export function parseDescriptionKind(raw: unknown): DescriptionKind | null {
  return typeof raw === "string" && DESCRIPTION_KINDS.has(raw)
    ? (raw as DescriptionKind)
    : null;
}

/** Recall classify prompt: the ladder answers as `match`. */
function routeWalkSystem(withCountry: boolean): string {
  return classifySystemPrompt({
    answerKey: "match",
    readSubcategories: true,
    withCountry,
  });
}

function listChildren(cat: Catalogue, parent: string): ChildRef[] {
  return cat
    .children(parent, DEFAULT_HIERARCHY)
    .filter((code) => !cat.isDeprecated(code))
    .map((code) => ({
      code,
      name: cat.term(code)?.name ?? code,
    }));
}

function traversalChildView(cat: Catalogue, code: string): TraversalChildView {
  const term = cat.term(code);
  const subgroups = listChildren(cat, code).map((c) => c.name);
  const note = term?.scopeNote?.trim();
  const base = { code, name: term?.name ?? code, ...(note ? { note } : {}) };
  if (subgroups.length > 0) {
    return { ...base, contains: subgroups };
  }
  return base;
}

function traversalChildrenPayload(cat: Catalogue, children: ChildRef[]): TraversalChildView[] {
  return children.map(({ code }) => traversalChildView(cat, code));
}

/** Max siblings per classify call — large parents (e.g. Flavourings) truncate JSON otherwise. */
const CLASSIFY_BATCH_SIZE = 40;
/** How many parents to classify at once within one walk (independent frontier nodes). */
const WALK_CLASSIFY_CONCURRENCY = 4;

function classifyMaxTokens(termCount: number): number {
  return Math.min(8192, Math.max(1024, 256 + termCount * 16));
}

/**
 * Classify all children under a parent, batching when the sibling set is large
 * so the JSON reply fits max_tokens. Batches run concurrently.
 */
async function classifyAllChildren(
  model: string,
  system: string,
  compareAs: string,
  parentName: string,
  descriptionKind: DescriptionKind | null,
  country: string | null,
  children: TraversalChildView[],
  allowed: Set<string>
): Promise<{ classifications: Map<string, LadderLabel>; model: string }> {
  const batches: TraversalChildView[][] = [];
  for (let i = 0; i < children.length; i += CLASSIFY_BATCH_SIZE) {
    batches.push(children.slice(i, i + CLASSIFY_BATCH_SIZE));
  }

  const parts = await Promise.all(
    batches.map(async (batch) => {
      const batchAllowed = new Set(batch.map((c) => c.code));
      const classified = await chatJson({
        model,
        system,
        user: buildClassifyUser(compareAs, batch, parentName, descriptionKind, country),
        maxTokens: classifyMaxTokens(batch.length),
      });
      const part = parseClassifications(classified.content, batchAllowed, "match", LADDER_LABELS);
      if (part === null) {
        throw new Error("Traversal model reply has no classifications array");
      }
      return { part, model: classified.model };
    })
  );

  const out = new Map<string, LadderLabel>();
  for (const { part } of parts) {
    for (const [code, match] of part) out.set(code, match);
  }
  for (const code of allowed) {
    if (!out.has(code)) out.set(code, "none");
  }
  return { classifications: out, model: parts[0]?.model ?? model };
}

export function parseRoute(
  content: unknown,
  _input: string
): {
  descriptionKind: DescriptionKind | null;
} {
  if (content === null || typeof content !== "object") {
    throw new Error("Router model returned a non-object");
  }
  const body = content as { descriptionKind?: unknown };
  return { descriptionKind: parseDescriptionKind(body.descriptionKind) };
}

function seedParentForHit(cat: Catalogue, code: string): string | null {
  const parent = cat.parent(code, DEFAULT_HIERARCHY);
  if (parent === null) return null;
  return parent;
}

function hasChildren(cat: Catalogue, code: string): boolean {
  return listChildren(cat, code).length > 0;
}

/**
 * Map one embedding hit to an expo parent to classify under.
 * Leaves → their parent; parents with children → themselves. Skip root / non-expo.
 */
export function embeddingHitWalkSeed(
  cat: Catalogue,
  code: string
): string | null {
  const term = cat.term(code);
  if (term === undefined || !isInExposureTree(term) || cat.isDeprecated(code)) {
    return null;
  }

  if (hasChildren(cat, code)) {
    return code === EXPO_ROOT ? null : code;
  }

  const parent = seedParentForHit(cat, code);
  if (parent === null || parent === EXPO_ROOT) return null;
  const parentTerm = cat.term(parent);
  if (
    parentTerm === undefined ||
    !isInExposureTree(parentTerm) ||
    cat.isDeprecated(parent)
  ) {
    return null;
  }
  return parent;
}

/** Deduped walk seeds from embedding hit codes (order preserved). */
export function resolveEmbeddingWalkSeeds(
  cat: Catalogue,
  hitCodes: string[]
): string[] {
  const seeds: string[] = [];
  const seen = new Set<string>();
  for (const code of hitCodes) {
    const seed = embeddingHitWalkSeed(cat, code);
    if (seed === null || seen.has(seed)) continue;
    seen.add(seed);
    seeds.push(seed);
  }
  return seeds;
}

async function embeddingWalkSeeds(
  rendered: EmbeddingQuery,
  limit: number,
  audit: AuditEntry[]
): Promise<string[]> {
  if (limit <= 0) {
    audit.push({
      step: "embedding_seeds",
      detail: { skipped: true, reason: "limit_zero" },
    });
    return [];
  }

  if (!vectorIndexAvailable()) {
    audit.push({
      step: "embedding_seeds",
      detail: { skipped: true, reason: "index_missing" },
    });
    return [];
  }

  const cat = Catalogue.load();
  const renderDetail = {
    query: rendered.query,
    english: rendered.english,
    ...(rendered.error !== undefined ? { renderError: rendered.error } : {}),
  };
  try {
    const hits = await vectorSearchBase(rendered.query, limit);
    const seeds = resolveEmbeddingWalkSeeds(
      cat,
      hits.map((h) => h.code)
    );
    audit.push({
      step: "embedding_seeds",
      detail: {
        limit,
        ...renderDetail,
        hits: hits.map((h) => ({
          code: h.code,
          name: cat.term(h.code)?.name ?? h.code,
          similarity: Math.round(h.similarity * 1000) / 1000,
          seed: embeddingHitWalkSeed(cat, h.code),
        })),
        seeds: seeds.map((code) => ({
          code,
          name: cat.term(code)?.name ?? code,
        })),
      },
    });
    return seeds;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    audit.push({
      step: "embedding_seeds",
      detail: { skipped: true, reason: "error", message, ...renderDetail },
    });
    return [];
  }
}

function addCandidate(
  bucket: RawCandidate[],
  code: string,
  match: CandidateMatch
): void {
  if (bucket.some((c) => c.code === code && c.match === match)) {
    return;
  }
  bucket.push({ code, match });
}

function mergeCandidate(
  byCode: Map<string, BaseTermCandidate>,
  cat: Catalogue,
  item: RawCandidate,
  matchRank: Record<CandidateMatch, number>
): void {
  const term = cat.term(item.code);
  const existing = byCode.get(item.code);
  const next: BaseTermCandidate = {
    code: item.code,
    name: term?.name ?? item.code,
    match: item.match,
  };

  if (existing === undefined || matchRank[item.match] < matchRank[existing.match]) {
    byCode.set(item.code, next);
  }
}

function toCandidateRefs(cat: Catalogue, raw: RawCandidate[]): BaseTermCandidate[] {
  const byCode = new Map<string, BaseTermCandidate>();
  // A term reachable under several parents keeps its most informative judgement.
  const matchRank: Record<CandidateMatch, number> = {
    exact: 0,
    narrow: 1,
    broad: 2,
    related: 3,
  };

  for (const item of raw) {
    mergeCandidate(byCode, cat, item, matchRank);
  }
  return [...byCode.values()];
}

interface WalkOptions {
  walk: WalkKind;
  seeds: string[];
  system: string;
  /** Text passed to the classifier as "the item". */
  compareAs: string;
  /** From the route — shapes multi-item ladder wording; never re-asked here. */
  descriptionKind?: DescriptionKind | null;
  /** English name of the country the description comes from. */
  country: string | null;
}

/** Everything the walks read and write while collecting. */
interface WalkState {
  collected: RawCandidate[];
  walks: WalkSummary[];
  steps: WalkStep[];
  audit: AuditEntry[];
  /** Set when a walk stopped early after a provider failure (pool may still be usable). */
  abort: LlmError | null;
}

/** Classify siblings under each seed; union into collected. Recall: never drop on type mismatch. */
async function walkFromSeeds(
  cat: Catalogue,
  model: string,
  options: WalkOptions,
  state: WalkState
): Promise<void> {
  const { collected, audit } = state;
  const visited = new Set<string>();
  const queue = [...options.seeds];
  const descriptionKind = options.descriptionKind ?? null;
  const system = options.system;
  let classifySteps = 0;

  audit.push({
    step: "traversal_walk_start",
    detail: {
      walk: options.walk,
      seeds: options.seeds,
      compareAs: options.compareAs,
      ...(descriptionKind !== null ? { descriptionKind } : {}),
    },
  });

  while (queue.length > 0) {
    // Next wave: up to WALK_CLASSIFY_CONCURRENCY unvisited parents that have children.
    const wave: Array<{
      parent: string;
      children: ChildRef[];
      childPayload: TraversalChildView[];
      parentName: string;
      allowed: Set<string>;
    }> = [];
    while (queue.length > 0 && wave.length < WALK_CLASSIFY_CONCURRENCY) {
      const parent = queue.shift() as string;
      if (visited.has(parent)) {
        audit.push({
          step: "traversal_skip_visited",
          detail: { walk: options.walk, parent },
        });
        continue;
      }
      visited.add(parent);
      const children = listChildren(cat, parent);
      if (children.length === 0) continue;
      wave.push({
        parent,
        children,
        childPayload: traversalChildrenPayload(cat, children),
        parentName: parentDisplayName(cat, parent),
        allowed: new Set(children.map((c) => c.code)),
      });
    }
    if (wave.length === 0) continue;

    type WaveOk = {
      parent: string;
      children: ChildRef[];
      classifications: Map<string, LadderLabel>;
      usedModel: string;
    };
    type WaveSkip = { parent: string; skip: true; kind: string; message: string };
    type WaveAbort = { parent: string; abort: true; error: LlmError };

    const settled = await Promise.all(
      wave.map(async (node): Promise<WaveOk | WaveSkip | WaveAbort> => {
        try {
          const classified = await classifyAllChildren(
            model,
            system,
            options.compareAs,
            node.parentName,
            descriptionKind,
            options.country,
            node.childPayload,
            node.allowed
          );
          return {
            parent: node.parent,
            children: node.children,
            classifications: classified.classifications,
            usedModel: classified.model,
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          const kind = err instanceof LlmError ? err.kind : "traversal_error";
          if (kind === "model_response_invalid") {
            return { parent: node.parent, skip: true, kind, message };
          }
          return {
            parent: node.parent,
            abort: true,
            error: err instanceof LlmError ? err : new LlmError("provider_error", message),
          };
        }
      })
    );

    // Apply results in wave order so audit / enqueue stay deterministic.
    for (const result of settled) {
      if ("skip" in result) {
        audit.push({
          step: "traversal_classify_skip",
          detail: {
            walk: options.walk,
            parent: result.parent,
            kind: result.kind,
            message: result.message,
          },
        });
        continue;
      }
      if ("abort" in result) {
        audit.push({
          step: "traversal_partial",
          detail: {
            walk: options.walk,
            parent: result.parent,
            kind: result.error.kind,
            message: result.error.message,
            collectedSoFar: collected.length,
            queueRemaining: queue.length,
          },
        });
        state.abort = result.error;
        state.walks.push({
          walk: options.walk,
          compareAs: options.compareAs,
          status: "partial",
          reason: result.error.kind,
          classifySteps,
        });
        return;
      }

      const summary = [...result.classifications.entries()].map(([code, match]) => ({
        code,
        name: cat.term(code)?.name ?? code,
        match,
      }));
      classifySteps += 1;
      state.steps.push({
        walk: options.walk,
        parent: result.parent,
        classifications: summary,
      });

      audit.push({
        step: "traversal_classify",
        detail: {
          walk: options.walk,
          parent: result.parent,
          model: result.usedModel,
          childCount: result.children.length,
          ...(descriptionKind !== null ? { descriptionKind } : {}),
          classifications: summary,
        },
      });

      let descended = false;
      let stopped = false;

      for (const child of result.children) {
        const match = result.classifications.get(child.code) ?? "none";
        if (match === "none") continue;

        if (match === "related") {
          addCandidate(collected, child.code, match);
          if (hasChildren(cat, child.code)) {
            descended = true;
            queue.push(child.code);
          } else {
            stopped = true;
          }
          continue;
        }

        // Broad shelf judgment is kept even when we do not (re)walk children —
        // e.g. an embedding seed later marked broad under a higher parent.
        if (match === "broad") {
          addCandidate(collected, child.code, match);
          if (hasChildren(cat, child.code)) {
            descended = true;
            if (!visited.has(child.code)) {
              queue.push(child.code);
            }
          } else {
            stopped = true;
          }
          continue;
        }

        stopped = true;
        addCandidate(collected, child.code, match);
      }

      if (result.parent !== EXPO_ROOT && (stopped || !descended)) {
        addCandidate(collected, result.parent, "broad");
      }
    }
  }

  state.walks.push({
    walk: options.walk,
    compareAs: options.compareAs,
    status: classifySteps > 0 ? "completed" : "skipped",
    ...(classifySteps === 0 ? { reason: "no_children_under_seeds" } : {}),
    classifySteps,
  });
}

export async function collectTraversalCandidates(
  input: string,
  options: TraverseOptions = {}
): Promise<TraverseCollectResult> {
  const cat = Catalogue.load();
  const model = options.model?.trim() || defaultModel();
  const state: WalkState = { collected: [], walks: [], steps: [], audit: [], abort: null };
  const { audit } = state;

  audit.push({
    step: "traversal_start",
    detail: { root: EXPO_ROOT, hierarchy: DEFAULT_HIERARCHY, model },
  });

  const country = options.country ?? null;
  const seedLimit = options.embeddingSeedLimit ?? DEFAULT_EMBEDDING_SEED_LIMIT;
  const searchEmbeddings = seedLimit > 0 && vectorIndexAvailable();
  const renderedPromise = searchEmbeddings
    ? renderEmbeddingQuery(input, country, model)
    : Promise.resolve<EmbeddingQuery>({ english: null, query: input });
  const routed = await chatJson({
    model,
    system: routeSystem(country !== null),
    user: JSON.stringify({ input, ...(country !== null ? { country } : {}) }, null, 2),
  });
  const route = parseRoute(routed.content, input);
  const { descriptionKind } = route;

  audit.push({
    step: "route",
    detail: {
      input,
      model: routed.model,
      descriptionKind,
    },
  });

  const wholeSystem = routeWalkSystem(country !== null);
  const rendered = await renderedPromise;
  const embeddingSeeds = await embeddingWalkSeeds(rendered, seedLimit, audit);
  const wholeSeeds = [EXPO_ROOT, ...embeddingSeeds.filter((s) => s !== EXPO_ROOT)];

  await walkFromSeeds(
    cat,
    model,
    {
      walk: "whole_item",
      seeds: wholeSeeds,
      system: wholeSystem,
      compareAs: input,
      ...(descriptionKind !== null ? { descriptionKind } : {}),
      country,
    },
    state
  );

  const candidates = toCandidateRefs(cat, state.collected);
  audit.push({
    step: "traversal_collect",
    detail: {
      candidateCount: candidates.length,
      partial: state.abort !== null,
      ...(state.abort !== null
        ? { abortKind: state.abort.kind, abortMessage: state.abort.message }
        : {}),
      candidates: candidates.map((c) => ({
        code: c.code,
        name: c.name,
        match: c.match,
      })),
    },
  });

  // Empty pool after a provider abort: surface that error to encode.
  if (candidates.length === 0 && state.abort !== null) {
    throw state.abort;
  }

  return {
    candidates,
    descriptionKind,
    walks: state.walks,
    steps: state.steps,
    audit,
  };
}
