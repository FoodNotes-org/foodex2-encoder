/**
 * Thin chat client for any OpenAI-compatible endpoint (JSON responses).
 *
 * Bring your own model: the endpoint, key and model come from the environment.
 *   FOODEX2_LLM_BASE_URL  default https://openrouter.ai/api/v1
 *                         (e.g. https://api.openai.com/v1, http://localhost:11434/v1)
 *   FOODEX2_LLM_API_KEY   bearer token; omit for endpoints that need none
 *   FOODEX2_MODEL         model id as the endpoint knows it; required when
 *                         the endpoint is not the OpenRouter default
 *
 * Caps max_tokens so thin credit balances are usable. Classifies provider
 * failures so callers/eval can stop or degrade instead of treating them as
 * bad picks.
 */

export type LlmErrorKind =
  | "provider_credits"
  | "provider_rate_limit"
  | "provider_unavailable"
  | "model_response_invalid"
  | "provider_error";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | null;

  constructor(kind: LlmErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.status = status;
  }
}

export function isProviderInfraReason(reason: string): boolean {
  return (
    reason === "provider_credits" ||
    reason === "provider_rate_limit" ||
    reason === "provider_unavailable"
  );
}

export interface ChatJsonOptions {
  model?: string;
  system: string;
  user: string;
  temperature?: number;
  /** Completion budget (default 2048). Kept modest so OpenRouter does not reserve a huge max. */
  maxTokens?: number;
}

export interface ChatJsonResult {
  model: string;
  content: unknown;
  rawText: string;
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** Only meaningful on OpenRouter; other endpoints name models differently. */
const OPENROUTER_DEFAULT_MODEL = "openai/gpt-5.4";
const DEFAULT_MAX_TOKENS = 2048;
const CREDITS_RETRY_MAX_TOKENS = 1024;
const RATE_LIMIT_RETRIES = 2;

export interface LlmConfig {
  baseUrl: string;
  apiKey: string | null;
  model: string;
}

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/** Endpoint, key and model from the environment. Throws when no model can be named. */
export function llmConfig(): LlmConfig {
  const baseUrl = (env("FOODEX2_LLM_BASE_URL") ?? OPENROUTER_BASE_URL).replace(/\/+$/, "");
  const isOpenRouter = baseUrl === OPENROUTER_BASE_URL;
  const apiKey = env("FOODEX2_LLM_API_KEY") ?? (isOpenRouter ? env("OPENROUTER_API_KEY") : null);
  const model = env("FOODEX2_MODEL") ?? (isOpenRouter ? OPENROUTER_DEFAULT_MODEL : null);
  if (model === null) {
    throw new LlmError(
      "provider_error",
      `Configuration is missing a value for FOODEX2_MODEL (name the model as ${baseUrl} knows it)`
    );
  }
  return { baseUrl, apiKey, model };
}

export function defaultModel(): string {
  return llmConfig().model;
}

function classifyHttpError(status: number, body: string): LlmErrorKind {
  if (status === 402) return "provider_credits";
  if (status === 429) return "provider_rate_limit";
  if (status >= 500) return "provider_unavailable";
  const lower = body.toLowerCase();
  if (lower.includes("credit") || lower.includes("afford")) return "provider_credits";
  if (lower.includes("rate")) return "provider_rate_limit";
  return "provider_error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Request parameters the endpoint has rejected, learned from 400
 * unsupported_parameter replies and kept for the process. OpenAI's current
 * models want max_completion_tokens and no temperature; others take the
 * classic names.
 */
const rejectedParams = new Set<string>();

/** The parameter a 400 reply names as unsupported, if that is what it says. */
function unsupportedParam(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; param?: unknown } };
    const { code, param } = parsed.error ?? {};
    return code === "unsupported_parameter" && typeof param === "string" ? param : null;
  } catch {
    return null;
  }
}

async function postChatCompletion(args: {
  config: LlmConfig;
  model: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
}): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (args.config.apiKey !== null) headers.Authorization = `Bearer ${args.config.apiKey}`;
  const body: Record<string, unknown> = {
    model: args.model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: args.system },
      { role: "user", content: args.user },
    ],
  };
  if (!rejectedParams.has("temperature")) body.temperature = args.temperature;
  body[rejectedParams.has("max_tokens") ? "max_completion_tokens" : "max_tokens"] = args.maxTokens;
  return fetch(`${args.config.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export async function chatJson(options: ChatJsonOptions): Promise<ChatJsonResult> {
  const config = llmConfig();
  const endpoint = new URL(config.baseUrl).host;
  const model = options.model?.trim() || config.model;
  const temperature = options.temperature ?? 0;
  let maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  let rateLimitAttempt = 0;
  let creditsRetried = false;

  for (;;) {
    const response = await postChatCompletion({
      config,
      model,
      system: options.system,
      user: options.user,
      temperature,
      maxTokens,
    });

    if (!response.ok) {
      const body = await response.text();
      const rejected = response.status === 400 ? unsupportedParam(body) : null;
      if (rejected !== null && !rejectedParams.has(rejected)) {
        rejectedParams.add(rejected);
        continue;
      }
      const kind = classifyHttpError(response.status, body);
      const hint =
        (response.status === 401 || response.status === 403) && config.apiKey === null
          ? " (FOODEX2_LLM_API_KEY is not set)"
          : "";
      const message = `${endpoint} ${response.status}${hint}: ${body.slice(0, 500)}`;

      if (kind === "provider_rate_limit" && rateLimitAttempt < RATE_LIMIT_RETRIES) {
        rateLimitAttempt += 1;
        await sleep(1000 * rateLimitAttempt);
        continue;
      }

      if (
        kind === "provider_credits" &&
        !creditsRetried &&
        maxTokens > CREDITS_RETRY_MAX_TOKENS
      ) {
        creditsRetried = true;
        maxTokens = CREDITS_RETRY_MAX_TOKENS;
        continue;
      }

      throw new LlmError(kind, message, response.status);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const rawText = payload.choices?.[0]?.message?.content?.trim() ?? "";
    if (rawText === "") {
      throw new LlmError(
        "model_response_invalid",
        `${endpoint} returned an empty message`,
        response.status
      );
    }

    let content: unknown;
    try {
      content = JSON.parse(rawText);
    } catch {
      throw new LlmError(
        "model_response_invalid",
        `${endpoint} returned non-JSON: ${rawText.slice(0, 300)}`,
        response.status
      );
    }

    return { model, content, rawText };
  }
}
