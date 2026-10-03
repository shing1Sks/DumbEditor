import assert from "node:assert/strict";
import test from "node:test";
import type { EngineEvent } from "../src/core/engine/events.js";
import { bindEngineEvents } from "../src/shell/state/engine-bridge.js";
import { ShellState } from "../src/shell/state/shell-state.js";
import { isVideoMutationStage } from "../src/shell/work-state.js";

class FakeEngine {
  private listeners = new Set<(event: EngineEvent) => void>();
  on(listener: (event: EngineEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(event: EngineEvent): void { for (const listener of this.listeners) listener(event); }
}

function setup() {
  const state = new ShellState();
  const engine = new FakeEngine();
  const saved: string[] = [];
  const off = bindEngineEvents(state, engine, { label: () => "glm", persistAnswer: (text) => saved.push(text) });
  return { state, engine, saved, off };
}
const texts = (state: ShellState) => state.messages.map((message) => `${message.label ?? message.role}:${message.text}`);

test("streams the answer into one live message and saves it once when the run ends", () => {
  const { state, engine, saved } = setup();
  engine.emit({ type: "run_start", runId: "r1" });
  assert.equal(state.agentRunning, true);
  engine.emit({ type: "text_delta", text: "Hello " });
  engine.emit({ type: "text_delta", text: "there" });
  assert.deepEqual(texts(state), ["glm:Hello there"]);
  assert.equal(state.messages[0]?.live, true);
  engine.emit({ type: "run_end", reason: "done", message: "Hello there" });
  assert.equal(state.messages[0]?.live, false);
  assert.deepEqual(texts(state), ["glm:Hello there"], "the final message is not shown twice");
  assert.deepEqual(saved, ["Hello there"]);
  assert.equal(state.agentRunning, false);
  assert.equal(state.loader, null);
});

test("shows tool calls in order, and ends the streamed text before a tool line", () => {
  const { state, engine } = setup();
  engine.emit({ type: "run_start", runId: "r1" });
  engine.emit({ type: "text_delta", text: "Let me look." });
  engine.emit({ type: "tool_start", callId: "c1", name: "inspect_video_frames", summary: "Inspect 3 frame(s)", risk: "read" });
  assert.equal(state.messages[0]?.live, false);
  assert.deepEqual(state.loader, { source: "glm", stage: "Inspect 3 frame(s)" });
  engine.emit({ type: "tool_end", callId: "c1", ok: true, summary: "Looked at 3 frames" });
  engine.emit({ type: "tool_start", callId: "c2", name: "remove_ranges", summary: "Remove 3s-4s", risk: "edit" });
  engine.emit({ type: "tool_end", callId: "c2", ok: false, summary: "Range is outside the video" });
  assert.deepEqual(texts(state), ["glm:Let me look.", "tool:▸ Inspect 3 frame(s)", "tool:✓ Looked at 3 frames", "tool:▸ Remove 3s-4s", "tool:✗ Range is outside the video"]);
});

test("an approval request opens the approval panel and the end of the run closes it", () => {
  const { state, engine } = setup();
  engine.emit({ type: "run_start", runId: "r1" });
  engine.emit({ type: "approval_request", id: "a1", kind: "action", name: "generate_asset", summary: "Generate an image", risk: "spend" });
  assert.equal(state.overlay, "approval");
  assert.equal(state.approval?.id, "a1");
  engine.emit({ type: "run_end", reason: "aborted", message: "" });
  assert.equal(state.overlay, null);
  assert.equal(state.approval, null);
  assert.equal(state.messages.at(-1)?.text, "Stopped.");
});

test("a choice request opens the choice panel", () => {
  const { state, engine } = setup();
  engine.emit({ type: "choice_request", id: "q1", question: "Which?", options: ["A", "B"], allowCustom: true });
  assert.equal(state.overlay, "choice");
  assert.deepEqual(state.choice, { id: "q1", question: "Which?", options: ["A", "B"], allowCustom: true });
});

test("queued text the agent never read goes back to the composer", () => {
  const { state, engine } = setup();
  engine.emit({ type: "steer_dropped", texts: ["make it red", "and shorter"] });
  assert.equal(state.takeComposerRestore(), "make it red and shorter");
  assert.equal(state.takeComposerRestore(), null, "only once");
  assert.match(state.messages.at(-1)?.text ?? "", /back in the input box/);
});

test("reports errors, the spend limit and a queued message", () => {
  const { state, engine } = setup();
  engine.emit({ type: "steer_queued", text: "hi" });
  assert.match(state.status, /Queued/);
  engine.emit({ type: "error", message: "provider exploded", retryable: true });
  assert.deepEqual(texts(state).at(-1), "error:provider exploded");
  engine.emit({ type: "run_end", reason: "budget", message: "" });
  assert.match(state.messages.at(-1)?.text ?? "", /spend limit/);
});

test("stops listening to the engine when unbound", () => {
  const { state, engine, off } = setup();
  off();
  engine.emit({ type: "run_start", runId: "r1" });
  assert.equal(state.agentRunning, false);
});

test("opening a panel pauses playback and leaves chat focus; closing returns to the editor", () => {
  const state = new ShellState();
  state.setMedia({ path: "a.mp4", width: 1280, height: 720, duration: 20, fps: 30, hasAudio: true, formatName: "mp4" });
  state.setPlaying(true);
  state.setChatExpanded(true);
  state.openOverlay("help");
  assert.deepEqual([state.overlay, state.playing, state.chatExpanded], ["help", false, false]);
  state.closeOverlay();
  assert.equal(state.overlay, null);
});

test("moves the playhead within the video and marks in and out at the playhead", () => {
  const state = new ShellState();
  state.setMedia({ path: "a.mp4", width: 1280, height: 720, duration: 20, fps: 30, hasAudio: true, formatName: "mp4" });
  state.movePlayhead(-5);
  assert.equal(state.playhead, 0);
  state.movePlayhead(8);
  state.setIn();
  state.movePlayhead(100);
  state.setOut();
  assert.deepEqual([state.playhead, state.selection], [20, { in: 8, out: 20 }]);
});

test("notifies subscribers of changes until they unsubscribe", () => {
  const state = new ShellState();
  let calls = 0;
  const off = state.subscribe(() => { calls += 1; });
  state.setStatus("one");
  off();
  state.setStatus("two");
  assert.equal(calls, 1);
});

test("locks preview controls only while a rendered version is changing", () => {
  assert.equal(isVideoMutationStage("planning the edit"), false);
  assert.equal(isVideoMutationStage("reviewing tool results"), false);
  assert.equal(isVideoMutationStage("Generating music with a model"), false);
  assert.equal(isVideoMutationStage("Rendering with FFmpeg"), true);
  assert.equal(isVideoMutationStage("Checking custom render"), true);
  assert.equal(isVideoMutationStage("Saving new version"), true);
  const state = new ShellState();
  state.setLoader({ source: "Editor", stage: "Saving new version" });
  assert.deepEqual([state.busy, state.videoMutationActive], [true, true]);
  state.setAgentRunning(true);
  assert.equal(state.busy, false, "an agent run never blocks typing");
});
