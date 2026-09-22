import assert from "node:assert/strict";
import test from "node:test";
import { detectPreviewBackend, previewRenderSize, rgbToSixel } from "../src/core/media.js";
import type { MediaInfo } from "../src/types.js";

test("selects Sixel for Windows Terminal with an explicit fallback override", () => {
  assert.equal(detectPreviewBackend({ WT_SESSION: "session" }), "sixel");
  assert.equal(detectPreviewBackend({ WT_SESSION: "session", DUMBEDITOR_PREVIEW: "blocks" }), "blocks");
});

test("sizes a Sixel preview in terminal pixels while preserving aspect ratio", () => {
  const media: MediaInfo = {
    path: "video.mp4",
    duration: 10,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    formatName: "mp4",
  };
  const size = previewRenderSize(media, 82, 18, "sixel");
  assert.ok(size.width >= 500);
  assert.ok(size.height >= 280);
  assert.ok(Math.abs(size.width / size.height - 16 / 9) < 0.02);
});

test("encodes a complete RGB frame as bounded Sixel graphics", () => {
  const rgb = Buffer.alloc(4 * 6 * 3);
  for (let pixel = 0; pixel < 24; pixel += 1) {
    rgb[pixel * 3] = 255;
    rgb[pixel * 3 + 1] = pixel % 2 === 0 ? 255 : 0;
  }
  const sixel = rgbToSixel(rgb, 4, 6);
  assert.ok(sixel.startsWith("\u001BP0;1;0q\"1;1;4;6"));
  assert.ok(sixel.includes("#"));
  assert.ok(sixel.endsWith("\u001B\\"));
  assert.throws(() => rgbToSixel(Buffer.alloc(2), 4, 6), /incomplete/);
});
