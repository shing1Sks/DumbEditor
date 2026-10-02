/**
 * Model wiring for DumbEditor: OpenRouter as the sole provider.
 *
 * Verified against @earendil-works/pi-ai 1.0.0 (see SPIKE-REPORT.md).
 */
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type AuthContext,
  createAssistantMessageEventStream,
  createModels,
  type Model,
  type Models,
  type MutableModels,
  type SimpleStreamOptions,
  type OpenRouterRouting,
} from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { StreamFn } from "@earendil-works/pi-agent-core";

export const OPENROUTER_PROVIDER_ID = "openrouter";
export const OPENROUTER_OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
/** The catalog's anthropic/* entries use the Anthropic SDK, which appends /v1/messages itself. */
export const OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api";

const API_KEY_ENV = "OPENROUTER_API_KEY";

/**
 * A MutableModels with only the OpenRouter provider, authenticated with a key passed in code.
 *
 * How the key is supplied (all verified in tests/models.test.ts):
 *  - `createModels({ authContext })`: the provider's `envApiKeyAuth("...", ["OPENROUTER_API_KEY"])`
 *    reads env vars through `authContext.env(name)`. We replace the default context (which reads
 *    process.env) with one that answers only for our key. process.env is never consulted/mutated.
 *  - Alternatives that also work: a `CredentialStore` seeded with `{type:"api_key", key}`, or a
 *    per-request `apiKey` option (which the Agent sets from `getApiKey(provider)` / `config.apiKey`).
 */
export function createEditorModels(opts: { apiKey: string }): MutableModels {
  const authContext: AuthContext = {
    env: async (name) => (name === API_KEY_ENV ? opts.apiKey : undefined),
    fileExists: async () => false,
  };
  const models = createModels({ authContext });
  models.setProvider(openrouterProvider());
  return models;
}

export interface OpenRouterModelOptions {
  /** Override the base URL (used by tests to point at a local fake server). */
  baseUrl?: string;
  /** Extra routing prefs merged over `{ require_parameters: true }`. */
  routing?: OpenRouterRouting;
}

/** Placeholder literal for an OpenRouter model id that is not in pi's generated catalog yet. */
function unknownOpenRouterModel(id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: OPENROUTER_PROVIDER_ID,
    baseUrl: OPENROUTER_OPENAI_BASE_URL,
    reasoning: false,
    input: ["text", "image"],
    // $/million tokens. Unknown pricing: zero. Real cost comes from OpenRouter (see cost.ts).
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    // Same compat the catalog gives openai-completions models on OpenRouter.
    compat: { thinkingFormat: "openrouter", sendSessionAffinityHeaders: true },
  };
}

/**
 * Catalog model if known, else a literal. In BOTH cases returns a fresh object with
 * `compat.openRouterRouting.require_parameters = true`; the shared catalog object is never mutated
 * (the catalog's `compat` object is shared too, so it is copied as well).
 *
 * CAVEAT (verified in source): `openRouterRouting` is only read by the openai-completions adapter
 * (`params.provider = model.compat.openRouterRouting`). The catalog's `anthropic/*` models
 * (api "anthropic-messages") ignore it. Use `withOpenRouterRoutingPayload` for those if you need it.
 */
export function openRouterModel(models: Models, id: string, opts: OpenRouterModelOptions = {}): Model<Api> {
  const base: Model<Api> = models.getModel(OPENROUTER_PROVIDER_ID, id) ?? unknownOpenRouterModel(id);
  const compat = (base.compat ?? {}) as Record<string, unknown>;
  const previousRouting = (compat.openRouterRouting ?? {}) as OpenRouterRouting;
  return {
    ...base,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    compat: {
      ...compat,
      openRouterRouting: { ...previousRouting, require_parameters: true, ...opts.routing },
    },
  } as Model<Api>;
}

/** True when the catalog knows this id (so `openRouterModel` returns catalog data, not a literal). */
export function isCatalogModel(models: Models, id: string): boolean {
  return models.getModel(OPENROUTER_PROVIDER_ID, id) !== undefined;
}

type OnPayload = NonNullable<SimpleStreamOptions["onPayload"]>;

/**
 * `onPayload` hook that adds `provider: { require_parameters: true, ... }` to the request body of
 * models that go through the anthropic-messages adapter (where compat.openRouterRouting is ignored).
 * UNVERIFIED against the live OpenRouter /messages endpoint (no network in the spike): only the
 * payload mutation is tested. Opt in only after confirming OpenRouter accepts `provider` there.
 */
export function withOpenRouterRoutingPayload(routing: OpenRouterRouting = { require_parameters: true }): OnPayload {
  return (payload, model) => {
    if (model.api !== "anthropic-messages" || typeof payload !== "object" || payload === null) return undefined;
    return { ...(payload as Record<string, unknown>), provider: routing };
  };
}

/** Options we may default. Everything in SimpleStreamOptions is allowed; these are the ones that matter. */
export type StreamDefaults = Partial<SimpleStreamOptions>;

export const EDITOR_STREAM_DEFAULTS: StreamDefaults = { maxRetries: 3, cacheRetention: "short" };

function chain<A extends unknown[]>(
  first: ((...args: A) => unknown) | undefined,
  second: ((...args: A) => unknown) | undefined,
): ((...args: A) => Promise<void>) | undefined {
  if (!first) return second as undefined | ((...args: A) => Promise<void>);
  if (!second) return first as (...args: A) => Promise<void>;
  return async (...args: A) => {
    await first(...args);
    await second(...args);
  };
}

/**
 * Merge request options: per-call values win, but `undefined` never clobbers a default
 * (the Agent always passes keys like `sessionId: undefined`, `onPayload: undefined`, ...).
 * `headers` are shallow-merged and the three callbacks are chained (defaults first).
 */
export function mergeStreamOptions(defaults: StreamDefaults, options: SimpleStreamOptions | undefined): SimpleStreamOptions {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value !== undefined) merged[key] = value;
  }
  if (defaults.headers && options?.headers) merged.headers = { ...defaults.headers, ...options.headers };

  if (defaults.onProviderStreamEvent || options?.onProviderStreamEvent) {
    merged.onProviderStreamEvent = chain(defaults.onProviderStreamEvent, options?.onProviderStreamEvent);
  }
  if (defaults.onResponse || options?.onResponse) {
    merged.onResponse = chain(defaults.onResponse, options?.onResponse);
  }
  if (defaults.onPayload || options?.onPayload) {
    const a = defaults.onPayload;
    const b = options?.onPayload;
    merged.onPayload = async (payload: unknown, model: Model<Api>) => {
      const afterA = a ? ((await a(payload, model)) ?? payload) : payload;
      const afterB = b ? ((await b(afterA, model)) ?? afterA) : afterA;
      return afterB === payload ? undefined : afterB;
    };
  }
  return merged as SimpleStreamOptions;
}

function abortedMessage(model: Model<Api>, base?: AssistantMessage): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...base,
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    timestamp: Date.now(),
  };
}

/**
 * GOTCHA (verified): `Models.streamSimple` resolves auth first, and auth resolution throws
 * AbortError when the signal is already aborted. `lazyStream` then reports stopReason "error"
 * ("This operation was aborted") instead of "aborted". The Agent loop ALWAYS makes one more request
 * after an abort during a tool batch (it does not check the signal before requesting), so without this
 * normalization every abort-during-tools run would end as an "error". Mid-stream aborts inside the
 * adapters are already reported as "aborted".
 */
export function normalizeAbort(model: Model<Api>, source: AssistantMessageEventStream, signal: AbortSignal | undefined): AssistantMessageEventStream {
  if (!signal) return source;
  const out = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        if (event.type === "error" && event.reason === "error" && signal.aborted) {
          const message = abortedMessage(model, event.error);
          out.push({ type: "error", reason: "aborted", error: message });
          out.end(message);
          return;
        }
        out.push(event);
      }
      out.end(await source.result());
    } catch (error) {
      // Contract: a StreamFn must not reject; encode it in the stream.
      const message: AssistantMessage = { ...abortedMessage(model), stopReason: signal.aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error) };
      out.push({ type: "error", reason: message.stopReason as "aborted" | "error", error: message });
      out.end(message);
    }
  })();
  return out;
}

/**
 * StreamFn for `new Agent({ streamFn })` and for the compaction summarizer.
 * `Agent` forwards only: apiKey, signal, reasoning, sessionId, onPayload, onResponse,
 * onProviderStreamEvent, transport, thinkingBudgets, maxRetryDelayMs. Everything else
 * (maxRetries, cacheRetention, timeoutMs, maxTokens, headers, metadata, temperature, fetch, env...)
 * can only reach the provider through this wrapper.
 */
export function createStreamFn(models: Models, defaults: StreamDefaults = EDITOR_STREAM_DEFAULTS): StreamFn {
  return (model, context, options) => {
    if (options?.signal?.aborted) {
      const message = abortedMessage(model);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: "aborted", error: message });
      stream.end(message);
      return stream;
    }
    return normalizeAbort(model, models.streamSimple(model, context, mergeStreamOptions(defaults, options)), options?.signal);
  };
}
