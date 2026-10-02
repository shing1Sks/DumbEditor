import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ShellState } from "../src/shell/state/shell-state.js";
import { ControlsView, StatusView } from "../src/shell/views/controls.js";
import { HeaderView } from "../src/shell/views/header.js";
import { AssetsSidebarView, ProjectSidebarView } from "../src/shell/views/sidebars.js";
import { plain, shorten, spaceBetween, styleMarkdown } from "../src/shell/views/style.js";
import { timelineBar, TimelineView, volumeBar } from "../src/shell/views/timeline.js";
import { MessageView } from "../src/shell/views/transcript.js";

const media = { path: "a.mp4", width: 1280, height: 720, duration: 20, fps: 30, hasAudio: true, formatName: "mp4" };

function stateWithProject(): ShellState {
  const state = new ShellState();
  state.setProject("Demo cut", "v0002", 5);
  state.setMedia(media);
  state.setAgentModel("glm");
  return state;
}

test("header: the name on the left; project, version and model on the right, or what is going on", () => {
  const state = stateWithProject();
  const header = new HeaderView(state);
  const idle = plain(header.render(70)[0] ?? "");
  assert.equal(idle.length, 70);
  assert.match(idle, /^ {2}◆ DumbEditor {2}› {2}Demo cut {2}v0002 +● ready {2}$/);
  state.setProject("Demo cut · 2026-10-03 00:46", "v0002", 5);
  assert.ok(!plain(header.render(70)[0] ?? "").includes("2026"), "the date added to a project name is left out");
  state.setProject("Demo cut", "v0002", 5);
  state.setLoader({ source: "glm", stage: "Rendering with FFmpeg" });
  assert.match(plain(header.render(100)[0] ?? ""), /^ {2}◆ DumbEditor {2}› {2}Demo cut {2}v0002 +⠋ glm · Rendering with FFmpeg · video updating {2}$/);
  state.tickSpinner();
  assert.match(plain(header.render(100)[0] ?? ""), /⠙ glm/, "the spinner moves on");
  state.setLoader({ source: "Sandbox", stage: "Running script" });
  assert.match(plain(header.render(100)[0] ?? ""), /SANDBOX · Running script/);
  state.setLoader(null);
  const before = state.spinner;
  state.tickSpinner();
  assert.equal(state.spinner, before, "nothing animates while nothing is working");
  assert.equal(visibleWidth(header.render(12)[0] ?? ""), 12, "a narrow header is cut, never wider than the screen");
  assert.match(plain(new HeaderView(new ShellState()).render(40)[0] ?? ""), /No video/);
});

test("play bar marks the playhead, the played part and the in and out points", () => {
  const bar = plain(timelineBar(10, 20, { in: 5, out: 15 }, 56));
  assert.equal(bar.length, 56);
  assert.equal([...bar].filter((character) => character === "◆").length, 1);
  assert.ok(bar.includes("▌") && bar.includes("▐"));
  assert.equal(bar.indexOf("◆"), Math.round(0.5 * 55));
  assert.ok(bar.startsWith("━") && bar.endsWith("─"), "played part, then what is left");
  assert.equal(plain(timelineBar(0, 0, { in: null, out: null }, 30)).indexOf("◆"), 0, "an empty video does not divide by zero");
  assert.equal(plain(volumeBar(70)), "♪ ▮▮▮▮▮▮▮▯▯▯ 70%");
});

test("transport row: play state, time, bar, length and volume, in the video's columns", () => {
  const state = stateWithProject();
  const row = new TimelineView(state, () => ({ leftPad: 0, videoColumns: 100 }));
  const paused = plain(row.render(100)[0] ?? "");
  assert.equal(paused.length, 100);
  assert.match(paused, /^ ‖ 00:00\.0 [━─◆▌▐]+ 00:20\.0 {2}♪ ▮▮▮▮▮▮▮▯▯▯ 70%/);
  state.setPlaying(true);
  assert.match(plain(row.render(100)[0] ?? ""), /^ ▶ /);
  assert.ok(!plain(new TimelineView(state, () => ({ leftPad: 0, videoColumns: 50 })).render(50)[0] ?? "").includes("♪"), "no volume on a narrow video");
  assert.equal(plain(new TimelineView(new ShellState(), () => ({ leftPad: 0, videoColumns: 50 })).render(50)[0] ?? "").trim(), "");
});

test("controls row: the marked range on the left, the keys that matter on the right", () => {
  const state = stateWithProject();
  const controls = new ControlsView(state, () => "sixel");
  assert.match(plain(controls.render(130)[0] ?? ""), /^ +SIXEL · Ctrl\+P play · ←\/→ seek 5s · \+\/- volume · \[ \] marks · Ctrl\+G chat {2}$/);
  state.setPlayhead(8); state.setIn();
  assert.match(plain(controls.render(130)[0] ?? ""), /^ {2}in 00:08\.0 +SIXEL/);
  state.setPlayhead(15); state.setOut();
  assert.match(plain(controls.render(130)[0] ?? ""), /^ {2}in 00:08\.0 · out 00:15\.0 · 7\.0s selected/);
  const narrow = plain(controls.render(100)[0] ?? "");
  assert.equal(narrow.length, 100);
  assert.ok(!narrow.includes("SIXEL"));
});

test("status row: model, spend and permission mode, the latest note, and the keys that matter now", () => {
  const state = stateWithProject();
  const status = new StatusView(state);
  assert.match(plain(status.render(160)[0] ?? ""), /^ {2}● glm +\$0\.0000 +ask +Ready +Enter send · Ctrl\+C quit {2}$/);
  state.setAgentRunning(true);
  state.setLoader({ source: "glm", stage: "Thinking" });
  assert.match(plain(status.render(160)[0] ?? ""), /⠋ glm is working .* ask +Enter steers · Esc stops/);
  state.setAgentRunning(false);
  state.setLoader({ source: "Editor", stage: "Saving new version" });
  assert.match(plain(status.render(160)[0] ?? ""), /video updating · ↑\/↓ chat/);
  state.setLoader(null);
  state.setPermissionMode("auto");
  assert.match(plain(status.render(160)[0] ?? ""), / auto /);
});

test("project sidebar: a soft panel with padding, current version marked, extra versions counted", () => {
  const state = stateWithProject();
  state.setVersions(Array.from({ length: 12 }, (_, index) => ({ id: `v${String(11 - index).padStart(4, "0")}`, parentId: null, filePath: "x", action: `edit number ${index}`, request: "", createdAt: "", duration: 10 })) as never, "v0009");
  const sidebar = new ProjectSidebarView(state, () => 20);
  const raw = sidebar.render(26);
  const lines = raw.map(plain);
  assert.equal(lines.length, 20);
  assert.ok(lines.every((line) => visibleWidth(line) === 26), "every row is exactly the sidebar width");
  assert.equal(lines[0]?.trim(), "", "a blank row of padding above");
  assert.match(lines[1] ?? "", /^ {2}PROJECT {2}/, "two columns of padding on the left");
  assert.ok(raw.every((line) => /\x1b\[48;/.test(line)), "every row sits on the panel's background");
  assert.ok(raw.some((line) => /\x1b\[49m\x1b\[48;/.test(line)), "the background comes back after the permission chip's own");
  const text = lines.join("\n");
  assert.match(text, /PROJECT[\s\S]*Demo cut[\s\S]*glm[\s\S]*ask +\$0\.0000[\s\S]*VERSIONS/);
  assert.match(text, /● v0009/);
  assert.match(text, /○ v0011/);
  assert.match(text, /\+\d+ more/);
  assert.match(text, /limit 5 · \/version/);
});

test("assets sidebar: newest first with costs, or a hint when empty", () => {
  const state = stateWithProject();
  const sidebar = new AssetsSidebarView(state, () => 12);
  const empty = sidebar.render(30).map(plain);
  assert.ok(empty.every((line) => visibleWidth(line) === 30), "every row is exactly the sidebar width");
  assert.match(empty.join("\n"), /ASSETS[\s\S]*None yet/);
  state.setAssets([
    { id: "a1", kind: "image", description: "A blue title card", path: "p", source: "generated", costUsd: 0.04 },
    { id: "a2", kind: "music", description: "Calm piano", path: "q", source: "catalog" },
  ] as never);
  const text = sidebar.render(40).map(plain).join("\n");
  assert.ok(text.indexOf("Calm piano") < text.indexOf("A blue title card"), "newest first");
  assert.match(text, /♪ Calm piano +—/);
  assert.match(text, /▧ A blue title card +\$0\.04/);
  assert.match(text, /Ctrl\+O browse/);
});

test("messages: a symbol in the gutter instead of a name, wrapped lines under the text, markdown styled", () => {
  const user = new MessageView({ id: "1", role: "user", text: "remove the first two seconds", live: false });
  assert.deepEqual(user.render(80).map(plain), ["  ❯ remove the first two seconds"], "two columns of margin");
  assert.deepEqual(new MessageView({ id: "1", role: "user", text: "next", live: false }, true).render(80).map(plain), ["", "  ❯ next"], "a blank row before your message");
  const agent = new MessageView({ id: "2", role: "assistant", text: "**Done.** I removed `0-2s`.\n- first item\n- second item", label: "glm", live: false });
  assert.deepEqual(agent.render(80).map(plain), ["  ◆ Done. I removed 0-2s.", "    • first item", "    • second item"]);
  const tool = (text: string) => new MessageView({ id: "3", role: "assistant", text, label: "tool", live: false }).render(80).map(plain);
  assert.deepEqual(tool("▸ Inspect 3 frame(s)"), ["    ▸ Inspect 3 frame(s)"]);
  assert.deepEqual(tool("✓ Looked at 3 frames"), ["    ✓ Looked at 3 frames"]);
  assert.deepEqual(tool("✗ Range is outside the video"), ["    ✗ Range is outside the video"]);
  assert.deepEqual(new MessageView({ id: "4", role: "assistant", text: "Opened demo", label: "editor", live: false }).render(80).map(plain), ["  · Opened demo"]);
  assert.deepEqual(new MessageView({ id: "5", role: "assistant", text: "boom", label: "error", live: false }).render(80).map(plain), ["  ✗ boom"]);
  const long = new MessageView({ id: "6", role: "assistant", text: "word ".repeat(30).trim(), label: "glm", live: false }).render(30).map(plain);
  assert.ok(long.length > 2 && long.every((line) => visibleWidth(line) <= 30 - 2), "the right margin is kept too");
  assert.ok(long[0]?.startsWith("  ◆ ") && long.slice(1).every((line) => line.startsWith("    ")));
});

test("markdown: bold, code, headings and bullets keep their text", () => {
  assert.equal(plain(styleMarkdown("**bold** and `code`")), "bold and code");
  assert.equal(plain(styleMarkdown("## A heading")), "A heading");
  assert.equal(plain(styleMarkdown("- item")), "• item");
  assert.equal(plain(styleMarkdown("2 * 3 * 4")), "2 * 3 * 4", "stray asterisks are left alone");
});

test("text helpers cut and join without exceeding the width", () => {
  assert.equal(shorten("  a   lot    of   space  ", 40), "a lot of space");
  assert.equal(shorten("abcdefghij", 5), "abcd…");
  assert.equal(spaceBetween("left", "right", 14), "left     right");
  assert.equal(visibleWidth(spaceBetween("a long left side", "right", 12)), 12);
});
