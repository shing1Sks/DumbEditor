import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, validateToolArguments, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createCostTracker } from "../src/core/pi/cost.js";
import { createEditorModels, createStreamFn, fetchOpenRouterModelInfo, mergeStreamOptions, openRouterModel, parseOpenRouterModelInfo } from "../src/core/pi/models.js";
import { toolFromJsonSchema } from "../src/core/pi/tools.js";
import { makeFaux } from "./helpers/faux.js";

const prompt = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });

test("builds OpenRouter models that require provider support for the request, without touching the catalog", () => {
  const models = createEditorModels({ apiKey: "test-key" });
  const known = models.getModels("openrouter").find((model) => model.api === "openai-completions");
  assert.ok(known);
  const catalog = models.getModel("openrouter", known.id);
  const built = openRouterModel(models, known.id);
  assert.notEqual(built, catalog);
  assert.equal((built.compat as { openRouterRouting?: { require_parameters?: boolean } }).openRouterRouting?.require_parameters, true);
  assert.equal((catalog?.compat as { openRouterRouting?: unknown } | undefined)?.openRouterRouting, undefined);
});

test("builds a literal for an OpenRouter model id the catalog does not know", () => {
  const models = createEditorModels({ apiKey: "test-key" });
  const built = openRouterModel(models, "vendor/brand-new-model");
  assert.equal(built.id, "vendor/brand-new-model");
  assert.equal(built.provider, "openrouter");
  assert.equal(built.api, "openai-completions");
  assert.ok(built.input.includes("image"));
  assert.equal((built.compat as { openRouterRouting?: { require_parameters?: boolean } }).openRouterRouting?.require_parameters, true);
});

test("merges stream options: undefined never clobbers a default, headers merge, callbacks chain", async () => {
  const calls: string[] = [];
  const merged = mergeStreamOptions(
    { maxRetries: 3, cacheRetention: "short", headers: { a: "1" }, onProviderStreamEvent: () => { calls.push("default"); } },
    // The Agent really does pass explicit undefined values, which the option types do not model.
    { sessionId: undefined, maxRetries: undefined, headers: { b: "2" }, onProviderStreamEvent: () => { calls.push("call"); } } as unknown as SimpleStreamOptions,
  );
  assert.equal(merged.maxRetries, 3);
  assert.equal(merged.cacheRetention, "short");
  assert.deepEqual(merged.headers, { a: "1", b: "2" });
  await merged.onProviderStreamEvent?.({}, undefined as never);
  assert.deepEqual(calls, ["default", "call"]);
});

test("reports an already-aborted request as aborted without calling the model", async () => {
  const { faux, models, model } = makeFaux();
  const controller = new AbortController();
  controller.abort();
  const stream = await createStreamFn(models)(model, prompt, { signal: controller.signal });
  const message = await stream.result();
  assert.equal(message.stopReason, "aborted");
  assert.equal(faux.state.callCount, 0);
});

test("captures OpenRouter's real cost from the final usage chunk and falls back to the catalog estimate", () => {
  const tracker = createCostTracker();
  tracker.onProviderStreamEvent({ id: "gen-1", choices: [], usage: { prompt_tokens: 10, cost: 0.0123, is_byok: false } }, undefined as never);
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
  assert.deepEqual(tracker.takeCost({ responseId: "gen-1", usage }), { costUsd: 0.0123, estimated: false, source: "openrouter", byok: false });
  assert.equal(tracker.pendingCount(), 0);
  assert.deepEqual(tracker.takeCost({ responseId: "gen-2", usage }), { costUsd: 0.5, estimated: true, source: "catalog-estimate" });
});

test("strict tools reject arguments pi would otherwise coerce", () => {
  const schema = { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false };
  const execute = async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} });
  const lenient = toolFromJsonSchema({ name: "t", description: "t", jsonSchema: schema, execute });
  const strict = toolFromJsonSchema({ name: "t", description: "t", jsonSchema: schema, strict: true, execute });
  const toolCall = (args: Record<string, number | null>) => ({ type: "toolCall" as const, id: "1", name: "t", arguments: args });
  assert.equal(validateToolArguments(lenient, toolCall({ count: null })).count, 0, "pi coerces null to 0 by default");
  assert.throws(() => strict.prepareArguments?.({ count: null }), /Invalid arguments for tool "t"/);
  assert.deepEqual(strict.prepareArguments?.({ count: 2 }), { count: 2 });
});

const LIVE_ENTRY = {
  id: "vendor/brand-new-model",
  context_length: 1_050_000,
  architecture: { input_modalities: ["file", "image", "text"] },
  pricing: { prompt: "0.0000001", completion: "0.0000005", input_cache_read: "0.00000001", input_cache_write: "0.000000125" },
  top_provider: { max_completion_tokens: 128_000 },
  supported_parameters: ["max_tokens", "reasoning", "tools"],
};

test("reads context window, limits, reasoning and prices from an OpenRouter model list entry", () => {
  const info = parseOpenRouterModelInfo(LIVE_ENTRY);
  assert.deepEqual(info, { contextWindow: 1_050_000, maxTokens: 128_000, reasoning: true, image: true, cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } });
  assert.equal(parseOpenRouterModelInfo({ id: "x" }), undefined, "an entry without a context window tells us nothing");
  const built = openRouterModel(createEditorModels({ apiKey: "k" }), "vendor/brand-new-model", { info: info! });
  assert.equal(built.contextWindow, 1_050_000);
  assert.equal(built.reasoning, true);
  assert.equal(built.cost.output, 0.5);
});

test("finds one model in the OpenRouter list and gives up quietly on any failure", async () => {
  const listing = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
  assert.equal((await fetchOpenRouterModelInfo("vendor/brand-new-model", listing({ data: [{ id: "other/model" }, LIVE_ENTRY] })))?.contextWindow, 1_050_000);
  assert.equal(await fetchOpenRouterModelInfo("vendor/missing", listing({ data: [LIVE_ENTRY] })), undefined);
  assert.equal(await fetchOpenRouterModelInfo("vendor/brand-new-model", listing({}, false)), undefined);
  assert.equal(await fetchOpenRouterModelInfo("vendor/brand-new-model", (async () => { throw new Error("offline"); }) as unknown as typeof fetch), undefined);
});
