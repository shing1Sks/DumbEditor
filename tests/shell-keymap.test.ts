import assert from "node:assert/strict";
import test from "node:test";
import { resolveKey, type KeyContext } from "../src/shell/input/keymap.js";
import { isFocusReport, playbackStart } from "../src/shell/input/keys.js";

const idle: KeyContext = { overlayOpen: false, composerEmpty: true, agentRunning: false, busy: false, videoMutationActive: false, chatExpanded: false, hasMedia: true };
const ctx = (changes: Partial<KeyContext> = {}): KeyContext => ({ ...idle, ...changes });

const CTRL_C = "\x03", CTRL_G = "\x07", CTRL_O = "\x0f", CTRL_P = "\x10";
const ESC = "\x1b", UP = "\x1b[A", DOWN = "\x1b[B", RIGHT = "\x1b[C", LEFT = "\x1b[D", PAGE_UP = "\x1b[5~", PAGE_DOWN = "\x1b[6~";

test("Ctrl+C interrupts, even while a panel is open", () => {
  assert.deepEqual(resolveKey(CTRL_C, ctx()), { type: "interrupt" });
  assert.deepEqual(resolveKey(CTRL_C, ctx({ overlayOpen: true })), { type: "interrupt" });
});

test("focus reports from the terminal are swallowed, so [I and [O never reach the input", () => {
  assert.deepEqual(resolveKey("\x1b[I", ctx()), { type: "ignore" });
  assert.deepEqual(resolveKey("[I", ctx({ overlayOpen: true })), { type: "ignore" });
  assert.deepEqual(resolveKey("\x1b[O", ctx({ overlayOpen: true })), { type: "ignore" });
  assert.ok(isFocusReport("[I") && isFocusReport("\x1b[O") && !isFocusReport("i"));
});

test("an open panel gets every other key itself", () => {
  for (const key of [UP, "a", ESC, CTRL_P, CTRL_G, "["]) assert.equal(resolveKey(key, ctx({ overlayOpen: true })), null);
});

test("with an empty composer the arrows seek and scroll, and the single keys edit volume and marks", () => {
  assert.deepEqual(resolveKey(LEFT, ctx()), { type: "seek", seconds: -5 });
  assert.deepEqual(resolveKey(RIGHT, ctx()), { type: "seek", seconds: 5 });
  assert.deepEqual(resolveKey(UP, ctx()), { type: "scroll-chat", rows: 1 });
  assert.deepEqual(resolveKey(DOWN, ctx()), { type: "scroll-chat", rows: -1 });
  assert.deepEqual(resolveKey("+", ctx()), { type: "volume", delta: 5 });
  assert.deepEqual(resolveKey("=", ctx()), { type: "volume", delta: 5 });
  assert.deepEqual(resolveKey("-", ctx()), { type: "volume", delta: -5 });
  assert.deepEqual(resolveKey("[", ctx()), { type: "mark-in" });
  assert.deepEqual(resolveKey("]", ctx()), { type: "mark-out" });
});

test("once something is typed those same keys belong to the composer", () => {
  for (const key of [LEFT, RIGHT, UP, DOWN, "+", "-", "[", "]", "a"]) assert.equal(resolveKey(key, ctx({ composerEmpty: false })), null, JSON.stringify(key));
});

test("Ctrl+arrows seek even with text in the message box, but not behind a panel or while the video is being replaced", () => {
  const CTRL_LEFT = "[1;5D", CTRL_RIGHT = "[1;5C";
  for (const composerEmpty of [true, false]) {
    assert.deepEqual(resolveKey(CTRL_LEFT, ctx({ composerEmpty })), { type: "seek", seconds: -5 });
    assert.deepEqual(resolveKey(CTRL_RIGHT, ctx({ composerEmpty })), { type: "seek", seconds: 5 });
  }
  assert.deepEqual(resolveKey(CTRL_RIGHT, ctx({ busy: true })), { type: "seek", seconds: 5 }, "an export is running");
  assert.deepEqual(resolveKey(CTRL_RIGHT, ctx({ busy: true, videoMutationActive: true })), { type: "ignore" });
  assert.equal(resolveKey(CTRL_RIGHT, ctx({ overlayOpen: true })), null, "a panel keeps its own keys");
});

test("Shift+Tab switches the permission mode, whatever is typed", () => {
  assert.deepEqual(resolveKey("[Z", ctx({ composerEmpty: false })), { type: "toggle-permissions" });
  assert.deepEqual(resolveKey("[Z", ctx({ agentRunning: true })), { type: "toggle-permissions" });
  assert.equal(resolveKey("[Z", ctx({ overlayOpen: true })), null);
});

test("Ctrl+P plays, Ctrl+O opens the assets, Ctrl+G expands the chat, whatever is typed", () => {
  assert.deepEqual(resolveKey(CTRL_P, ctx({ composerEmpty: false })), { type: "toggle-play" });
  assert.deepEqual(resolveKey(CTRL_O, ctx({ composerEmpty: false })), { type: "open-assets" });
  assert.deepEqual(resolveKey(CTRL_G, ctx({ composerEmpty: false })), { type: "toggle-chat-focus" });
});

test("Escape collapses the chat, then stops the agent, then clears the composer", () => {
  assert.deepEqual(resolveKey(ESC, ctx({ chatExpanded: true, agentRunning: true })), { type: "collapse-chat" });
  assert.deepEqual(resolveKey(ESC, ctx({ agentRunning: true })), { type: "abort-agent" });
  assert.deepEqual(resolveKey(ESC, ctx({ agentRunning: true, composerEmpty: false })), { type: "clear-composer" });
  assert.deepEqual(resolveKey(ESC, ctx({ composerEmpty: false })), { type: "clear-composer" });
  assert.equal(resolveKey(ESC, ctx()), null);
});

test("page keys scroll the chat by a page", () => {
  assert.deepEqual(resolveKey(PAGE_UP, ctx()), { type: "scroll-chat-page", direction: 1 });
  assert.deepEqual(resolveKey(PAGE_DOWN, ctx({ composerEmpty: false })), { type: "scroll-chat-page", direction: -1 });
});

test("while an export or render runs, typing is swallowed but seeking, volume and chat scrolling still work", () => {
  const busy = ctx({ busy: true, composerEmpty: false });
  assert.deepEqual(resolveKey("a", busy), { type: "ignore" });
  assert.deepEqual(resolveKey(UP, busy), { type: "scroll-chat", rows: 1 });
  assert.deepEqual(resolveKey(LEFT, busy), { type: "seek", seconds: -5 });
  assert.deepEqual(resolveKey("-", busy), { type: "volume", delta: -5 });
  const rendering = ctx({ busy: true, videoMutationActive: true });
  assert.deepEqual(resolveKey(LEFT, rendering), { type: "ignore" }, "no seeking while the video is being replaced");
  assert.deepEqual(resolveKey(CTRL_P, rendering), { type: "ignore" });
});

test("playback restarts from the beginning when it is at the end", () => {
  assert.equal(playbackStart(19.98, 20), 0);
  assert.equal(playbackStart(5, 20), 5);
});
