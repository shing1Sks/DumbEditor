import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { COMMANDS } from "../src/core/commands.js";
import { createShellScreen, type ShellScreen } from "../src/shell/screen.js";
import { ShellState } from "../src/shell/state/shell-state.js";
import { FakeTerminal, sixelPlacements, STUB_SIXEL } from "./helpers/fake-terminal.js";

const KEY = { ctrlC: "\x03", ctrlG: "\x07", ctrlO: "\x0f", ctrlP: "\x10", esc: "\x1b", left: "\x1b[D", right: "\x1b[C", enter: "\r" };
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

class StubPanel implements Component {
  keys: string[] = [];
  constructor(private readonly rows: () => number) {}
  render(width: number): string[] {
    return Array.from({ length: this.rows() }, (_, index) => (index === 1 ? "STUB PANEL".padEnd(width) : " ".repeat(width)));
  }
  handleInput(data: string): void { this.keys.push(data); }
  invalidate(): void { /* stateless */ }
}

async function boot(columns = 120, rows = 40) {
  const fake = new FakeTerminal(columns, rows);
  const state = new ShellState();
  state.setProject("demo", "v0000");
  state.setMedia({ path: "demo.mp4", width: 1280, height: 720, duration: 20, fps: 30, hasAudio: true, formatName: "mp4" });
  state.setAgentModel("glm");
  const calls = { submitted: [] as string[], interrupt: 0, abort: 0, assets: 0 };
  const panels: StubPanel[] = [];
  const screen: ShellScreen = createShellScreen({
    terminal: fake, state, backend: "sixel", commands: COMMANDS, cwd: process.cwd(),
    hooks: {
      onSubmit: (text) => calls.submitted.push(text), onInterrupt: () => { calls.interrupt += 1; },
      onAbortAgent: () => { calls.abort += 1; }, onOpenAssets: () => { calls.assets += 1; },
    },
    overlays: (_kind, context) => { const panel = new StubPanel(context.bandRows); panels.push(panel); return panel; },
  });
  screen.start();
  screen.preview.setFrame({ encoded: STUB_SIXEL, size: { width: 400, height: 200 }, backend: "sixel" });
  await fake.settle();
  const band = () => fake.screen().slice(0, screen.layout().bandRows + 2);
  return { fake, state, screen, calls, panels, band };
}
const typeText = async (fake: FakeTerminal, text: string) => { for (const character of text) { fake.send(character); await new Promise((resolve) => setTimeout(resolve, 6)); } await fake.settle(); };

test("draws the header, the video band, the play bar, the hints, the chat area and the status row", async () => {
  const { fake, screen } = await boot();
  const rows = fake.screen();
  assert.match(rows[0] ?? "", /^ {2}◆ DumbEditor {2}› {2}demo {2}v0000 +● ready *$/);
  assert.equal((rows[1] ?? "").trim(), "", "a blank row under the header");
  const { bandRows } = screen.layout();
  assert.match(rows[bandRows + 2] ?? "", /‖ 00:00\.0 .*00:20\.0 {2}♪ ▮▮▮▮▮▮▮▯▯▯ 70%/, "transport row under the video");
  assert.match(rows[bandRows + 3] ?? "", /SIXEL · Ctrl\+P play/);
  assert.match(rows[39] ?? "", /^ {2}● glm +\$0\.0000 +ask +Ready/);
  assert.ok(rows.some((line) => line.includes("╭─ ask · glm")) && rows.some((line) => /│ ❯ +Describe an edit, or type \/ for commands/.test(line)), "the prompt box shows its title and a hint");
  assert.deepEqual(sixelPlacements(fake.writes.join("")).at(-1), [3, 41], "the picture is centred in the band, under the header");
  screen.stop();
});

test("a long pasted input grows the composer without moving the band or repainting the video", async () => {
  const { fake, screen, band } = await boot();
  const before = band();
  const mark = fake.mark();
  fake.send(paste("describe the video cd C:\\Users\\SHREYASH KUMAR SINGH\\Desktop ".repeat(12)));
  await fake.settle();
  assert.deepEqual(band(), before, "header, panels and video rows stay exactly where they were");
  assert.match(fake.screen()[39] ?? "", /● glm.*Ready/, "the status row stays last");
  const composerRows = fake.screen().filter((line) => /describe the video|C:\\Users|SINGH/.test(line)).length;
  assert.ok(composerRows >= 4, `composer grew to ${composerRows} rows`);
  const out = fake.since(mark);
  assert.equal(sixelPlacements(out).length, 0, "the video was not repainted");
  assert.ok(!out.includes("\x1b[2J"), "no full-screen clear");
  screen.stop();
});

test("typing never repaints the video", async () => {
  const { fake, screen } = await boot();
  const mark = fake.mark();
  await typeText(fake, "remove the last two seconds please");
  assert.equal(sixelPlacements(fake.since(mark)).length, 0);
  assert.match(fake.screen().join("\n"), /remove the last two seconds please/);
  screen.stop();
});

test("resizing keeps the layout consistent and puts the video at the new rectangle", async () => {
  const { fake, screen } = await boot();
  for (const [columns, rows] of [[80, 24], [160, 50], [100, 30], [120, 40]] as const) {
    const mark = fake.mark();
    fake.resize(columns, rows);
    await fake.settle();
    const screenRows = fake.screen();
    assert.match(screenRows[rows - 1] ?? "", /● glm.*Ready/, `${columns}x${rows}: status row`);
    assert.match(screenRows[0] ?? "", /^ {2}◆ DumbEditor/, `${columns}x${rows}: header row`);
    const rect = screen.videoRect();
    const image = Math.ceil(400 / 10);
    assert.deepEqual(sixelPlacements(fake.since(mark)).at(-1), [rect.y + 1, rect.x + Math.floor((rect.w - image) / 2) + 1], `${columns}x${rows}: video placement`);
    assert.ok(screenRows.every((line) => line.length <= columns), `${columns}x${rows}: no row wider than the screen`);
    if (columns >= 130) {
      assert.match(screenRows[3] ?? "", /^ {2}PROJECT/, "left sidebar");
      assert.match(screenRows[3] ?? "", /ASSETS *$/, "right sidebar");
    }
  }
  screen.stop();
});

test("streaming 200 messages into the chat leaves the band and the video alone and follows the end", async () => {
  const { fake, state, screen, band } = await boot();
  const before = band();
  const mark = fake.mark();
  for (let index = 1; index <= 200; index += 1) {
    state.addMessage("assistant", `line ${index} from the agent`, "glm");
    if (index % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await fake.settle();
  assert.deepEqual(band(), before);
  assert.ok(fake.screen().some((line) => line.includes("line 200 from the agent")), "the newest line is visible");
  assert.equal(sixelPlacements(fake.since(mark)).length, 0);
  screen.stop();
});

test("a panel replaces the band, takes the keys, hides the video, and returns it once when it closes", async () => {
  const { fake, state, screen, panels } = await boot();
  state.openOverlay("help");
  await fake.settle();
  assert.ok(fake.screen().some((line) => line.includes("STUB PANEL")), "panel shown in the band");
  const mark = fake.mark();
  screen.preview.setFrame({ encoded: STUB_SIXEL, size: { width: 400, height: 200 }, backend: "sixel" });
  fake.send("x");
  await fake.settle();
  assert.deepEqual(panels[0]?.keys, ["x"], "the panel gets the key");
  assert.equal(screen.composer.text, "", "and the composer does not");
  assert.equal(sixelPlacements(fake.since(mark)).length, 0, "no video over a panel");
  const closing = fake.mark();
  state.closeOverlay();
  await fake.settle();
  assert.ok(!fake.screen().some((line) => line.includes("STUB PANEL")));
  assert.equal(sixelPlacements(fake.since(closing)).length, 1, "the video comes back once");
  fake.send("y");
  await fake.settle();
  assert.equal(screen.composer.text, "y", "the composer has the keys again");
  screen.stop();
});

test("Ctrl+G gives the whole body to the chat and Escape brings the band back", async () => {
  const { fake, state, screen } = await boot();
  state.addMessage("user", "hello");
  fake.send(KEY.ctrlG);
  await fake.settle();
  assert.equal(state.chatExpanded, true);
  assert.match(fake.screen()[2] ?? "", /❯ hello/, "the chat starts right under the header");
  const mark = fake.mark();
  fake.send(KEY.esc);
  await fake.settle();
  assert.equal(state.chatExpanded, false);
  assert.match(fake.screen()[screen.layout().bandRows + 2] ?? "", /00:00/, "the play bar is back");
  assert.equal(sixelPlacements(fake.since(mark)).length, 1, "and so is the video");
  screen.stop();
});

test("while an export runs typing is blocked but the play keys still work", async () => {
  const { fake, state, screen } = await boot();
  state.setLoader({ source: "Editor", stage: "Preparing export" });
  await fake.settle();
  fake.send("a");
  fake.send(KEY.right);
  await fake.settle();
  assert.equal(screen.composer.text, "", "typing is blocked");
  assert.equal(state.playhead, 5, "seeking still works");
  state.setLoader(null);
  fake.send("b");
  await fake.settle();
  assert.equal(screen.composer.text, "b");
  screen.stop();
});

test("global keys: play, seek, marks, volume, assets, stop and interrupt", async () => {
  const { fake, state, screen, calls } = await boot();
  fake.send(KEY.ctrlP); await fake.settle();
  assert.equal(state.playing, true);
  fake.send(KEY.right); fake.send(KEY.right); fake.send("["); fake.send(KEY.right); fake.send("]"); fake.send("-"); await fake.settle();
  assert.deepEqual([state.playing, state.playhead, state.selection, state.volume], [false, 15, { in: 10, out: 15 }, 65]);
  fake.send(KEY.ctrlO); fake.send(KEY.ctrlC); await fake.settle();
  assert.deepEqual([calls.assets, calls.interrupt], [1, 1]);
  state.setAgentRunning(true);
  fake.send(KEY.esc); await fake.settle();
  assert.equal(calls.abort, 1);
  await typeText(fake, "later");
  fake.send(KEY.esc); await fake.settle();
  assert.equal(screen.composer.text, "", "Escape clears what was typed before it stops the agent");
  screen.stop();
});

test("Enter sends the typed line and empties the composer", async () => {
  const { fake, screen, calls } = await boot();
  await typeText(fake, "trim the intro");
  fake.send(KEY.enter);
  await fake.settle();
  assert.deepEqual(calls.submitted, ["trim the intro"]);
  assert.equal(screen.composer.text, "");
  screen.stop();
});

test("typing a slash lists the commands, and text the agent never read comes back to the composer", async () => {
  const { fake, state, screen } = await boot();
  fake.send("/");
  await fake.settle(200);
  assert.match(fake.screen().join("\n"), /clip-remove/, "slash commands are offered");
  fake.send(KEY.esc);
  screen.composer.clear();
  await fake.settle();
  state.restoreComposerText("make it red");
  await fake.settle();
  assert.equal(screen.composer.text, "make it red");
  screen.stop();
});

test("a very small terminal still draws every row within its width, and a regained window focus repaints the video", async () => {
  const { fake, screen } = await boot(50, 14);
  for (const [columns, rows] of [[50, 14], [40, 10], [30, 8], [200, 60]] as const) {
    fake.resize(columns, rows);
    await fake.settle();
    const screenRows = fake.screen();
    assert.equal(screenRows.length, rows);
    assert.match(screenRows[0] ?? "", /^ {2}◆ DumbEditor/, `${columns}x${rows}: header`);
    assert.ok(screenRows.every((line) => line.length <= columns), `${columns}x${rows}: no row wider than the screen`);
  }
  const mark = fake.mark();
  fake.send("[I");
  await fake.settle();
  assert.equal(sixelPlacements(fake.since(mark)).length, 1, "the picture is drawn again when the window regains focus");
  assert.equal(screen.composer.text, "", "and the focus report is not typed");
  screen.stop();
});

test("Ctrl+Backspace and Ctrl+Delete delete a word at a time, and Ctrl+U and Ctrl+K delete the rest of the row", async () => {
  const { fake, screen } = await boot();
  const previous = process.env.WT_SESSION;
  process.env.WT_SESSION = "test-session";
  try {
    await typeText(fake, "remove the quiet middle part");
    fake.send("\x08"); // Windows Terminal sends a backspace byte for Ctrl+Backspace
    await fake.settle();
    assert.equal(screen.composer.text, "remove the quiet middle ");
    fake.send("\x1b[127;5u"); // the same key, from terminals that report modifiers
    await fake.settle();
    assert.equal(screen.composer.text, "remove the quiet ");
    fake.send("\x01"); // Ctrl+A: start of the row
    fake.send("\x1b[3;5~"); // Ctrl+Delete
    await fake.settle();
    assert.equal(screen.composer.text, " the quiet ", "the word goes, its trailing space stays");
    fake.send("\x05"); // Ctrl+E: end of the row
    fake.send("\x15"); // Ctrl+U: everything before the cursor
    await fake.settle();
    assert.equal(screen.composer.text, "");
    await typeText(fake, "one two");
    fake.send("\x01");
    fake.send("\x0b"); // Ctrl+K: everything after the cursor
    await fake.settle();
    assert.equal(screen.composer.text, "");
  } finally {
    if (previous === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = previous;
    screen.stop();
  }
});
