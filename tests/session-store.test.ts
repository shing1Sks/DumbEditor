import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionStore } from "../src/core/session/session-store.js";

const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: text, timestamp });
const textOf = (message: AgentMessage | undefined) => message && message.role === "user" && typeof message.content === "string" ? message.content : "";

async function withStore(run: (store: SessionStore, path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-session-"));
  try {
    const path = join(directory, "agent", "session.jsonl");
    await run(new SessionStore(path), path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("replays appended messages in order and never stores system messages", async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.load(), []);
    await store.appendMessage({ role: "system", content: "prompt", timestamp: 0 } as AgentMessage);
    await store.appendMessage(user("one", 1));
    await store.appendMessage(user("two", 2));
    assert.deepEqual((await store.load()).map(textOf), ["one", "two"]);
  });
});

test("a compaction entry replaces everything before the newest kept messages with the summary", async () => {
  await withStore(async (store) => {
    for (const [index, text] of ["a", "b", "c", "d"].entries()) await store.appendMessage(user(text, index + 1));
    await store.appendCompaction({ summaryMessage: user("SUMMARY", 10), keptCount: 2, tokensBefore: 123 });
    await store.appendMessage(user("e", 11));
    assert.deepEqual((await store.load()).map(textOf), ["SUMMARY", "c", "d", "e"]);
    await store.appendCompaction({ summaryMessage: user("SUMMARY 2", 20), keptCount: 0, tokensBefore: 456 });
    assert.deepEqual((await store.load()).map(textOf), ["SUMMARY 2"]);
  });
});

test("a replace entry swaps the whole transcript", async () => {
  await withStore(async (store) => {
    await store.appendMessage(user("old", 1));
    await store.appendReplace([user("new 1", 2), user("new 2", 3)]);
    await store.appendMessage(user("after", 4));
    assert.deepEqual((await store.load()).map(textOf), ["new 1", "new 2", "after"]);
  });
});

test("ignores a truncated final line and other unreadable lines", async () => {
  await withStore(async (store, path) => {
    await store.appendMessage(user("kept", 1));
    await appendFile(path, "not json\n{\"type\":\"message\",\"message\":{\"role\":\"us", "utf8");
    assert.deepEqual((await store.load()).map(textOf), ["kept"]);
  });
});
