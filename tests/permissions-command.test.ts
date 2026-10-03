import assert from "node:assert/strict";
import test from "node:test";
import { commandSuggestions } from "../src/core/commands.js";
import { runCommand, type CommandApp } from "../src/shell/commands.js";
import { ModePanel } from "../src/shell/overlays/mode.js";
import { ShellState } from "../src/shell/state/shell-state.js";
import { plain } from "../src/shell/views/style.js";

function fakeApp(mode: "ask" | "auto") {
  const said: string[] = [];
  let pickers = 0;
  const app = {
    state: new ShellState(), settings: { agent: { permissionMode: mode } },
    answer: async (text: string) => { said.push(text); },
    openModePicker: () => { pickers += 1; },
    setPermissionMode: async (next: "ask" | "auto") => { mode = next; },
  } as unknown as CommandApp;
  return { app, said, mode: () => mode, pickers: () => pickers };
}

test("/mode is listed, and on its own it opens the picker instead of asking to be typed out", async () => {
  assert.ok(commandSuggestions("/").some((item) => item.name === "/mode"));
  assert.ok(!commandSuggestions("/").some((item) => item.name === "/permissions"), "one name in the list");
  const t = fakeApp("auto");
  await runCommand(t.app, "/mode");
  assert.equal(t.pickers(), 1);
  assert.equal(t.mode(), "auto", "opening the list changes nothing");
});

test("/mode ask and /mode auto still work for scripts, the old /permissions name stays, anything else shows the usage", async () => {
  const t = fakeApp("auto");
  await runCommand(t.app, "/mode ask");
  assert.equal(t.mode(), "ask");
  await runCommand(t.app, "/permissions auto");
  assert.equal(t.mode(), "auto");
  await runCommand(t.app, "/permissions");
  assert.equal(t.pickers(), 1);
  await runCommand(t.app, "/mode maybe");
  assert.equal(t.mode(), "auto");
  assert.match(t.said.at(-1) ?? "", /Usage: \/mode/);
});

test("the mode picker opens on the current mode, moves with the arrows, applies on Enter and does nothing on Escape", () => {
  const UP = "\x1b[A", DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b";
  const context = { bandRows: () => 16, requestRender: () => undefined };
  const run = (current: "ask" | "auto", keys: string[]) => {
    const applied: string[] = [];
    let closed = 0;
    const panel = new ModePanel(context, { current, apply: (mode) => applied.push(mode), close: () => { closed += 1; } });
    const text = plain(panel.render(100).join("\n"));
    for (const key of keys) panel.handleInput(key);
    return { applied, closed, text };
  };
  const opened = run("auto", []);
  assert.match(opened.text, /Agent mode/);
  assert.match(opened.text, /› auto {2}\(now\)/, "the current mode is highlighted and marked");
  assert.match(opened.text, /\n.*\bask\b/);
  assert.deepEqual(run("auto", [UP, ENTER]).applied, ["ask"]);
  assert.deepEqual(run("ask", [DOWN, ENTER]).applied, ["auto"]);
  assert.deepEqual(run("ask", [DOWN, DOWN, ENTER]).applied, ["ask"], "the list wraps");
  assert.deepEqual(run("ask", [ENTER]).applied, ["ask"]);
  const cancelled = run("auto", [UP, ESC]);
  assert.deepEqual([cancelled.applied.length, cancelled.closed], [0, 1]);
  assert.equal(run("ask", [ENTER]).closed, 1, "Enter closes the panel");
});
