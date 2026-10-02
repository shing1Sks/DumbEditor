import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  COMPACTION_SUMMARY_PREFIX, compact, findCutIndex, isSummaryMessage, NothingToCompactError, serializeConversation, shouldCompact,
} from "../src/core/pi/compaction.js";
import { createStreamFn } from "../src/core/pi/models.js";
import { makeFaux, say } from "./helpers/faux.js";

let clock = 1_000;
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: clock++ });
const usageOf = (total: number): AssistantMessage["usage"] => ({
  input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const assistant = (content: AssistantMessage["content"], total = 0): AgentMessage => ({
  role: "assistant", content, api: "x", provider: "p", model: "m", usage: usageOf(total), stopReason: "stop", timestamp: clock++,
});
const toolCall = (id: string) => ({ type: "toolCall" as const, id, name: "tool", arguments: { id } });
const toolResult = (id: string, content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>): AgentMessage => ({
  role: "toolResult", toolCallId: id, toolName: "tool", content, isError: false, timestamp: clock++,
});
const chars = (count: number) => "x".repeat(count);

test("compacts when real usage passes the threshold of the context window", () => {
  const messages = [user("a"), assistant([{ type: "text", text: "b" }], 60_000)];
  assert.equal(shouldCompact(messages, 100_000), false, "exactly at 60% is not over");
  assert.equal(shouldCompact([user("a"), assistant([{ type: "text", text: "b" }], 60_001)], 100_000), true);
  assert.equal(shouldCompact([user("a"), assistant([{ type: "text", text: "b" }], 60_001)], 100_000, { thresholdRatio: 0.9 }), false);
  assert.equal(shouldCompact(messages, 0), false, "unknown context window never compacts");
});

test("never cuts at a tool result or between a tool call and its result", () => {
  const messages: AgentMessage[] = [];
  for (let turn = 0; turn < 40; turn += 1) {
    messages.push(user(chars(400)));
    messages.push(assistant([toolCall(`c${turn}`)]));
    messages.push(toolResult(`c${turn}`, [{ type: "text", text: chars(400) }]));
    messages.push(assistant([{ type: "text", text: chars(400) }]));
  }
  for (const budget of [50, 300, 1_000, 2_500, 6_000]) {
    const cut = findCutIndex(messages, budget);
    const role = messages[cut]?.role;
    assert.ok(role === "user" || role === "assistant", `cut at ${cut} landed on ${role}`);
    const kept = messages.slice(cut);
    const calls = new Set(kept.flatMap((message) => message.role === "assistant" ? (message as AssistantMessage).content.filter((block) => block.type === "toolCall").map((block) => (block as { id: string }).id) : []));
    for (const message of kept) {
      if (message.role === "toolResult") assert.ok(calls.has(message.toolCallId), `kept result ${message.toolCallId} lost its call`);
    }
  }
});

test("serialization marks images instead of embedding them and truncates long tool results", () => {
  const text = serializeConversation([
    user("look at this"),
    toolResult("c1", [{ type: "text", text: chars(5_000) }, { type: "image", data: "AAAABBBB", mimeType: "image/jpeg" }]),
  ] as Message[]);
  assert.ok(!text.includes("AAAABBBB"));
  assert.match(text, /\[1 image omitted: image\/jpeg\]/);
  assert.match(text, /\[\.\.\. 3000 more characters truncated\]/);
});

test("summarizes older messages once, records visual findings, and resumes as [summary, ...recent]", async () => {
  const { faux, models, model } = makeFaux();
  let request = "";
  faux.setResponses([(context) => {
    request = JSON.stringify(context.messages);
    return say("## Goal\nEdit the intro\n\n## Visual findings\n- frame at 1.0s showed a blue title card");
  }]);
  const messages: AgentMessage[] = [{ role: "system", content: "prompt", timestamp: 0 } as AgentMessage];
  for (let turn = 0; turn < 10; turn += 1) {
    messages.push(user(`request ${turn} ${chars(800)}`));
    messages.push(assistant([toolCall(`c${turn}`)]));
    messages.push(toolResult(`c${turn}`, [{ type: "text", text: "ok" }, { type: "image", data: "ZmFrZS1pbWFnZQ==", mimeType: "image/jpeg" }]));
    messages.push(assistant([{ type: "text", text: `done ${turn}` }]));
  }
  const result = await compact(messages, { model, streamFn: createStreamFn(models), keepRecentTokens: 700 });
  assert.equal(faux.state.callCount, 1);
  assert.match(request, /Visual findings/);
  assert.match(request, /\[1 image omitted: image\/jpeg\]/);
  assert.ok(!request.includes("ZmFrZS1pbWFnZQ=="), "image data must never reach the summarizer");
  assert.equal(result.messages[0]?.role, "system");
  assert.ok(isSummaryMessage(result.messages[1] as AgentMessage));
  assert.match(JSON.stringify(result.messages[1]), /frame at 1\.0s showed a blue title card/);
  assert.ok(JSON.stringify(result.messages[1]).includes(COMPACTION_SUMMARY_PREFIX.trim().slice(0, 20)));
  assert.equal(result.messages.length, 2 + result.keptMessages.length);
  assert.ok(result.keptMessages.length > 0 && result.keptMessages.length < messages.length - 1);
  assert.ok((result.summaryMessage.timestamp ?? 0) > Math.max(...result.keptMessages.map((message) => message.timestamp)));
});

test("refuses to compact a conversation that already fits", async () => {
  const { models, model } = makeFaux();
  await assert.rejects(
    compact([user("hi"), assistant([{ type: "text", text: "hello" }])], { model, streamFn: createStreamFn(models) }),
    NothingToCompactError,
  );
});
