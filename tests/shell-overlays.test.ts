import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ApprovalDecision } from "../src/core/engine/events.js";
import type { ProjectSummary } from "../src/core/project.js";
import { AssetPanel } from "../src/shell/overlays/assets.js";
import { ApprovalPanel, approvalDecision, approvalOptions } from "../src/shell/overlays/approval.js";
import { ChoicePanel } from "../src/shell/overlays/choice.js";
import { HelpPanel } from "../src/shell/overlays/help.js";
import { HistoryPanel } from "../src/shell/overlays/history.js";
import { ProjectsPanel } from "../src/shell/overlays/projects.js";
import { ShellState, type ApprovalRequest } from "../src/shell/state/shell-state.js";
import { plain } from "../src/shell/views/style.js";

const ROWS = 16;
const WIDTH = 100;
let renders = 0;
const context = { bandRows: () => ROWS, requestRender: () => { renders += 1; } };
const KEY = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", esc: "\x1b", tab: "\t", ctrlO: "\x0f" };
const screen = (lines: string[]) => lines.map(plain).join("\n");
const assertFills = (lines: string[]) => {
  assert.equal(lines.length, ROWS, "as tall as the band");
  assert.ok(lines.every((line) => visibleWidth(line) === WIDTH), "every row exactly as wide as the band");
};

test("help lists the controls and the model, and Escape closes it", () => {
  let closed = 0;
  const panel = new HelpPanel(context, { model: () => "glm", close: () => { closed += 1; } });
  const lines = panel.render(WIDTH);
  assertFills(lines);
  assert.match(screen(lines), /DumbEditor controls[\s\S]*Ctrl\+P play[\s\S]*Ask glm normally/);
  panel.handleInput("x");
  panel.handleInput(KEY.esc);
  assert.equal(closed, 1);
});

test("history marks the current version and shows eight unless asked for all", () => {
  const state = new ShellState();
  state.setVersions(Array.from({ length: 12 }, (_, index) => ({ id: `v${String(11 - index).padStart(4, "0")}`, parentId: null, filePath: "f", action: `edit ${11 - index}`, request: "", createdAt: "", duration: 12 })) as never, "v0010");
  const some = screen(new HistoryPanel(context, { state, showAll: false, close: () => undefined }).render(WIDTH));
  assert.match(some, /○ v0011 {2}00:12\.0 {2}edit 11/);
  assert.match(some, /● v0010/);
  assert.ok(!some.includes("v0003"), "only eight rows");
  const all = screen(new HistoryPanel(context, { state, showAll: true, close: () => undefined }).render(WIDTH));
  assert.ok(all.includes("v0000"));
});

test("projects: opens on the active project, moves, opens the chosen one, and closes", () => {
  const project = (name: string, dir: string): ProjectSummary => ({ name, sourcePath: `C:/videos/${name}.mp4`, projectDir: dir, createdAt: "", updatedAt: "", currentVersionId: "v0003", versionCount: 3 });
  const projects = [project("alpha", "C:/p/a"), project("beta", "C:/p/b"), project("gamma", "C:/p/c")];
  const opened: string[] = [];
  let closed = 0;
  const panel = new ProjectsPanel(context, { projects, activeProjectDir: "c:/P/B", open: (item) => opened.push(item.name), close: () => { closed += 1; } });
  const lines = panel.render(WIDTH);
  assertFills(lines);
  assert.match(screen(lines), /○ alpha {2}alpha\.mp4 · 3 versions · v0003/);
  assert.match(screen(lines), /› ● beta/, "the active project is selected and marked");
  panel.handleInput(KEY.down);
  panel.handleInput(KEY.enter);
  panel.handleInput(KEY.down);
  panel.handleInput(KEY.right);
  assert.deepEqual(opened, ["gamma", "alpha"], "selection wraps");
  panel.handleInput(KEY.esc);
  assert.equal(closed, 1);
  assert.match(screen(new ProjectsPanel(context, { projects: [], activeProjectDir: undefined, open: () => undefined, close: () => undefined }).render(WIDTH)), /No saved projects found/);
});

const approval = (changes: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ type: "approval_request", id: "a1", kind: "action", name: "generate_asset", summary: "Generate an image: a cat", risk: "spend", args: { kind: "image" }, ...changes });

test("approval: asks with Deny preselected, and Enter, arrows and Escape decide", () => {
  const decisions: ApprovalDecision[] = [];
  const panel = new ApprovalPanel(context, { request: approval(), decide: (decision) => decisions.push(decision) });
  const lines = panel.render(WIDTH);
  assertFills(lines);
  assert.match(screen(lines), /Permission required[\s\S]*Generate an image: a cat[\s\S]*can spend money[\s\S]*Arguments: \{"kind":"image"\}[\s\S]*Allow once +Allow this session +Deny/);
  panel.handleInput(KEY.enter);
  panel.handleInput(KEY.right);
  panel.handleInput(KEY.enter);
  panel.handleInput(KEY.left);
  panel.handleInput(KEY.left);
  panel.handleInput(KEY.enter);
  panel.handleInput(KEY.esc);
  assert.deepEqual(decisions, ["deny", "once", "session", "deny"]);
});

test("approval at the spend limit offers Continue and Stop", () => {
  const request = approval({ kind: "budget", risk: "budget", summary: "This run has spent $5.01" });
  assert.deepEqual(approvalOptions(request), ["Continue", "Stop"]);
  assert.deepEqual([approvalDecision(request, 0), approvalDecision(request, 1)], ["once", "deny"]);
  assert.deepEqual(approvalOptions(approval()), ["Allow once", "Allow this session", "Deny"]);
  const decisions: ApprovalDecision[] = [];
  const panel = new ApprovalPanel(context, { request, decide: (decision) => decisions.push(decision) });
  assert.match(screen(panel.render(WIDTH)), /Spend limit reached/);
  panel.handleInput(KEY.tab);
  panel.handleInput(KEY.enter);
  assert.deepEqual(decisions, ["once"]);
});

test("choice: pick an option, type a custom answer, or cancel", () => {
  const answers: Array<string | null> = [];
  const request = { id: "q1", question: "Which style?", options: ["Calm", "Bold"], allowCustom: true };
  const panel = new ChoicePanel(context, { request, answer: (answer) => answers.push(answer) });
  assertFills(panel.render(WIDTH));
  assert.match(screen(panel.render(WIDTH)), /Which style\?[\s\S]*› Calm[\s\S]*Bold[\s\S]*Custom answer/);
  panel.handleInput(KEY.down);
  panel.handleInput(KEY.enter);
  for (const character of "retro") panel.handleInput(character);
  panel.handleInput(KEY.enter);
  const second = new ChoicePanel(context, { request, answer: (answer) => answers.push(answer) });
  second.handleInput(KEY.tab);
  for (const character of "fast") second.handleInput(character);
  second.handleInput(KEY.enter);
  second.handleInput(KEY.esc);
  assert.deepEqual(answers, ["Bold", "retro", "fast", null]);
});

test("choice without a custom answer ignores typing", () => {
  const answers: Array<string | null> = [];
  const panel = new ChoicePanel(context, { request: { id: "q", question: "Pick", options: ["A", "B"], allowCustom: false }, answer: (answer) => answers.push(answer) });
  panel.handleInput("z");
  panel.handleInput(KEY.tab);
  panel.handleInput(KEY.enter);
  assert.deepEqual(answers, ["A"]);
  assert.ok(!screen(panel.render(WIDTH)).includes("Custom answer"));
});

test("assets: lists newest selected, previews an image, plays sound, and hands typing back to the chat", async () => {
  const assets = [
    { id: "a1", kind: "image", description: "A blue title card", path: "C:/w/title.png", source: "generated", model: "flux", costUsd: 0.04, createdAt: "" },
    { id: "a2", kind: "music", description: "Calm piano", path: "C:/w/piano.mp3", source: "catalog", license: "CC BY 4.0", createdAt: "" },
  ] as const;
  const calls = { played: [] as string[], stopped: 0, typed: [] as string[], closed: 0 };
  let playing = false;
  const panel = new AssetPanel(context, {
    assets: () => assets as never, playing: () => playing, togglePlay: (asset) => { calls.played.push(asset.id); playing = !playing; },
    stopPlay: () => { calls.stopped += 1; playing = false; }, typeText: (text) => calls.typed.push(text), close: () => { calls.closed += 1; },
    loadFrame: async () => "▀▀▀▀\n▀▀▀▀",
  });
  let text = screen(panel.render(WIDTH));
  assertFills(panel.render(WIDTH));
  assert.match(text, /› ♪ Calm piano · cost unavailable/, "the newest asset is selected");
  assert.match(text, /License: CC BY 4\.0[\s\S]*Space plays this asset/);
  panel.handleInput(" ");
  assert.match(screen(panel.render(WIDTH)), /▶ playing preview/);
  panel.handleInput(KEY.up);
  assert.equal(calls.stopped, 1, "moving stops the sound");
  text = screen(panel.render(WIDTH));
  assert.match(text, /▧ A blue title card[\s\S]*Model: flux[\s\S]*Cost: \$0\.04/);
  assert.match(text, /Loading preview/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(screen(panel.render(WIDTH)), /▀▀▀▀/, "the picture appears when it has loaded");
  panel.handleInput(" ");
  assert.deepEqual(calls.played, ["a2"], "Space does nothing on an image");
  panel.handleInput("h");
  assert.deepEqual([calls.typed, calls.closed], [["h"], 1]);
  panel.handleInput(KEY.ctrlO);
  assert.equal(calls.closed, 2);
  assert.match(screen(new AssetPanel(context, { assets: () => [], playing: () => false, togglePlay: () => undefined, stopPlay: () => undefined, typeText: () => undefined, close: () => undefined }).render(WIDTH)), /No project assets yet/);
  assert.ok(renders > 0, "panels ask the screen to redraw after a key");
});

test("a long question and a long approval summary are wrapped, not cut off", () => {
  const question = "Which part should I cut: the slow introduction where the host explains the plan, or the long outro with the credits and the thanks to everyone?";
  const choice = new ChoicePanel(context, { request: { id: "q", question, options: ["Intro", "Outro"], allowCustom: false }, answer: () => undefined });
  const asked = screen(choice.render(100));
  assert.match(asked, /thanks to everyone\?/, "the end of the question is visible");
  const summary = "Generate a 30 second video of a golden retriever running along a beach at sunset with waves, seagulls and soft music playing in the background";
  const approval = new ApprovalPanel(context, { request: approval_(summary), decide: () => undefined });
  assert.match(screen(approval.render(100)), /soft music playing in the background/, "the whole summary is visible before the user decides");
});

function approval_(summary: string): ApprovalRequest {
  return { type: "approval_request", id: "a", kind: "action", name: "generate_asset", summary, risk: "spend" };
}
