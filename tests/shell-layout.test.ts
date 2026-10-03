import assert from "node:assert/strict";
import test from "node:test";
import { shellLayout } from "../src/shell/layout.js";
import type { MediaInfo } from "../src/types.js";

const media = (width: number, height: number): MediaInfo => ({ path: "test.mp4", width, height, duration: 10, fps: 30, hasAudio: true, formatName: "mov,mp4" });

test("sizes the video band from the picture's shape and keeps a good share of the screen for the chat", () => {
  assert.deepEqual(shellLayout({ columns: 120, rows: 40 }, media(1280, 720), "sixel"),
    { bandRows: 24, leftSidebarColumns: 0, videoColumns: 120, rightSidebarColumns: 0, gap: 0 });
  assert.deepEqual(shellLayout({ columns: 80, rows: 24 }, media(1280, 720), "blocks"),
    { bandRows: 11, leftSidebarColumns: 0, videoColumns: 80, rightSidebarColumns: 0, gap: 0 });
  assert.equal(shellLayout({ columns: 120, rows: 40 }, media(1080, 1920), "sixel").bandRows, 24, "a tall video is capped by the room available");
  for (const rows of [32, 40, 50, 60]) {
    const { bandRows } = shellLayout({ columns: 120, rows }, media(1280, 720), "sixel");
    assert.ok(rows - 9 - bandRows >= 7, `${rows} rows leave ${rows - 9 - bandRows} for the chat`);
    assert.ok(bandRows <= Math.floor(rows * 0.6), `${rows} rows: the video takes at most 60%`);
  }
});

test("shows sidebars only on wide terminals, with a gap, and shares the rest with the video", () => {
  assert.deepEqual(shellLayout({ columns: 160, rows: 50 }, media(1280, 720), "sixel"),
    { bandRows: 30, leftSidebarColumns: 26, videoColumns: 106, rightSidebarColumns: 26, gap: 1 });
  assert.equal(shellLayout({ columns: 129, rows: 50 }, media(1280, 720), "sixel").leftSidebarColumns, 0);
});

test("without a video the band takes all the room it may, and short terminals keep two chat rows", () => {
  assert.equal(shellLayout({ columns: 100, rows: 20 }, null, "sixel").bandRows, 9);
  assert.equal(shellLayout({ columns: 100, rows: 40 }, null, "sixel").bandRows, 24);
});
