import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createCostTracker } from "../src/core/pi/cost.js";
import { createEditorModels, createStreamFn, EDITOR_STREAM_DEFAULTS, openRouterModel } from "../src/core/pi/models.js";

// Opt-in: spends a fraction of a cent. Run with DUMBEDITOR_LIVE_TEST=1 and OPENROUTER_API_KEY set.
// Set DUMBEDITOR_LIVE_MODEL (for example anthropic/claude-haiku-4.5) to check the Anthropic-compatible path.
const live = process.env.DUMBEDITOR_LIVE_TEST === "1" && Boolean(process.env.OPENROUTER_API_KEY?.trim());

test("live: OpenRouter answers and reports a real cost", { skip: !live, timeout: 60_000 }, async () => {
  const models = createEditorModels({ apiKey: process.env.OPENROUTER_API_KEY!.trim() });
  const tracker = createCostTracker();
  const streamFn = createStreamFn(models, { ...EDITOR_STREAM_DEFAULTS, onProviderStreamEvent: tracker.onProviderStreamEvent });
  const model = openRouterModel(models, process.env.DUMBEDITOR_LIVE_MODEL?.trim() || "openai/gpt-4o-mini");
  const context = normalizeContext({ messages: [{ role: "user", content: "Reply with the single word: ready", timestamp: Date.now() }] });
  const message = await (await streamFn(model, context, { maxTokens: 20 })).result();
  assert.equal(message.stopReason, "stop", message.errorMessage);
  const cost = tracker.takeCost(message);
  assert.ok(cost, "the response carried no usage");
  console.log(`live cost for ${model.id}: ${JSON.stringify(cost)}`);
  assert.equal(cost.estimated, false, "OpenRouter's usage.cost did not reach the tracker; the wire shape differs from the documented one");
});
