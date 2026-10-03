import assert from "node:assert/strict";
import test from "node:test";
import { previewRenderSize, rgbToAnsi, rgbToSixel } from "../src/core/media.js";
import { LayeredTerminal, type VideoLayer } from "../src/shell/preview/layered-terminal.js";
import { cellSize } from "../src/shell/preview/painters/cell-size.js";
import { explainBackend, painterFor } from "../src/shell/preview/painters/index.js";
import type { MediaInfo } from "../src/types.js";
import { FakeTerminal } from "./helpers/fake-terminal.js";

const media: MediaInfo = { path: "x.mp4", duration: 10, width: 1920, height: 1080, fps: 24, hasAudio: true, formatName: "mp4" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("cellSize defaults to 10x20 and reads the override, ignoring bad values", () => {
  assert.deepEqual(cellSize({}), { width: 10, height: 20 });
  assert.deepEqual(cellSize({ DUMBEDITOR_CELL_WIDTH: "8", DUMBEDITOR_CELL_HEIGHT: "16" }), { width: 8, height: 16 });
  assert.deepEqual(cellSize({ DUMBEDITOR_CELL_WIDTH: "-3", DUMBEDITOR_CELL_HEIGHT: "x" }), { width: 10, height: 20 });
});

test("the Sixel painter wraps the existing encoder, size rule and rates", () => {
  const painter = painterFor("sixel");
  assert.equal(painter.id, "sixel");
  assert.equal(painter.fps, 12);
  assert.deepEqual(painter.renderSize(media, 60, 10), previewRenderSize(media, 60, 10, "sixel"));
  const rgb = Buffer.alloc(16 * 12 * 3, 128);
  assert.equal(painter.encode(rgb, { width: 16, height: 12 }), rgbToSixel(rgb, 16, 12));
  assert.deepEqual(painter.cells({ width: 400, height: 200 }), { columns: 40, rows: 10 });
  assert.equal(painter.idealRows(80, 16 / 9), Math.ceil(((80 - 2) * 10) / (16 / 9) / 20));
  assert.equal(painter.remove(), "", "text overwrites a Sixel picture, so nothing needs removing");
});

test("the blocks painter wraps the existing encoder, size rule and rates", () => {
  const painter = painterFor("blocks");
  assert.equal(painter.id, "blocks");
  assert.equal(painter.fps, 10);
  assert.deepEqual(painter.renderSize(media, 60, 10), previewRenderSize(media, 60, 10, "blocks"));
  const rgb = Buffer.alloc(8 * 6 * 3, 200);
  assert.equal(painter.encode(rgb, { width: 8, height: 6 }), rgbToAnsi(rgb, 8, 6));
  assert.deepEqual(painter.cells({ width: 3, height: 6 }), { columns: 3, rows: 3 });
  assert.equal(painter.idealRows(80, 2), Math.ceil((80 - 2) / 2 / 2));
  assert.equal(painter.remove(), "");
});

test("explainBackend says why a painter was chosen", () => {
  assert.match(explainBackend({ DUMBEDITOR_PREVIEW: "blocks" }), /DUMBEDITOR_PREVIEW/);
  assert.match(explainBackend({ WT_SESSION: "x" }), /Windows Terminal/);
  assert.match(explainBackend({ TERM: "xterm-sixel" }), /Sixel/);
  assert.match(explainBackend({}), /no Sixel/i);
});

function layered(remove: (() => string) | undefined) {
  const inner = new FakeTerminal(80, 24);
  const state: { layer: VideoLayer | null } = { layer: { rect: { x: 0, y: 1, w: 80, h: 10 }, revision: 1, output: "<IMG>" } };
  const terminal = new LayeredTerminal(inner, { layer: () => state.layer, bandText: () => "", ...(remove ? { remove } : {}) });
  return { inner, state, terminal };
}

test("when the layer goes away the picture is removed once, inside the same synchronized update", async () => {
  let removed = 0;
  const { inner, state, terminal } = layered(() => { removed += 1; return "<DEL>"; });
  terminal.write("a");
  await tick();
  assert.ok(inner.writes.join("").includes("<IMG>"));
  state.layer = null;
  const mark = inner.mark();
  terminal.write("\u001B[?2026hb\u001B[?2026l");
  await tick();
  assert.equal(inner.since(mark), "\u001B[?2026hb<DEL>\u001B[?2026l");
  terminal.write("c");
  await tick();
  assert.equal(removed, 1, "not removed again while nothing is drawn");
});

test("a painter that removes nothing leaves the bytes exactly as before", async () => {
  const { inner, state, terminal } = layered(() => "");
  terminal.write("a");
  await tick();
  state.layer = null;
  const mark = inner.mark();
  terminal.write("plain");
  await tick();
  assert.equal(inner.since(mark), "plain");
});

test("stopping removes a picture that is still on screen before giving the terminal back", async () => {
  const { inner, terminal } = layered(() => "<DEL>");
  terminal.write("a");
  await tick();
  const mark = inner.mark();
  terminal.write("leave");
  terminal.stop();
  assert.equal(inner.since(mark), "<DEL>leave");
});
