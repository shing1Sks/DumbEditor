import assert from "node:assert/strict";
import test from "node:test";
import { rgbToAnsi } from "../src/core/media.js";
import { nearestAnsi256, paletteColor, rgbToAnsi256 } from "../src/shell/preview/painters/ansi256.js";
import { colorMode } from "../src/shell/preview/painters/color.js";
import { painterFor } from "../src/shell/preview/painters/index.js";

test("colour mode: 24-bit everywhere except Terminal.app that does not announce it", () => {
  assert.equal(colorMode({}), "truecolor");
  assert.equal(colorMode({ COLORTERM: "truecolor" }), "truecolor");
  assert.equal(colorMode({ TERM_PROGRAM: "iTerm.app" }), "truecolor");
  assert.equal(colorMode({ TERM_PROGRAM: "Apple_Terminal" }), "256");
  assert.equal(colorMode({ TERM_PROGRAM: "Apple_Terminal", COLORTERM: "24bit" }), "truecolor");
  assert.equal(colorMode({ TERM_PROGRAM: "Apple_Terminal", COLORTERM: "" }), "256");
  assert.equal(colorMode({ WT_SESSION: "x" }), "truecolor");
});

test("DUMBEDITOR_COLOR decides explicitly", () => {
  assert.equal(colorMode({ DUMBEDITOR_COLOR: "256" }), "256");
  assert.equal(colorMode({ DUMBEDITOR_COLOR: " TRUECOLOR ", TERM_PROGRAM: "Apple_Terminal" }), "truecolor");
  assert.equal(colorMode({ DUMBEDITOR_COLOR: "nonsense" }), "truecolor");
});

test("the nearest palette entry: corners of the cube, greys, and colours between", () => {
  assert.equal(nearestAnsi256(0, 0, 0), 16, "black");
  assert.equal(nearestAnsi256(255, 255, 255), 231, "white");
  assert.equal(nearestAnsi256(255, 0, 0), 196, "red");
  assert.equal(nearestAnsi256(0, 255, 0), 46, "green");
  assert.equal(nearestAnsi256(0, 0, 255), 21, "blue");
  assert.equal(nearestAnsi256(128, 128, 128), 244, "a mid grey comes from the grey ramp (8 + 12 x 10 = 128)");
  assert.equal(nearestAnsi256(95, 135, 175), 16 + 36 * 1 + 6 * 2 + 3, "an exact cube colour");
  const grey = nearestAnsi256(30, 31, 29);
  assert.ok(grey >= 232 && grey <= 255, `a near grey is a grey (${grey})`);
});

function frame(width: number, height: number, colour: (x: number, y: number) => [number, number, number]): Buffer {
  const buffer = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = colour(x, y);
      buffer.set([red, green, blue], (y * width + x) * 3);
    }
  }
  return buffer;
}

test("the 256-colour picture has one text row per two picture rows, and no 24-bit colour codes", () => {
  const output = rgbToAnsi256(frame(6, 5, (x, y) => [x * 40, y * 50, 100]), 6, 5);
  const lines = output.split("\n");
  assert.equal(lines.length, 3, "5 rows of pixels make 3 text rows");
  for (const line of lines) {
    assert.ok(line.endsWith("\u001B[0m"), "colours reset at the end of each row");
    assert.equal([...line.matchAll(/▀/g)].length, 6, "one half block per column");
  }
  assert.ok(!output.includes("38;2;") && !output.includes("48;2;"));
  assert.match(output, /\u001B\[38;5;\d+m/);
  assert.match(output, /\u001B\[48;5;\d+m/);
});

test("a colour is only written when it changes, and a flat picture needs one pair of codes per row", () => {
  const flat = rgbToAnsi256(frame(20, 4, () => [95, 135, 175]), 20, 4).split("\n");
  for (const line of flat) {
    assert.equal([...line.matchAll(/\u001B\[38;5;/g)].length, 1);
    assert.equal([...line.matchAll(/\u001B\[48;5;/g)].length, 1);
  }
});

test("dithering never moves a colour that is already in the palette", () => {
  const exact = nearestAnsi256(95, 135, 175);
  const output = rgbToAnsi256(frame(16, 8, () => [95, 135, 175]), 16, 8);
  const indexes = new Set([...output.matchAll(/\u001B\[(?:38|48);5;(\d+)m/g)].map((match) => match[1]));
  assert.deepEqual([...indexes], [String(exact)]);
});

test("flat black, flat greys and near-black stay one colour: dithering them would only add noise", () => {
  for (const [value, expected] of [[0, 16], [3, 16], [128, 244], [8, 232], [238, 255], [255, 231]] as const) {
    const output = rgbToAnsi256(frame(16, 8, () => [value, value, value]), 16, 8);
    const indexes = new Set([...output.matchAll(/\u001B\[(?:38|48);5;(\d+)m/g)].map((match) => match[1]));
    assert.deepEqual([...indexes], [String(expected)], `grey ${value}`);
  }
  const letterbox = rgbToAnsi256(frame(30, 4, () => [0, 0, 0]), 30, 4).split("\n");
  for (const line of letterbox) assert.equal([...line.matchAll(/\u001B\[38;5;/g)].length, 1, "one colour code per row on a black bar");
});

test("the palette colour of an index is what the xterm palette says, and maps back to itself", () => {
  assert.deepEqual(paletteColor(16), [0, 0, 0]);
  assert.deepEqual(paletteColor(231), [255, 255, 255]);
  assert.deepEqual(paletteColor(196), [255, 0, 0]);
  assert.deepEqual(paletteColor(232), [8, 8, 8]);
  assert.deepEqual(paletteColor(255), [238, 238, 238]);
  for (let index = 16; index < 256; index += 1) {
    const [red, green, blue] = paletteColor(index);
    assert.equal(nearestAnsi256(red, green, blue), index, `index ${index} maps back to itself`);
  }
});

test("dithering does spread a colour between two palette steps over both of them", () => {
  // Each channel is exactly between two cube levels (95|135, 135|175, 175|215), far from any palette entry.
  const output = rgbToAnsi256(frame(16, 16, () => [115, 155, 195]), 16, 16);
  const indexes = new Set([...output.matchAll(/\u001B\[(?:38|48);5;(\d+)m/g)].map((match) => match[1]));
  assert.ok(indexes.size >= 2, `used ${indexes.size} different colours`);
});

test("the blocks painter writes the 24-bit picture unchanged, and the 256-colour one only where asked", () => {
  const saved = { program: process.env.TERM_PROGRAM, colorterm: process.env.COLORTERM, color: process.env.DUMBEDITOR_COLOR };
  const restore = () => {
    for (const [key, value] of [["TERM_PROGRAM", saved.program], ["COLORTERM", saved.colorterm], ["DUMBEDITOR_COLOR", saved.color]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  const rgb = frame(8, 6, (x, y) => [x * 30, y * 40, 200]);
  try {
    delete process.env.TERM_PROGRAM; delete process.env.COLORTERM; delete process.env.DUMBEDITOR_COLOR;
    assert.equal(painterFor("blocks").encode(rgb, { width: 8, height: 6 }), rgbToAnsi(rgb, 8, 6), "24-bit, byte for byte as before");
    process.env.TERM_PROGRAM = "Apple_Terminal";
    assert.equal(painterFor("blocks").encode(rgb, { width: 8, height: 6 }), rgbToAnsi256(rgb, 8, 6), "256 colours in Terminal.app");
  } finally { restore(); }
});
