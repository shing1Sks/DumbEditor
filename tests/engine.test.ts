import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream, fauxAssistantMessage, type AssistantMessage, type Model, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createEditorRegistry } from "../src/core/actions/index.js";
import { Engine } from "../src/core/engine/engine.js";
import type { EngineEvent } from "../src/core/engine/events.js";
import { AUDIT_NUDGE } from "../src/core/engine/prompt.js";
import type { CostTracker } from "../src/core/pi/cost.js";
import { createStreamFn } from "../src/core/pi/models.js";
import { SessionStore } from "../src/core/session/session-store.js";
import { DEFAULT_SETTINGS, type DumbEditorSettings } from "../src/core/settings.js";
import { call, makeFaux, say, toolUse } from "./helpers/faux.js";
import { makeProject } from "./helpers/project.js";

type RunEnd = Extract<EngineEvent, { type: "run_end" }>;

interface HarnessOptions {
  agent?: Partial<DumbEditorSettings["agent"]>;
  tracker?: CostTracker;
  stallMs?: number;
  keepRecentTokens?: number;
  contextWindow?: number;
}

async function harness(options: HarnessOptions = {}) {
  const project = await makeProject();
  const { faux, models, model } = makeFaux(options.contextWindow
    ? { models: [{ id: "small", name: "small", reasoning: false, input: ["text", "image"], contextWindow: options.contextWindow, maxTokens: 1_000 }] }
    : {});
  const settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings.agent, options.agent);
  const session = new SessionStore(join(project.directory, "agent", "session.jsonl"));
  const engineOptions = {
    state: project.state, registry: createEditorRegistry(), session, models, modelId: "faux", model,
    streamFn: createStreamFn(models), getSettings: () => settings,
    ...(options.tracker ? { tracker: options.tracker } : {}),
    ...(options.stallMs ? { stallMs: options.stallMs } : {}),
    ...(options.keepRecentTokens ? { keepRecentTokens: options.keepRecentTokens } : {}),
  };
  const engine = await Engine.create(engineOptions);
  const events: EngineEvent[] = [];
  engine.on((event) => events.push(event));
  const next = (type: EngineEvent["type"]) => waitFor(events, (event) => event.type === type);
  const runEnd = () => new Promise<RunEnd>((resolve) => {
    const off = engine.on((event) => { if (event.type === "run_end") { off(); resolve(event); } });
  });
  const ask = (text: string) => { const done = runEnd(); engine.submit(text); return done; };
  return { project, faux, models, model, settings, session, engine, engineOptions, events, next, runEnd, ask, cleanup: () => project.cleanup() };
}

async function waitFor(events: EngineEvent[], match: (event: EngineEvent) => boolean, seen = 0): Promise<EngineEvent> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = events.slice(seen).find(match);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for an engine event");
}

/** What a model request carried, one line per message, so tests can assert on the transcript. */
function flat(context: TranscriptContext): string[] {
  return context.messages.map((message) => {
    const content = (message as { content: unknown }).content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map((block: { type: string; text?: string; name?: string }) => block.type === "text" ? block.text ?? "" : `<${block.type}${block.name ? `:${block.name}` : ""}>`).join("") : "";
    return `${message.role}:${text}`;
  });
}

/** A scripted reply that also records the request it answered. */
function reply(message: AssistantMessage, seen: string[][]) {
  return (context: TranscriptContext) => { seen.push(flat(context)); return message; };
}

const REMOVE_END = call("remove_ranges", { ranges: [{ start: 3, end: 4 }] }, "c1");
const AUDIT = call("inspect_video_frames", { timestamps: [0.5], detail: "low" }, "c2");
const CHOICE = (id: string) => call("present_choices", { question: "Which one?", options: ["A", "B"], allow_custom: false }, id);
const BAD_GRAPH = (id: string) => call("render_custom_ffmpeg", { filter_graph: "movie=secret.mp4[v]", asset_ids: [], video_map: "[v]", audio_map: null, summary: "bad" }, id);
const GENERATE = call("generate_asset", { kind: "image", prompt: "a cat", duration: null, voice: null, provider: null, model: null, provider_options_json: null }, "g1");

test("streams the answer and ends the run with the final message", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    h.faux.setResponses([say("Hello there")]);
    const end = await h.ask("hi");
    assert.deepEqual([end.reason, end.message], ["done", "Hello there"]);
    assert.equal(h.events[0]?.type, "run_start");
    assert.ok(h.events.some((event) => event.type === "text_delta"));
    assert.equal(h.engine.running, false);
  } finally { await h.cleanup(); }
});

test("runs an edit through the registry and asks the model to audit before it stops", { timeout: 90_000 }, async () => {
  const h = await harness();
  try {
    h.faux.setResponses([toolUse(REMOVE_END), say("Removed the end."), toolUse(AUDIT), say("Audited: looks right.")]);
    const end = await h.ask("remove the last second");
    assert.equal(end.message, "Audited: looks right.");
    const finished = h.events.find((event) => event.type === "tool_end" && event.callId === "c1");
    assert.deepEqual(finished && finished.type === "tool_end" ? [finished.ok, finished.versionId] : null, [true, "v0001"]);
    assert.equal(h.project.store.current.id, "v0001");
    assert.ok((await h.session.load()).some((message) => JSON.stringify(message).includes("visually audit")));
    assert.equal(h.faux.getPendingResponseCount(), 0);
  } finally { await h.cleanup(); }
});

test("stops nudging after two audit reminders even if the model ignores them", { timeout: 90_000 }, async () => {
  const h = await harness();
  try {
    h.faux.setResponses([toolUse(REMOVE_END), say("one"), say("two"), say("three"), say("never used")]);
    const end = await h.ask("remove the last second");
    assert.equal(end.message, "three");
    assert.equal((await h.session.load()).filter((message) => JSON.stringify(message).includes("visually audit")).length, 2);
    assert.equal(h.faux.getPendingResponseCount(), 1);
  } finally { await h.cleanup(); }
});

test("sends editor state only when it changed", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const seen: string[][] = [];
    h.faux.setResponses([reply(say("one"), seen), reply(say("two"), seen), reply(say("three"), seen)]);
    await h.ask("first");
    await h.ask("second");
    h.project.state.setPlayhead(2);
    await h.ask("third");
    const states = (lines: string[]) => lines.filter((line) => line.startsWith("user:<editor_state"));
    assert.equal(states(seen[0] ?? []).length, 1);
    assert.equal(states(seen[1] ?? []).length, 1, "unchanged state is not sent again");
    assert.equal(states(seen[2] ?? []).length, 2);
    assert.match(states(seen[2] ?? [])[1] ?? "", /Playhead: 2\.0s/);
  } finally { await h.cleanup(); }
});

test("text typed during a run steers it after the current tool finishes", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const seen: string[][] = [];
    h.faux.setResponses([toolUse(CHOICE("c1")), reply(say("ok"), seen)]);
    const done = h.runEnd();
    h.engine.submit("start");
    const choice = await h.next("choice_request");
    h.engine.submit("also make it shorter");
    await h.next("steer_queued");
    assert.equal(choice.type, "choice_request");
    if (choice.type === "choice_request") h.engine.resolveChoice(choice.id, "A");
    const end = await done;
    assert.equal(end.reason, "done");
    const request = seen[0] ?? [];
    assert.ok(request.some((line) => line.includes("The user chose: A")));
    assert.ok(request.indexOf("user:also make it shorter") > request.findIndex((line) => line.includes("The user chose: A")));
  } finally { await h.cleanup(); }
});

test("abort ends the run, cancels the waiting action and closes unanswered tool calls", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    h.faux.setResponses([toolUse(CHOICE("c1"), call("list_versions", {}, "c2"))]);
    const done = h.runEnd();
    h.engine.submit("ask me");
    await h.next("choice_request");
    h.engine.abort();
    const end = await done;
    assert.equal(end.reason, "aborted");
    assert.equal(h.engine.running, false);
    const results = (await h.session.load()).filter((message) => message.role === "toolResult") as Array<{ toolCallId: string; isError: boolean; content: Array<{ text?: string }> }>;
    assert.deepEqual(results.map((result) => [result.toolCallId, result.isError]), [["c1", true], ["c2", true]]);
    assert.match(results[1]?.content[0]?.text ?? "", /Cancelled by user/);
  } finally { await h.cleanup(); }
});

test("paid actions ask first; a denial blocks the action and the model hears about it", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const seen: string[][] = [];
    h.faux.setResponses([toolUse(GENERATE), reply(say("I will not generate it."), seen)]);
    const done = h.runEnd();
    h.engine.submit("make a cat image");
    const request = await h.next("approval_request");
    assert.equal(request.type === "approval_request" ? request.risk : "", "spend");
    if (request.type === "approval_request") h.engine.resolveApproval(request.id, "deny");
    const end = await done;
    assert.equal(end.reason, "done");
    assert.ok((seen[0] ?? []).some((line) => line.includes("The user denied this action")));
  } finally { await h.cleanup(); }
});

test("allow-for-session asks once per action; auto mode never asks", { timeout: 60_000 }, async () => {
  const asking = await harness();
  try {
    asking.faux.setResponses([toolUse(BAD_GRAPH("a1"), BAD_GRAPH("a2")), say("done")]);
    const done = asking.runEnd();
    asking.engine.submit("try custom ffmpeg");
    const request = await asking.next("approval_request");
    assert.equal(request.type === "approval_request" ? request.risk : "", "code");
    if (request.type === "approval_request") asking.engine.resolveApproval(request.id, "session");
    await done;
    assert.equal(asking.events.filter((event) => event.type === "approval_request").length, 1);
    assert.equal(asking.events.filter((event) => event.type === "tool_end" && !event.ok).length, 2, "the bad graph is rejected by the action itself");
  } finally { await asking.cleanup(); }
  const auto = await harness({ agent: { permissionMode: "auto" } });
  try {
    auto.faux.setResponses([toolUse(BAD_GRAPH("b1")), say("done")]);
    await auto.ask("try custom ffmpeg");
    assert.equal(auto.events.filter((event) => event.type === "approval_request").length, 0);
  } finally { await auto.cleanup(); }
});

const COSTLY: CostTracker = {
  onProviderStreamEvent: () => undefined,
  takeCost: () => ({ costUsd: 0.6, estimated: false, source: "openrouter" }),
  pendingCount: () => 0,
};

test("pauses at the spend ceiling: declining ends the run, allowing continues it", { timeout: 60_000 }, async () => {
  const stop = await harness({ agent: { spendCeilingUsd: 1 }, tracker: COSTLY });
  try {
    stop.faux.setResponses([toolUse(call("list_versions", {}, "l1")), toolUse(call("list_versions", {}, "l2")), say("never")]);
    const done = stop.runEnd();
    stop.engine.submit("keep going");
    const request = await stop.next("approval_request");
    assert.equal(request.type === "approval_request" ? request.kind : "", "budget");
    if (request.type === "approval_request") stop.engine.resolveApproval(request.id, "deny");
    assert.equal((await done).reason, "budget");
  } finally { await stop.cleanup(); }
  const go = await harness({ agent: { spendCeilingUsd: 1 }, tracker: COSTLY });
  try {
    go.faux.setResponses([toolUse(call("list_versions", {}, "l1")), toolUse(call("list_versions", {}, "l2")), say("finished")]);
    const done = go.runEnd();
    go.engine.submit("keep going");
    const request = await go.next("approval_request");
    if (request.type === "approval_request") go.engine.resolveApproval(request.id, "once");
    const end = await done;
    assert.deepEqual([end.reason, end.message], ["done", "finished"]);
  } finally { await go.cleanup(); }
});

test("records each model turn in the project's cost ledger", { timeout: 60_000 }, async () => {
  const h = await harness({ tracker: COSTLY });
  try {
    h.faux.setResponses([say("hi")]);
    await h.ask("hello");
    const usage = h.project.state.usage;
    assert.equal(usage.lunaUsd, 0.6);
    assert.equal((await h.project.store.usageEntries())[0]?.kind, "agent");
  } finally { await h.cleanup(); }
});

// The system prompt and tool declarations are about 3.7k tokens, so a 9k window compacts at roughly 5.4k.
test("compacts before a run when the saved conversation is too large, then answers", { timeout: 60_000 }, async () => {
  const h = await harness({ contextWindow: 9_000, keepRecentTokens: 300 });
  try {
    for (let turn = 0; turn < 24; turn += 1) {
      await h.session.appendMessage({ role: "user", content: `earlier request ${turn} ${"x".repeat(600)}`, timestamp: 100 + turn });
    }
    const engine = await Engine.create(h.engineOptions);
    const events: EngineEvent[] = [];
    engine.on((event) => events.push(event));
    const seen: string[][] = [];
    h.faux.setResponses([say("## Goal\nearlier work\n\n## Visual findings\n(none)"), reply(say("ok"), seen)]);
    const done = new Promise<RunEnd>((resolve) => { const off = engine.on((event) => { if (event.type === "run_end") { off(); resolve(event); } }); });
    engine.submit("continue");
    assert.equal((await done).message, "ok");
    assert.deepEqual(events.filter((event) => event.type === "compaction").map((event) => event.type === "compaction" ? event.phase : ""), ["start", "end"]);
    assert.ok((seen[0] ?? []).some((line) => line.includes("<summary>") && line.includes("earlier work")));
    assert.ok(JSON.stringify((await h.session.load())[0]).includes("earlier work"), "the saved session starts from the summary");
  } finally { await h.cleanup(); }
});

test("compacts in the middle of a run and keeps going on the compacted transcript", { timeout: 60_000 }, async () => {
  const h = await harness({ contextWindow: 9_000, keepRecentTokens: 300 });
  try {
    for (let turn = 0; turn < 6; turn += 1) {
      await h.session.appendMessage({ role: "user", content: `older request ${turn} ${"x".repeat(600)}`, timestamp: 100 + turn });
    }
    await h.project.state.workspace.writeText("big.txt", "y".repeat(3_000));
    const engine = await Engine.create(h.engineOptions);
    const events: EngineEvent[] = [];
    engine.on((event) => events.push(event));
    const ask = (text: string) => new Promise<RunEnd>((resolve) => {
      const off = engine.on((event) => { if (event.type === "run_end") { off(); resolve(event); } });
      engine.submit(text);
    });
    const seen: string[][] = [];
    h.faux.setResponses([
      toolUse(call("read_workspace_file", { path: "big.txt" }, "r1")),
      say("## Goal\nread the file\n\n## Visual findings\n(none)"),
      reply(say("final"), seen),
      reply(say("second run"), seen),
    ]);
    assert.equal((await ask("read big.txt")).message, "final");
    assert.deepEqual(events.filter((event) => event.type === "compaction").map((event) => event.type === "compaction" ? event.phase : ""), ["start", "end"]);
    const request = seen[0] ?? [];
    assert.ok(request.some((line) => line.includes("<summary>") && line.includes("read the file")));
    assert.ok(request.some((line) => line.startsWith("toolResult:")), "the newest tool result is kept");
    assert.ok(!request.some((line) => line.includes("older request 0")), "older messages were summarized away");
    assert.equal((await ask("again")).message, "second run");
    assert.ok((seen[1] ?? []).some((line) => line.includes("<summary>")), "the next run continues from the compacted transcript");
    assert.ok(JSON.stringify((await h.session.load())[0]).includes("read the file"));
  } finally { await h.cleanup(); }
});

test("a new engine resumes from the saved session", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    h.faux.setResponses([say("Hello there")]);
    await h.ask("hi");
    const resumed = await Engine.create(h.engineOptions);
    const seen: string[][] = [];
    h.faux.setResponses([reply(say("welcome back"), seen)]);
    const done = new Promise<RunEnd>((resolve) => { const off = resumed.on((event) => { if (event.type === "run_end") { off(); resolve(event); } }); });
    resumed.submit("do you remember?");
    await done;
    const request = seen[0] ?? [];
    assert.ok(request.includes("user:hi") && request.includes("assistant:Hello there"));
  } finally { await h.cleanup(); }
});

test("seeds a project that has chat history but no agent session yet", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const seen: string[][] = [];
    const engine = await Engine.create({ ...h.engineOptions, chatSeed: [
      { role: "user", content: "make it black and white", at: "t" },
      { role: "assistant", content: "Done, v0003.", at: "t" },
    ] });
    h.faux.setResponses([reply(say("ok"), seen)]);
    const done = new Promise<RunEnd>((resolve) => { const off = engine.on((event) => { if (event.type === "run_end") { off(); resolve(event); } }); });
    engine.submit("and now crop it");
    await done;
    assert.ok((seen[0] ?? []).some((line) => line.includes("<previous_conversation>") && line.includes("make it black and white")));
  } finally { await h.cleanup(); }
});

test("reports a provider error without saving it as an answer", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    h.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" })]);
    const end = await h.ask("hi");
    assert.deepEqual([end.reason, end.message], ["error", ""]);
    const error = h.events.find((event) => event.type === "error");
    assert.equal(error && error.type === "error" ? error.message : "", "provider exploded");
  } finally { await h.cleanup(); }
});

test("stops a model that goes silent", { timeout: 60_000 }, async () => {
  const h = await harness({ stallMs: 80 });
  try {
    const silent = (model: Model<never>, _context: TranscriptContext, options?: { signal?: AbortSignal }) => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener("abort", () => {
        const message = fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" });
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end(message);
      }, { once: true });
      void model;
      return stream;
    };
    const engine = await Engine.create({ ...h.engineOptions, streamFn: silent as never, stallMs: 80 });
    const events: EngineEvent[] = [];
    engine.on((event) => events.push(event));
    const done = new Promise<RunEnd>((resolve) => { const off = engine.on((event) => { if (event.type === "run_end") { off(); resolve(event); } }); });
    engine.submit("hello?");
    const end = await done;
    assert.equal(end.reason, "error");
    assert.ok(events.some((event) => event.type === "error" && /stopped responding/.test(event.message)));
  } finally { await h.cleanup(); }
});

test("caps a huge tool result before it reaches the model", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    await h.project.state.workspace.writeText("huge.txt", "z".repeat(200_000));
    h.faux.setResponses([toolUse(call("read_workspace_file", { path: "huge.txt" }, "r1")), say("read it")]);
    await h.ask("read huge.txt");
    const result = (await h.session.load()).find((message) => message.role === "toolResult") as { content: Array<{ text?: string }> } | undefined;
    const text = result?.content[0]?.text ?? "";
    assert.ok(text.length < 51_000, `tool text was ${text.length} characters`);
    assert.match(text, /more characters truncated/);
  } finally { await h.cleanup(); }
});

test("an invalid tool call becomes an error result and the run carries on", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const seen: string[][] = [];
    h.faux.setResponses([toolUse(call("remove_ranges", { ranges: "not a list" }, "bad1")), reply(say("sorry, retrying"), seen)]);
    const end = await h.ask("remove something");
    assert.deepEqual([end.reason, end.message], ["done", "sorry, retrying"]);
    const finished = h.events.find((event) => event.type === "tool_end" && event.callId === "bad1");
    assert.equal(finished && finished.type === "tool_end" ? finished.ok : true, false);
    assert.equal(h.project.store.current.id, "v0000", "nothing was committed");
    assert.ok((seen[0] ?? []).some((line) => line.startsWith("toolResult:")));
  } finally { await h.cleanup(); }
});

test("two quick submissions make one run: the second steers the first", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const seen: string[][] = [];
    h.faux.setResponses([reply(say("one"), seen), reply(say("two"), seen)]);
    const done = h.runEnd();
    h.engine.submit("first");
    h.engine.submit("second");
    await done;
    assert.equal(h.events.filter((event) => event.type === "run_start").length, 1);
    assert.ok(h.events.some((event) => event.type === "steer_queued" && event.text === "second"));
    assert.ok(seen.some((request) => request.includes("user:first") || request.includes("user:second")));
    assert.ok(seen.some((request) => request.includes("user:second")), "the steering text must reach the model, never be dropped");
  } finally { await h.cleanup(); }
});

test("a failing summarizer is reported and the run still answers", { timeout: 60_000 }, async () => {
  const h = await harness({ contextWindow: 9_000, keepRecentTokens: 300 });
  try {
    for (let turn = 0; turn < 24; turn += 1) {
      await h.session.appendMessage({ role: "user", content: `earlier request ${turn} ${"x".repeat(600)}`, timestamp: 100 + turn });
    }
    const engine = await Engine.create(h.engineOptions);
    const events: EngineEvent[] = [];
    engine.on((event) => events.push(event));
    h.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "summarizer exploded" }), say("answered anyway")]);
    const done = new Promise<RunEnd>((resolve) => { const off = engine.on((event) => { if (event.type === "run_end") { off(); resolve(event); } }); });
    engine.submit("continue");
    const end = await done;
    assert.deepEqual([end.reason, end.message], ["done", "answered anyway"]);
    assert.ok(events.some((event) => event.type === "error" && /compaction failed/i.test(event.message)));
  } finally { await h.cleanup(); }
});

test("aborting while an approval is pending denies it and ends the run", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    h.faux.setResponses([toolUse(GENERATE)]);
    const done = h.runEnd();
    h.engine.submit("make a cat image");
    await h.next("approval_request");
    h.engine.abort();
    assert.equal((await done).reason, "aborted");
    assert.equal(h.engine.running, false);
  } finally { await h.cleanup(); }
});

test("hands back text typed as a run ended instead of dropping it, but not audit reminders", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const internals = h.engine as unknown as { agent: Agent; takeLeftoverSteering(): string[] };
    internals.agent.steer({ role: "user", content: "late message", timestamp: 1 });
    internals.agent.steer({ role: "user", content: AUDIT_NUDGE, timestamp: 2 });
    assert.deepEqual(internals.takeLeftoverSteering(), ["late message"]);
    assert.equal(internals.agent.hasQueuedMessages(), false);
  } finally { await h.cleanup(); }
});
