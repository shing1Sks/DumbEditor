// THROWAWAY SPIKE tests: drive pi-tui against an emulated terminal and check the layout stays put.
import assert from "node:assert/strict";
import test from "node:test";
import xtermPkg from "@xterm/headless";
const XTerm = xtermPkg.Terminal;
import { createApp, LEFT_W, RIGHT_W } from "./app.mjs";

const STUB_SIXEL = '\x1bPq"1;1;40;40#0;2;0;0;0#0!40~\x1b\\';

class FakeTerminal {
  constructor(cols, rows) {
    this.cols = cols; this.rowsCount = rows;
    this.term = new XTerm({ cols, rows, allowProposedApi: true });
    this.writes = []; this.pendingWrites = [];
  }
  get columns() { return this.cols; }
  get rows() { return this.rowsCount; }
  get kittyProtocolActive() { return false; }
  start(onInput, onResize) { this.onInput = onInput; this.onResize = onResize; }
  stop() {}
  async drainInput() {}
  write(data) { this.writes.push(data); this.pendingWrites.push(new Promise((done) => this.term.write(data, done))); }
  moveBy(n) { this.write(n > 0 ? `\x1b[${n}B` : n < 0 ? `\x1b[${-n}A` : ""); }
  hideCursor() { this.write("\x1b[?25l"); } showCursor() { this.write("\x1b[?25h"); }
  clearLine() { this.write("\x1b[2K"); } clearFromCursor() { this.write("\x1b[J"); } clearScreen() { this.write("\x1b[2J\x1b[H"); }
  setTitle() {} setProgress() {}
  send(data) { this.onInput(data); }
  resize(cols, rows) { this.cols = cols; this.rowsCount = rows; this.term.resize(cols, rows); this.onResize(); }
  async settle() { await new Promise((r) => setTimeout(r, 90)); await Promise.all(this.pendingWrites.splice(0)); }
  screen() { const b = this.term.buffer.active; return Array.from({ length: this.rowsCount }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) ?? ""); }
  mark() { return this.writes.length; }
  since(mark) { return this.writes.slice(mark).join(""); }
}

async function boot(cols = 120, rows = 40) {
  const fake = new FakeTerminal(cols, rows);
  const app = createApp({ terminal: fake, sixel: () => STUB_SIXEL });
  app.start();
  await fake.settle();
  return { fake, app };
}
const sixelPlacements = (output) => [...output.matchAll(/\x1b\[(\d+);(\d+)H(?:\x1b[78])?\x1bPq/g)].map((m) => [Number(m[1]), Number(m[2])]);
const band = (screen, app) => screen.slice(0, app.rect().h);

test("first frame: panels in place, one video layer at the video rectangle, status on the last row", async () => {
  const { fake, app } = await boot();
  const screen = fake.screen();
  assert.match(screen[1], /^ assets item 1/);
  assert.equal(screen[1].indexOf("versions item 1"), 120 - RIGHT_W + 1);
  assert.match(screen[39], /^status: ready/);
  const placements = sixelPlacements(fake.writes.join(""));
  assert.ok(placements.length >= 1 && placements.every(([r, c]) => r === 1 && c === LEFT_W + 1), `placements: ${JSON.stringify(placements)}`);
  assert.ok(app.layered.stats.layers <= 2, "startup settles within two paints");
  app.stop();
});

test("a long pasted input grows the editor without moving panels or repainting the video", async () => {
  const { fake, app } = await boot();
  const before = band(fake.screen(), app);
  const mark = fake.mark();
  fake.send(`\x1b[200~${"describe the video cd C:\\Users\\SHREYASH KUMAR SINGH\\Desktop ".repeat(12)}\x1b[201~`);
  await fake.settle();
  const after = fake.screen();
  assert.deepEqual(band(after, app), before, "panel/video band must not change");
  assert.match(after[39], /^status: ready/, "status stays on the last row");
  const editorRows = after.slice(app.rect().h + 1).filter((line) => /describe the video|C:\\Users|SINGH/.test(line)).length;
  assert.ok(editorRows >= 4, `editor should have grown to several rows, got ${editorRows}`);
  const out = fake.since(mark);
  assert.equal(sixelPlacements(out).length, 0, "no video repaint for editor-only changes");
  assert.ok(!out.includes("\x1b[2J"), "no full-screen clear");
  app.stop();
});

test("typing keystrokes never repaint the video", async () => {
  const { fake, app } = await boot();
  const mark = fake.mark();
  for (const ch of "hello world, trim the last two seconds") { fake.send(ch); await new Promise((r) => setTimeout(r, 8)); }
  await fake.settle();
  assert.equal(sixelPlacements(fake.since(mark)).length, 0);
  assert.ok(fake.since(mark).length < 20_000, `typing frames should be small, got ${fake.since(mark).length} bytes`);
  app.stop();
});

test("resizing keeps the layout consistent and re-places the video at the new rectangle", async () => {
  const { fake, app } = await boot();
  for (const [cols, rows] of [[80, 24], [160, 50], [100, 30], [120, 40]]) {
    const mark = fake.mark();
    fake.resize(cols, rows);
    await fake.settle();
    const screen = fake.screen();
    assert.match(screen[rows - 1], /^status: ready/, `${cols}x${rows}: status row`);
    assert.equal(screen[1].indexOf("versions item 1"), cols - RIGHT_W + 1, `${cols}x${rows}: right panel column`);
    const r = app.rect();
    assert.deepEqual(sixelPlacements(fake.since(mark)).at(-1), [r.y + 1, r.x + 1], `${cols}x${rows}: video placement`);
    assert.ok(screen.every((line) => line.length <= cols), `${cols}x${rows}: no overlong rows`);
  }
  app.stop();
});

test("streaming 200 lines into the chat leaves the panels and video alone", async () => {
  const { fake, app } = await boot();
  const before = band(fake.screen(), app);
  const mark = fake.mark();
  for (let i = 1; i <= 200; i += 1) { app.say(`line ${i} from the agent`); if (i % 20 === 0) await new Promise((r) => setTimeout(r, 20)); }
  await fake.settle();
  const after = fake.screen();
  assert.deepEqual(band(after, app), before);
  assert.ok(after.some((line) => line.includes("line 200 from the agent")), "chat follows the end");
  assert.equal(sixelPlacements(fake.since(mark)).length, 0);
  app.stop();
});

test("a new video frame repaints the video exactly once", async () => {
  const { fake, app } = await boot();
  const mark = fake.mark();
  app.newVideoFrame();
  await fake.settle();
  assert.equal(sixelPlacements(fake.since(mark)).length, 1);
  app.stop();
});

test("an approval popup over the video hides the video, and closing it brings the video back once", async () => {
  const { fake, app } = await boot();
  app.showPopup();
  await fake.settle();
  assert.ok(fake.screen().some((line) => line.includes("Allow generate_asset?")), "popup visible");
  const shown = fake.mark();
  app.newVideoFrame();
  await fake.settle();
  assert.equal(sixelPlacements(fake.since(shown)).length, 0, "no video drawn over the popup");
  const closing = fake.mark();
  app.hidePopup();
  await fake.settle();
  assert.ok(!fake.screen().some((line) => line.includes("Allow generate_asset?")), "popup gone");
  assert.equal(sixelPlacements(fake.since(closing)).length, 1, "video returns once");
  app.stop();
});
