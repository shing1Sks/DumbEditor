import assert from "node:assert/strict";
import test from "node:test";
import { parseOpenAIResponse } from "../src/core/openai.js";

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
