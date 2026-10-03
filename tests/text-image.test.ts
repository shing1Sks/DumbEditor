import assert from "node:assert/strict";
import test from "node:test";
import { loadCanvas, renderTextImage, wrapLines } from "../src/core/text-image.js";

const width = (text: string) => text.length * 10;

test("wrapLines breaks at spaces, keeps explicit line breaks and never splits a word", () => {
  assert.deepEqual(wrapLines("one two three four", 90, width), ["one two", "three", "four"]);
  assert.deepEqual(wrapLines("one two three four", 100, width), ["one two", "three four"], "a line exactly as wide as the limit fits");
  assert.deepEqual(wrapLines("a\nb c", 100, width), ["a", "b c"]);
  assert.deepEqual(wrapLines("unbreakableword ok", 50, width), ["unbreakableword", "ok"]);
  assert.deepEqual(wrapLines("", 100, width), [""]);
});

async function canvasOrSkip(t: { skip(message?: string): void }) {
  const canvas = await loadCanvas();
  if (!canvas) t.skip("the optional @napi-rs/canvas is not installed here");
  return canvas;
}

function alphaBounds(rgba: Uint8ClampedArray, w: number, h: number) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if ((rgba[(y * w + x) * 4 + 3] ?? 0) > 0) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  return { minX, minY, maxX, maxY };
}

test("a text image is a PNG that fits the frame and sits where the position says", async (t) => {
  const canvas = await canvasOrSkip(t);
  if (!canvas) return;
  const common = { videoWidth: 320, videoHeight: 180, text: "Hello, DumbEditor!", fontSize: 24, color: "#ffffff" } as const;
  const bottom = await renderTextImage({ ...common, position: "bottom-center" });
  const top = await renderTextImage({ ...common, position: "top-left" });
  const middle = await renderTextImage({ ...common, position: "center" });
  assert.deepEqual([...bottom.png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "a PNG");
  for (const image of [bottom, top, middle]) {
    assert.ok(image.width > 0 && image.width <= 320 && image.height > 0 && image.height <= 180);
    assert.ok(image.x >= 0 && image.y >= 0 && image.x + image.width <= 320 && image.y + image.height <= 180, "inside the frame");
  }
  assert.ok(bottom.y > middle.y && middle.y > top.y, "bottom below centre below top");
  assert.equal(top.x, 20, "left margin");
  assert.ok(Math.abs(bottom.x + bottom.width / 2 - 160) <= 1, "centred");
  const decoded = await canvas.loadImage(bottom.png);
  const probe = canvas.createCanvas(bottom.width, bottom.height);
  const context = probe.getContext("2d");
  context.drawImage(decoded, 0, 0);
  const pixels = context.getImageData(0, 0, bottom.width, bottom.height).data;
  const bounds = alphaBounds(pixels, bottom.width, bottom.height);
  assert.ok(bounds.maxX > bounds.minX && bounds.maxY > bounds.minY, "something is drawn");
  let white = 0;
  for (let index = 0; index < pixels.length; index += 4) if ((pixels[index] ?? 0) > 240 && (pixels[index + 1] ?? 0) > 240 && (pixels[index + 3] ?? 0) > 240) white += 1;
  assert.ok(white > 40, `white text pixels (${white})`);
});

test("long, multi-line, emoji and Cyrillic text still fits the frame, and a huge font size is clamped", async (t) => {
  if (!(await canvasOrSkip(t))) return;
  const cases = [
    { text: "word ".repeat(60), fontSize: 24 },
    { text: "line one\nline two\nline three", fontSize: 30 },
    { text: "Привет мир Γειά σου κόσμε 😀", fontSize: 28 },
    { text: "Hi", fontSize: 500 },
    { text: "x".repeat(200), fontSize: 24 },
  ];
  for (const item of cases) {
    const image = await renderTextImage({ videoWidth: 320, videoHeight: 180, text: item.text, fontSize: item.fontSize, color: "#ffcc00", position: "bottom-right" });
    assert.ok(image.x >= 0 && image.y >= 0 && image.x + image.width <= 320 && image.y + image.height <= 180, `${item.text.slice(0, 12)} fits`);
  }
});

test("a bad colour is refused with the same words the libass path uses", async (t) => {
  if (!(await canvasOrSkip(t))) return;
  await assert.rejects(renderTextImage({ videoWidth: 320, videoHeight: 180, text: "x", fontSize: 24, color: "red", position: "center" }), /six digit hex color/);
});
