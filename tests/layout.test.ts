import assert from "node:assert/strict";
import test from "node:test";
import { editorLayout } from "../src/ui/layout.js";
import type { MediaInfo } from "../src/types.js";

const media: MediaInfo = { path: "video.mp4", duration: 60, width: 1920, height: 1080, fps: 30, hasAudio: true, formatName: "mp4" };

test("sizes the player from video aspect ratio and gives remaining rows to chat", () => {
  const layout = editorLayout({ columns: 100, rows: 48 }, media, "sixel");
  assert.ok(layout.playerRows >= 26 && layout.playerRows <= 29);
  assert.equal(layout.playerRows + layout.chatRows, 41);
  assert.ok(layout.chatRows >= 4);
});
