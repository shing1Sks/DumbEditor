import assert from "node:assert/strict";
import test from "node:test";
import { LayeredTerminal, type VideoLayer } from "../src/shell/preview/layered-terminal.js";
import { compressionOn, kittyDelete, kittyKeepsImages, kittyTransmit, setKittyPersistent } from "../src/shell/preview/painters/kitty.js";
import { setMeasuredCell } from "../src/shell/preview/painters/cell-size.js";
import type { MediaInfo } from "../src/types.js";
import { painterFor } from "../src/shell/preview/painters/index.js";
import { buildVideoLayer } from "../src/shell/preview/video-layer.js";
import { decodeKitty } from "./helpers/kitty-decode.js";
import { FakeTerminal } from "./helpers/fake-terminal.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const gradient = (width: number, height: number): Buffer => {
  const buffer = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      buffer[index] = Math.floor((x * 255) / Math.max(1, width - 1));
      buffer[index + 1] = Math.floor((y * 255) / Math.max(1, height - 1));
      buffer[index + 2] = ((x + y) * 7) & 255;
    }
  }
  return buffer;
};

test("a frame is one transmit-and-display command that decodes back to the same pixels", () => {
  const rgb = gradient(40, 30);
  const [command, ...rest] = decodeKitty(kittyTransmit(rgb, { width: 40, height: 30 }, { id: 77, columns: 4, rows: 2, compress: false }));
  assert.equal(rest.length, 0, "one command");
  assert.ok(command);
  assert.deepEqual(command.keys, { a: "T", f: "24", s: "40", v: "30", i: "77", p: "1", c: "4", r: "2", C: "1", q: "2" });
  assert.ok(command.data.equals(rgb), "the same pixels");
});

test("a big frame is split into chunks of at most 4096 characters and still decodes", () => {
  const rgb = gradient(322, 180);
  const [command] = decodeKitty(kittyTransmit(rgb, { width: 322, height: 180 }, { id: 5, columns: 33, rows: 9, compress: false }));
  assert.ok(command);
  assert.ok(command.chunks > 40, `${command.chunks} chunks`);
  assert.ok(command.longestPayload <= 4096);
  assert.ok(command.data.equals(rgb));
});

test("only the first chunk carries the keys, and every chunk but the last says m=1", () => {
  const stream = kittyTransmit(gradient(100, 60), { width: 100, height: 60 }, { id: 9, columns: 10, rows: 3, compress: false });
  const chunks = [...stream.matchAll(/\u001B_G([^;]*);/g)].map((match) => match[1] ?? "");
  assert.ok(chunks.length > 2);
  assert.match(chunks[0] ?? "", /^a=T,.*m=1$/);
  for (const middle of chunks.slice(1, -1)) assert.equal(middle, "m=1");
  assert.equal(chunks.at(-1), "m=0");
});

test("compression sends zlib data that decodes to the same pixels, and is smaller for a flat picture", () => {
  const flat = Buffer.alloc(200 * 100 * 3, 90);
  const plain = kittyTransmit(flat, { width: 200, height: 100 }, { id: 1, columns: 20, rows: 5, compress: false });
  const packed = kittyTransmit(flat, { width: 200, height: 100 }, { id: 1, columns: 20, rows: 5, compress: true });
  const [command] = decodeKitty(packed);
  assert.equal(command?.keys.o, "z");
  assert.ok(command?.data.equals(flat));
  assert.ok(packed.length < plain.length / 10, `${packed.length} vs ${plain.length}`);
});

test("an incomplete frame is refused", () => {
  assert.throws(() => kittyTransmit(Buffer.alloc(10), { width: 40, height: 30 }, { id: 1, columns: 4, rows: 2, compress: false }), /incomplete/);
});

test("removal deletes the same image and frees its data", () => {
  const painter = painterFor("kitty");
  const [shown] = decodeKitty(painter.encode(gradient(20, 10), { width: 20, height: 10 }));
  const remove = painter.remove();
  assert.match(remove, /^\u001B_Ga=d,d=I,i=\d+,q=2\u001B\\$/);
  assert.equal(remove, kittyDelete(Number(shown?.keys.i)), "the id that was shown");
});

test("the Kitty painter is a pixel painter at 15 frames per second", () => {
  const painter = painterFor("kitty");
  assert.equal(painter.id, "kitty");
  assert.equal(painter.fps, 15);
  assert.equal(painterFor("sixel").persistent, false);
  assert.equal(painterFor("blocks").persistent, false);
  assert.deepEqual(painter.cells({ width: 400, height: 200 }), painterFor("sixel").cells({ width: 400, height: 200 }));
  assert.equal(painter.idealRows(80, 16 / 9), painterFor("sixel").idealRows(80, 16 / 9));
});

test("a picture persists only where that is known to hold: kitty itself, and nowhere by default", () => {
  assert.equal(painterFor("kitty").persistent, false, "the safe default: send it again when the text around it changes");
  setKittyPersistent(true);
  try { assert.equal(painterFor("kitty").persistent, true); } finally { setKittyPersistent(false); }
  assert.equal(kittyKeepsImages("kitty(0.35.2)", {}), true);
  assert.equal(kittyKeepsImages(null, { KITTY_WINDOW_ID: "3" }), true);
  for (const name of ["ghostty 1.0.1", "WezTerm 20240203", "iTerm2 3.6.2", "Konsole 24.02", null]) assert.equal(kittyKeepsImages(name, {}), false, String(name));
});

test("the picture is a whole number of cells, so it fills them exactly and cannot spill into the row below", () => {
  const media: MediaInfo = { path: "x.mp4", duration: 10, width: 1920, height: 1080, fps: 24, hasAudio: true, formatName: "mp4" };
  const painter = painterFor("kitty");
  for (const cell of [{ width: 10, height: 20 }, { width: 17, height: 34 }, { width: 9, height: 19 }, { width: 8, height: 16 }]) {
    setMeasuredCell(cell);
    try {
      for (const [columns, rows] of [[60, 10], [100, 11], [118, 17], [40, 24], [20, 6]] as const) {
        const size = painter.renderSize(media, columns, rows);
        assert.equal(size.width % cell.width, 0, `width is whole cells (${JSON.stringify(cell)} ${columns}x${rows})`);
        assert.equal(size.height % cell.height, 0, `height is whole cells (${JSON.stringify(cell)} ${columns}x${rows})`);
        const covered = painter.cells(size);
        assert.equal(covered.columns * cell.width, size.width, "the columns cover the width exactly");
        assert.equal(covered.rows * cell.height, size.height, "the rows cover the height exactly");
        assert.ok(covered.rows <= rows, `never taller than the band (${covered.rows} of ${rows})`);
        assert.ok(covered.columns <= columns, "and inside the columns it was given");
      }
    } finally { setMeasuredCell(null); }
  }
  assert.deepEqual(painter.renderSize(media, 1, 1), { width: 0, height: 0 }, "no room means no picture");
});

test("every frame names its cells exactly: c and r are sent, so the terminal does not stretch it past the band", () => {
  const painter = painterFor("kitty");
  const size = painter.renderSize({ path: "x.mp4", duration: 1, width: 1920, height: 1080, fps: 24, hasAudio: false, formatName: "mp4" }, 60, 10);
  const [command] = decodeKitty(painter.encode(Buffer.alloc(size.width * size.height * 3), size));
  const covered = painter.cells(size);
  assert.equal(command?.keys.c, String(covered.columns));
  assert.equal(command?.keys.r, String(covered.rows));
});

test("compression is on over SSH or when asked, and off when told", () => {
  assert.equal(compressionOn({}), false);
  assert.equal(compressionOn({ SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }), true);
  assert.equal(compressionOn({ SSH_CONNECTION: "x", DUMBEDITOR_KITTY_COMPRESS: "0" }), false);
  assert.equal(compressionOn({ DUMBEDITOR_KITTY_COMPRESS: "1" }), true);
});

test("the layer centres the picture and restores the cursor", () => {
  const names = ["SSH_CONNECTION", "DUMBEDITOR_KITTY_COMPRESS", "DUMBEDITOR_CELL_WIDTH", "DUMBEDITOR_CELL_HEIGHT"];
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  try {
    const painter = painterFor("kitty");
    const rgb = gradient(400, 200);
    const frame = { encoded: painter.encode(rgb, { width: 400, height: 200 }), size: { width: 400, height: 200 }, backend: "kitty" as const };
    const layer = buildVideoLayer(frame, { x: 22, y: 1, w: 60, h: 10 });
    assert.ok(layer.startsWith("\u001B7\u001B[2;33H"), "400 px is 40 columns: centred in 60 columns starting at 22 is 22 + 10, and columns count from 1");
    assert.ok(layer.endsWith("\u001B8"));
    const [command] = decodeKitty(layer);
    assert.equal(command?.keys.c, "40");
    assert.ok(command?.data.equals(rgb));
  } finally {
    for (const [name, value] of saved) { if (value !== undefined) process.env[name] = value; }
  }
});

function layered(persistent: boolean) {
  const inner = new FakeTerminal(80, 24);
  const state = { band: "one" };
  const layer: VideoLayer = { rect: { x: 0, y: 1, w: 80, h: 10 }, revision: 1, output: "<IMG>", persistent };
  const terminal = new LayeredTerminal(inner, { layer: () => layer, bandText: () => state.band });
  return { inner, state, terminal };
}

test("a picture that persists is not sent again when only the text around it changes; one that does not is", async () => {
  for (const persistent of [true, false]) {
    const { inner, state, terminal } = layered(persistent);
    terminal.write("a");
    await tick();
    const mark = inner.mark();
    state.band = "two";
    terminal.write("b");
    await tick();
    assert.equal(inner.since(mark).includes("<IMG>"), !persistent, `persistent=${persistent}`);
  }
});

test("a picture that persists is still sent again after a forced repaint such as a screen clear", async () => {
  const { inner, terminal } = layered(true);
  terminal.write("a");
  await tick();
  terminal.clearScreen();
  const mark = inner.mark();
  terminal.write("b");
  await tick();
  assert.ok(inner.since(mark).includes("<IMG>"));
});
