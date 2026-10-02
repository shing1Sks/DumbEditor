/**
 * Capture OpenRouter's real per-request cost.
 *
 * What `onProviderStreamEvent(data, model)` receives (verified in
 * pi-ai/src/api/openai-completions.ts and anthropic-messages.ts, and end-to-end against a local fake
 * server in cost.test.ts):
 *
 *  - openai-completions (every non-anthropic OpenRouter model): `data` is the RAW parsed
 *    `ChatCompletionChunk` object, passed before pi normalizes anything:
 *        openai-completions.ts:554   `await options?.onProviderStreamEvent?.(chunk, model);`
 *    pi's own `parseChunkUsage` (openai-completions.ts:1511) IGNORES `usage.cost`, so this hook is
 *    the only place the OpenRouter-reported cost is visible. OpenRouter puts it on the final usage
 *    chunk: `{ id, model, choices: [], usage: { prompt_tokens, completion_tokens, total_tokens,
 *    cost, is_byok, cost_details: { upstream_inference_cost, ... }, ... } }`. (That OpenRouter
 *    wire shape is from OpenRouter's docs/knowledge, NOT verified against the live API here.)
 *
 *  - anthropic-messages (the catalog's anthropic/* models): `data` is the raw Anthropic
 *    `RawMessageStreamEvent` (anthropic-messages.ts:664). `message_start.message.id` is the response
 *    id; `message_delta.usage` carries token counts. Whether OpenRouter's Anthropic-compatible
 *    endpoint adds `usage.cost` there CANNOT be verified without network; this module looks for a
 *    numeric `usage.cost` on `message_start.message` / `message_delta` and otherwise falls back.
 *
 * The cost is matched to an assistant message by `message.responseId`
 * (chat: `chunk.id` -> openai-completions.ts:558; anthropic: `message_start.message.id` -> :666).
 */
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

export interface RequestCost {
  costUsd: number;
  /** true when this is pi's catalog-price estimate (`usage.cost.total`), not OpenRouter's number. */
  estimated: boolean;
  source: "openrouter" | "catalog-estimate";
  /** OpenRouter BYOK flag, when reported. For BYOK, `costUsd` is what OpenRouter charged (fee only). */
  byok?: boolean;
  /** `usage.cost_details.upstream_inference_cost`, when reported. */
  upstreamCostUsd?: number;
}

export interface CostTracker {
  /** Pass as `onProviderStreamEvent` (Agent option / StreamFn defaults). */
  onProviderStreamEvent: (data: unknown, model: Model<Api>) => void;
  /**
   * Cost for a finished assistant message. Prefers the OpenRouter-reported cost captured for
   * `message.responseId` (and forgets it); otherwise returns `message.usage.cost.total` with
   * `estimated: true`. Returns undefined only when the message has neither (no usage at all).
   */
  takeCost(message: Pick<AssistantMessage, "responseId" | "usage">): RequestCost | undefined;
  /** Number of captured-but-not-yet-taken OpenRouter costs (for leak checks). */
  pendingCount(): number;
}

interface Captured {
  costUsd: number;
  byok?: boolean;
  upstreamCostUsd?: number;
}

const MAX_PENDING = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readUsageCost(usage: unknown): Captured | undefined {
  if (!isRecord(usage)) return undefined;
  const costUsd = finiteNumber(usage.cost);
  if (costUsd === undefined) return undefined;
  const details = isRecord(usage.cost_details) ? usage.cost_details : undefined;
  const upstream = finiteNumber(details?.upstream_inference_cost);
  return {
    costUsd,
    ...(typeof usage.is_byok === "boolean" ? { byok: usage.is_byok } : {}),
    ...(upstream !== undefined ? { upstreamCostUsd: upstream } : {}),
  };
}

export function createCostTracker(): CostTracker {
  const captured = new Map<string, Captured>();
  // anthropic-messages events do not repeat the response id after message_start.
  // NOTE: this makes the anthropic path lane-scoped: use one tracker per sequential request lane.
  let currentAnthropicId: string | undefined;

  const remember = (id: string | undefined, value: Captured) => {
    if (!id) return;
    captured.set(id, value);
    while (captured.size > MAX_PENDING) captured.delete(captured.keys().next().value as string);
  };

  return {
    onProviderStreamEvent(data) {
      if (!isRecord(data)) return;
      // Anthropic raw stream events
      if (data.type === "message_start" && isRecord(data.message)) {
        currentAnthropicId = typeof data.message.id === "string" ? data.message.id : undefined;
        const cost = readUsageCost(data.message.usage);
        if (cost) remember(currentAnthropicId, cost);
        return;
      }
      if (data.type === "message_delta") {
        const cost = readUsageCost(data.usage);
        if (cost) remember(currentAnthropicId, cost);
        return;
      }
      // OpenAI-compatible chat completion chunk (OpenRouter): usage.cost on the final chunk.
      const cost = readUsageCost(data.usage);
      if (cost && typeof data.id === "string") remember(data.id, cost);
    },

    takeCost(message) {
      const id = message.responseId;
      const real = id ? captured.get(id) : undefined;
      if (id && real) {
        captured.delete(id);
        return { ...real, estimated: false, source: "openrouter" };
      }
      const total = message.usage?.cost?.total;
      if (typeof total !== "number") return undefined;
      return { costUsd: total, estimated: true, source: "catalog-estimate" };
    },

    pendingCount: () => captured.size,
  };
}
