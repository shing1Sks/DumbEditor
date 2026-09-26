import assert from "node:assert/strict";
import test from "node:test";
import { editorLayout } from "../src/ui/layout.js";
import { isVideoMutationStage } from "../src/ui/work-state.js";
import type { MediaInfo } from "../src/types.js";

const media: MediaInfo = { path: "video.mp4", duration: 60, width: 1920, height: 1080, fps: 30, hasAudio: true, formatName: "mp4" };

test("sizes the player from video aspect ratio and gives remaining rows to chat", () => {
  const layout = editorLayout({ columns: 100, rows: 48 }, media, "sixel");
  assert.ok(layout.playerRows >= 26 && layout.playerRows <= 29);
  assert.equal(layout.playerRows + layout.chatRows, 41);
  assert.ok(layout.chatRows >= 4);
  assert.equal(layout.leftSidebarColumns, 0);
  assert.equal(layout.videoColumns + layout.leftSidebarColumns + layout.rightSidebarColumns, 98);
});

test("uses wide terminal margins as balanced sidebars", () => {
  const layout = editorLayout({ columns: 190, rows: 52 }, media, "sixel");
  assert.ok(layout.leftSidebarColumns >= 18);
  assert.equal(layout.leftSidebarColumns, layout.rightSidebarColumns);
  assert.equal(layout.videoColumns + layout.leftSidebarColumns + layout.rightSidebarColumns, 188);
});

test("keeps the player stable while the input grows into reserved rows", () => {
  const singleLine = editorLayout({ columns: 150, rows: 50 }, media, "sixel", 1);
  const multiline = editorLayout({ columns: 150, rows: 50 }, media, "sixel", 4);
  assert.equal(singleLine.playerRows, multiline.playerRows);
  assert.equal(singleLine.chatRows - multiline.chatRows, 3);
});

test("locks preview controls only while a rendered version is changing", () => {
  assert.equal(isVideoMutationStage("planning the edit"), false);
  assert.equal(isVideoMutationStage("reviewing tool results"), false);
  assert.equal(isVideoMutationStage("Generating music with a model"), false);
  assert.equal(isVideoMutationStage("Rendering with FFmpeg"), true);
  assert.equal(isVideoMutationStage("Checking custom render"), true);
  assert.equal(isVideoMutationStage("Saving new version"), true);
});
