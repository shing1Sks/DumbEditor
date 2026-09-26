import assert from "node:assert/strict";
import test from "node:test";
import { parseOpenAIResponse } from "../src/core/openai.js";
import { calculateLunaUsage, runLunaAgent, type AgentTool, type LunaUsage } from "../src/core/luna-agent.js";

test("calculates Luna token cost including cache reads and writes", () => {
  const usage = calculateLunaUsage({
    input_tokens: 1_000_000,
    input_tokens_details: { cached_tokens: 200_000, cache_write_tokens: 100_000 },
    output_tokens: 100_000,
  });
  assert.equal(usage.inputTokens, 1_000_000);
  assert.equal(usage.cachedInputTokens, 200_000);
  assert.equal(usage.cacheWriteTokens, 100_000);
  assert.equal(usage.outputTokens, 100_000);
  assert.equal(usage.costUsd, 0.244);
});

test("prices usage with the configured editor model", () => {
  const usage = { input_tokens: 1_000, input_tokens_details: { cached_tokens: 100 }, output_tokens: 200 };
  const luna = calculateLunaUsage(usage, "gpt-6-luna");
  const sol = calculateLunaUsage(usage, "gpt-6-sol");
  assert.equal(sol.costUsd, luna.costUsd * 20);
});

test("turns an OpenAI tool call into a validated edit", () => {
  assert.deepEqual(parseOpenAIResponse({ output: [{ type: "function_call", name: "remove_ranges", arguments: JSON.stringify({ ranges: [{ start: 0, end: 2 }, { start: 90, end: 100 }] }) }] }), {
    kind: "edit", edit: { action: "remove", ranges: [{ start: 0, end: 2 }, { start: 90, end: 100 }] }, model: "gpt-6-luna",
  });
});

test("accepts an OpenAI explanation and rejects malformed actions", () => {
  assert.deepEqual(parseOpenAIResponse({ output: [{ type: "function_call", name: "answer_user", arguments: JSON.stringify({ message: "That effect is not available yet." }) }] }), {
    kind: "message", message: "That effect is not available yet.", model: "gpt-6-luna",
  });
  assert.throws(() => parseOpenAIResponse({ output: [{ type: "function_call", name: "change_speed", arguments: JSON.stringify({ start: 2, end: 3, factor: 100 }) }] }), /outside/);
});

test("Luna executes a tool call and returns the reviewed final response", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const requests: Array<Record<string, unknown>> = [];
  const recordedUsage: LunaUsage[] = [];
  let call = 0;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    call += 1;
    if (call === 1) return Response.json({
      output: [{ type: "function_call", name: "record_edit", arguments: "{\"label\":\"done\"}", call_id: "call_1" }],
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 100 }, output_tokens: 200 },
    });
    if (call === 2) return Response.json({
      output: [{ type: "function_call", name: "audit_output", arguments: "{}", call_id: "call_2" }],
      usage: { input_tokens: 1500, input_tokens_details: { cached_tokens: 300 }, output_tokens: 120 },
    });
    return Response.json({
      output: [{ type: "message", content: [{ type: "output_text", text: "Created v0001." }] }],
      usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 500 }, output_tokens: 100 },
    });
  }) as typeof fetch;
  const tool: AgentTool = {
    name: "record_edit",
    description: "Record an edit",
    parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false },
    mutatesProject: true,
    run: async (args) => ({ ok: true, message: String(args.label) }),
  };
  const auditTool: AgentTool = {
    name: "audit_output",
    description: "Audit the rendered output",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    auditsProject: true,
    run: async () => ({ ok: true, message: "Output looks correct" }),
  };
  try {
    const result = await runLunaAgent({
      model: "gpt-6-sol",
      request: "make an edit",
      media: { path: "video.mp4", duration: 5, width: 640, height: 360, fps: 30, hasAudio: true, formatName: "mp4" },
      currentVersionId: "v0000",
      currentTime: 0,
      selection: { in: null, out: null },
      history: [
        { role: "user", content: "What is currently selected?", at: "2026-09-26T00:00:00.000Z" },
        { role: "assistant", content: "The current video is ready for editing.", at: "2026-09-26T00:00:01.000Z" },
      ],
      tools: [tool, auditTool],
      onUsage: async (usage) => { recordedUsage.push(usage); },
    });
    assert.equal(result.message, "Created v0001.");
    assert.equal(result.model, "gpt-6-sol");
    assert.equal(result.toolCalls, 2);
    assert.equal(result.mutations, 1);
    assert.equal(recordedUsage.length, 3);
    assert.equal(result.costUsd, recordedUsage.reduce((sum, usage) => sum + usage.costUsd, 0));
    assert.equal(requests.length, 3);
    assert.equal(requests[0]?.model, "gpt-6-sol");
    const firstInput = requests[0]?.input as Array<Record<string, unknown>>;
    const userHistory = firstInput.find((item) => item.role === "user") as { content?: Array<Record<string, unknown>> };
    const assistantHistory = firstInput.find((item) => item.role === "assistant") as { content?: Array<Record<string, unknown>> };
    assert.equal(userHistory.content?.[0]?.type, "input_text");
    assert.equal(assistantHistory.content?.[0]?.type, "output_text");
    const finalInput = requests[2]?.input as Array<Record<string, unknown>>;
    assert.equal(finalInput.some((item) => item.type === "function_call_output" && item.call_id === "call_1"), true);
    assert.equal(finalInput.some((item) => item.type === "function_call_output" && item.call_id === "call_2"), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("Luna continues beyond the former reasoning round cap", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  let responses = 0;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = (async () => {
    responses += 1;
    if (responses <= 13) return Response.json({
      output: [{ type: "function_call", name: "continue_work", arguments: "{}", call_id: `call_${responses}` }],
    });
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "Finished without an application cap." }] }] });
  }) as typeof fetch;
  try {
    const result = await runLunaAgent({
      model: "gpt-6-sol",
      request: "complete a long edit",
      media: { path: "video.mp4", duration: 5, width: 640, height: 360, fps: 30, hasAudio: true, formatName: "mp4" },
      currentVersionId: "v0000",
      currentTime: 0,
      selection: { in: null, out: null },
      history: [],
      tools: [{
        name: "continue_work",
        description: "Continue a long-running task",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        run: async () => ({ ok: true, message: "Continue" }),
      }],
    });
    assert.equal(result.toolCalls, 13);
    assert.equal(result.message, "Finished without an application cap.");
    assert.equal(responses, 14);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
