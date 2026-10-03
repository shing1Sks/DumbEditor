import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { detectPreviewBackend, encodePreviewFrame, previewRenderSize, rgbToAnsi, rgbToSixel } from "../src/core/media.js";
import { shellLayout } from "../src/shell/layout.js";
import { painterFor } from "../src/shell/preview/painters/index.js";
import { buildVideoLayer, frameFits } from "../src/shell/preview/video-layer.js";
import type { MediaInfo } from "../src/types.js";
import {
  LEGACY_FPS, legacyBuildVideoLayer, legacyDetect, legacyFrameFits, legacyPreviewRenderSize, legacyShellLayout,
  type LegacyBackend,
} from "./helpers/legacy-preview.js";

// The Windows contract: on Windows Terminal the picture, the layout and the layer strings must stay exactly what
// they were before the painter slot (master 8220c02). These tests compare the live code with frozen copies.

const media = (width: number, height: number): MediaInfo => ({ path: "x.mp4", duration: 10, width, height, fps: 24, hasAudio: true, formatName: "mp4" });
const MEDIA_SIZES: Array<[number, number]> = [[1920, 1080], [320, 180], [1080, 1920], [640, 640], [3840, 1634]];
const BACKENDS: LegacyBackend[] = ["sixel", "blocks"];
const CELL_ENVS: Array<Record<string, string | undefined>> = [{}, { DUMBEDITOR_CELL_WIDTH: "8", DUMBEDITOR_CELL_HEIGHT: "16" }, { DUMBEDITOR_CELL_WIDTH: "bad" }];

function withCellEnv(env: Record<string, string | undefined>, body: () => void): void {
  const saved = { w: process.env.DUMBEDITOR_CELL_WIDTH, h: process.env.DUMBEDITOR_CELL_HEIGHT };
  delete process.env.DUMBEDITOR_CELL_WIDTH;
  delete process.env.DUMBEDITOR_CELL_HEIGHT;
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  try { body(); } finally {
    if (saved.w === undefined) delete process.env.DUMBEDITOR_CELL_WIDTH; else process.env.DUMBEDITOR_CELL_WIDTH = saved.w;
    if (saved.h === undefined) delete process.env.DUMBEDITOR_CELL_HEIGHT; else process.env.DUMBEDITOR_CELL_HEIGHT = saved.h;
  }
}

test("Windows: Windows Terminal always gets Sixel, an unknown terminal gets blocks", () => {
  assert.equal(detectPreviewBackend({ WT_SESSION: "abc" }), "sixel");
  assert.equal(detectPreviewBackend({ WT_SESSION: "abc", TERM: "xterm-256color" }), "sixel");
  assert.equal(detectPreviewBackend({ WT_SESSION: "abc", DUMBEDITOR_PREVIEW: "blocks" }), "blocks");
  assert.equal(detectPreviewBackend({}), "blocks");
});

test("detection matches the frozen rule for every other environment", () => {
  // These entries may change when Kitty and iTerm2 painters arrive (they are the terminals that return blocks today).
  const environments: NodeJS.ProcessEnv[] = [
    {}, { TERM: "xterm-256color" }, { TERM: "xterm-sixel" }, { TERM: "MLTERM-SIXEL" }, { TERM_PROGRAM: "Apple_Terminal" },
    { TERM_PROGRAM: "iTerm.app" }, { DUMBEDITOR_PREVIEW: "sixel" }, { DUMBEDITOR_PREVIEW: " SIXEL " }, { DUMBEDITOR_PREVIEW: "nope", WT_SESSION: "x" },
    { KITTY_WINDOW_ID: "1" }, { TERM_PROGRAM: "ghostty" }, { TERM: "xterm-kitty" },
  ];
  for (const environment of environments) assert.equal(detectPreviewBackend(environment), legacyDetect(environment), JSON.stringify(environment));
});

test("the render size of the picture equals the frozen one", () => {
  const sizes: Array<[number, number]> = [[60, 10], [100, 24], [20, 6], [200, 40], [1, 1], [3, 3], [118, 17]];
  for (const env of CELL_ENVS) {
    withCellEnv(env, () => {
      for (const backend of BACKENDS) {
        for (const [width, height] of MEDIA_SIZES) {
          for (const [columns, rows] of sizes) {
            assert.deepEqual(
              previewRenderSize(media(width, height), columns, rows, backend),
              legacyPreviewRenderSize(media(width, height), columns, rows, backend),
              `${backend} ${width}x${height} in ${columns}x${rows} ${JSON.stringify(env)}`,
            );
          }
        }
      }
    });
  }
});

test("the layer strings and the fit check equal the frozen ones", () => {
  const frames = [
    { encoded: "\u001BP0;1;0q\"1;1;400;200#0;2;0;0;0#0~~\u001B\\", size: { width: 400, height: 200 }, backend: "sixel" as const },
    { encoded: "\u001BP0;1;0q\"1;1;1200;600#0~\u001B\\", size: { width: 1200, height: 600 }, backend: "sixel" as const },
    { encoded: "\u001BP0;1;0q\"1;1;7;5#0~\u001B\\", size: { width: 7, height: 5 }, backend: "sixel" as const },
    { encoded: "aaa\nbbb\nccc", size: { width: 3, height: 6 }, backend: "blocks" as const },
    { encoded: "x\ny", size: { width: 40, height: 4 }, backend: "blocks" as const },
    { encoded: "", size: { width: 40, height: 4 }, backend: "blocks" as const },
    { encoded: "", size: { width: 40, height: 20 }, backend: "sixel" as const },
  ];
  const rects = [
    { x: 22, y: 1, w: 60, h: 10 }, { x: 0, y: 0, w: 80, h: 24 }, { x: 5, y: 2, w: 7, h: 2 }, { x: 0, y: 1, w: 1, h: 1 },
    { x: 30, y: 3, w: 40, h: 3 }, { x: 0, y: 2, w: 118, h: 17 },
  ];
  for (const env of CELL_ENVS) {
    withCellEnv(env, () => {
      for (const frame of frames) {
        for (const rect of rects) {
          assert.equal(buildVideoLayer(frame, rect), legacyBuildVideoLayer(frame, rect), `layer ${frame.backend} ${frame.size.width}x${frame.size.height} @${JSON.stringify(rect)}`);
          assert.equal(frameFits(frame, rect), legacyFrameFits(frame, rect), `fits ${frame.backend} ${frame.size.width}x${frame.size.height} @${JSON.stringify(rect)}`);
        }
      }
    });
  }
});

test("the shell layout equals the frozen one", () => {
  const terminals = [[80, 24], [100, 30], [120, 40], [129, 40], [130, 40], [160, 50], [200, 60], [60, 20], [90, 12]] as const;
  for (const env of CELL_ENVS) {
    withCellEnv(env, () => {
      for (const backend of BACKENDS) {
        for (const [columns, rows] of terminals) {
          for (const info of [null, ...MEDIA_SIZES.map(([width, height]) => media(width, height))]) {
            assert.deepEqual(
              shellLayout({ columns, rows }, info, backend),
              legacyShellLayout({ columns, rows }, info, backend),
              `${backend} ${columns}x${rows} ${info ? `${info.width}x${info.height}` : "no media"} ${JSON.stringify(env)}`,
            );
          }
        }
      }
    });
  }
});

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
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

test("the Sixel and block encoders still produce the recorded bytes", () => {
  const sixel: Array<[number, number, string]> = [
    [16, 12, "1c3060693977524f7d2512138175e6a0efc3e555a0647ea3abc12ff082e357c6"],
    [120, 68, "5a1a01fec40e13e54217bf03820cc079fda8eba5dd6f4b32440c08889c1a70c9"],
    [322, 180, "44d4c786c01a2d2829c36b0b138220d3541170babd5ea02051814729dd97ec24"],
  ];
  for (const [width, height, hash] of sixel) {
    assert.equal(sha(rgbToSixel(gradient(width, height), width, height)), hash, `sixel ${width}x${height}`);
    assert.equal(encodePreviewFrame(gradient(width, height), { width, height }, "sixel"), rgbToSixel(gradient(width, height), width, height));
  }
  const blocks: Array<[number, number, string]> = [
    [8, 6, "e1f250aeed9e85c780f5859be334ce95ad39349ae275557b177dbae0bf841e06"],
    [40, 22, "b99d52c5c093d2d89608ff2921d613765a3204ece7b26f51219c5f85e36a07bc"],
  ];
  for (const [width, height, hash] of blocks) {
    assert.equal(sha(rgbToAnsi(gradient(width, height), width, height)), hash, `blocks ${width}x${height}`);
    assert.equal(encodePreviewFrame(gradient(width, height), { width, height }, "blocks"), rgbToAnsi(gradient(width, height), width, height));
  }
});

test("the frame rates the stream asks for are the recorded ones", () => {
  // The recorded rates; tests/painters.test.ts checks that playback actually asks FFmpeg for the painter's rate.
  assert.deepEqual(LEGACY_FPS, { sixel: 12, blocks: 10 });
  assert.equal(painterFor("sixel").fps, LEGACY_FPS.sixel);
  assert.equal(painterFor("blocks").fps, LEGACY_FPS.blocks);
});
