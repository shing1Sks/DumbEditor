import assert from "node:assert/strict";
import test from "node:test";
import { parseOpenAIResponse } from "../src/core/openai.js";
import { runLunaAgent, type AgentTool } from "../src/core/luna-agent.js";

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
  let call = 0;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    call += 1;
    if (call === 1) return Response.json({ output: [{ type: "function_call", name: "record_edit", arguments: "{\"label\":\"done\"}", call_id: "call_1" }] });
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "Created v0001." }] }] });
  }) as typeof fetch;
  const tool: AgentTool = {
    name: "record_edit",
    description: "Record an edit",
    parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false },
    mutatesProject: true,
    run: async (args) => ({ ok: true, message: String(args.label) }),
  };
  try {
    const result = await runLunaAgent({
      request: "make an edit",
      media: { path: "video.mp4", duration: 5, width: 640, height: 360, fps: 30, hasAudio: true, formatName: "mp4" },
      currentVersionId: "v0000",
      currentTime: 0,
      selection: { in: null, out: null },
      history: [],
      tools: [tool],
    });
    assert.equal(result.message, "Created v0001.");
    assert.equal(result.toolCalls, 1);
    assert.equal(result.mutations, 1);
    assert.equal(requests.length, 2);
    const secondInput = requests[1]?.input as Array<Record<string, unknown>>;
    assert.equal(secondInput.some((item) => item.type === "function_call_output" && item.call_id === "call_1"), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
