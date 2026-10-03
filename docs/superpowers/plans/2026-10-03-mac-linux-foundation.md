# Mac and Linux foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the video picture behind a swappable painter without changing a byte of what Windows draws, add a `dumbeditor doctor` setup check, and make text overlays and SRT/VTT captions work on an FFmpeg that has no libass.

**Architecture:** Contract tests that compare the new code with frozen copies of the current picture code are committed first. A `Painter` slot (Sixel and blocks painters that call the existing encoders) replaces the string comparisons on the backend name; the backend names stay `"sixel"` and `"blocks"`, so no caller or test is renamed. FFmpeg capabilities are read once from `ffmpeg -filters` / `-encoders`; when `ass` is missing, text and captions are drawn to PNGs (`@napi-rs/canvas`, loaded lazily, bundled Noto Sans) and laid on the video with `overlay`.

**Tech Stack:** TypeScript (ESM, Node >= 22.19), node:test, FFmpeg, `@napi-rs/canvas` (optional dependency), `@fontsource/noto-sans` font files (SIL OFL).

**Spec:** `docs/superpowers/specs/2026-10-03-mac-linux-foundation-design.md` (Task 7 syncs it with the deviations listed under "Deviations from the spec" below).

## Global Constraints

- Node `>=22.19.0`, ESM imports end in `.js`, strict TypeScript (`noUnusedLocals` and friends as the repo has them).
- Windows output unchanged: for `WT_SESSION` the painter is Sixel and every picture byte, layout number and layer string equals the current code's. `rgbToSixel`, `rgbToAnsi`, `shellLayout`, `buildVideoLayer`, `frameFits`, `previewRenderSize`, `detectPreviewBackend` keep their exported names and signatures.
- OpenRouter stays the only model provider; nothing here touches the engine, actions, sandbox or agent tools.
- `doctor` reads secrets by presence only (`Boolean(env.OPENROUTER_API_KEY?.trim())`), never prints a value.
- No publish, no version bump. Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Git in this folder needs the env-based safe directory: `$env:GIT_CONFIG_COUNT="1"; $env:GIT_CONFIG_KEY_0="safe.directory"; $env:GIT_CONFIG_VALUE_0="C:/Users/SHREYASH KUMAR SINGH/Desktop/DumbEditor"`. Multi-line commit messages go through `git commit -F <file>` (PowerShell mangles inline ones).
- Every new test file is added to the `test` script list in `package.json`.

## Deviations from the spec

1. The `backend` field and the `PreviewBackend` type keep their names (the painter id uses the same strings). No test or caller is renamed.
2. `Painter` has no `CellSize` parameters (painters call one shared `cellSize()`), and gains `idealRows(columns, aspect)` for the layout. `detectPreviewBackend` stays in `core/media.ts` unchanged.
3. `doctor` lives in `src/platform/doctor.ts` (not `core/`), because it reads the shell's painter choice.
4. Caption and text PNGs are cropped to the text and positioned with `overlay=x:y`, with no `-loop 1`, so each PNG is decoded once.

## Review Focus

1. FFmpeg or its capability probe cannot run (missing binary, timeout): text keeps today's libass path (never flips to images), and `doctor` reports a failure and exits 1 instead of crashing. Pinned in Task 3 and Task 6.
2. SRT/VTT with a BOM, CRLF, overlapping cues, HTML tags, `{\an8}` codes, blank cues, or zero cues. Pinned in Task 4.
3. Text with multiple lines, a very long unbroken word, emoji, Cyrillic or Greek, or a font size larger than the frame must produce an image that fits the frame. Pinned in Task 4.
4. `@napi-rs/canvas` missing while libass is missing: the error names `dumbeditor doctor`. Pinned in Task 5.
5. `.ass`/`.ssa` input without libass fails with a clear message, and more than 200 cues fails before any rendering. Pinned in Task 5.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `tests/helpers/legacy-preview.ts` (new) | Frozen copies of the picture code as of `master` 8220c02. Test-only reference. |
| `tests/windows-contract.test.ts` (new) | Compares the live picture code with the frozen copies; pins encoder hashes. |
| `src/shell/preview/painters/types.ts` (new) | `Painter`, `CellRect`, `EncodedFrame`, `PainterId`. |
| `src/shell/preview/painters/cell-size.ts` (new) | `cellSize()`: the one place for the 10x20 default and the `DUMBEDITOR_CELL_*` override. |
| `src/shell/preview/painters/sixel.ts`, `blocks.ts`, `index.ts` (new) | The two painters and `painterFor(id)`, `explainBackend(env)`. |
| `src/shell/preview/video-layer.ts`, `playback.ts`, `preview-host.ts`, `layered-terminal.ts`, `src/shell/layout.ts`, `src/core/media.ts` (modify) | Use the painter slot; `LayeredTerminal` gains an optional `remove()` hook. |
| `src/core/ffmpeg-capabilities.ts` (new) | Parse `-filters`/`-encoders`/`-version`; memoized probe; `chooseTextRenderer`. |
| `src/core/captions.ts` (new) | SRT/VTT parser to cues. |
| `src/core/text-image.ts` (new) | Lazy canvas loader, bundled fonts, `wrapLines`, `renderTextImage`. |
| `assets/fonts/*.woff`, `assets/fonts/OFL.txt` (new) | Bundled bold Noto Sans subsets. |
| `src/core/advanced-editor.ts` (modify) | Image path for text and captions when libass is missing. |
| `src/platform/hints.ts`, `src/platform/doctor.ts` (new), `src/cli.ts` (modify) | Install hints, report logic, `dumbeditor doctor`. |
| `package.json`, `tsup.config.ts`, `THIRD_PARTY.md`, `README.md`, the spec (modify) | Dependency, font assets, docs. |

---

### Task 1: Windows contract tests

**Files:**
- Create: `tests/helpers/legacy-preview.ts`, `tests/windows-contract.test.ts`
- Modify: `package.json` (append `.test-dist/tests/windows-contract.test.js` to the `test` script)

**Interfaces:**
- Consumes: `detectPreviewBackend`, `previewRenderSize`, `encodePreviewFrame`, `rgbToSixel`, `rgbToAnsi` from `src/core/media.ts`; `buildVideoLayer`, `frameFits` from `src/shell/preview/video-layer.ts`; `shellLayout` from `src/shell/layout.ts`.
- Produces: `legacyDetect`, `legacyPreviewRenderSize`, `legacyFrameFits`, `legacyBuildVideoLayer`, `legacyShellLayout`, `LEGACY_FPS` (used only by the contract test).

- [ ] **Step 1: Write the frozen reference**

Create `tests/helpers/legacy-preview.ts` (verbatim logic from `master` 8220c02; do not "improve" it):

```ts
import type { MediaInfo } from "../../src/types.js";

// Frozen copies of the picture code as it was on master 8220c02, before the painter slot. The contract test
// compares the live code with these. If a result differs, the live code changed behaviour.

export type LegacyBackend = "sixel" | "blocks";
export interface LegacySize { width: number; height: number }
export interface LegacyFrame { encoded: string; size: LegacySize; backend: LegacyBackend }
export interface LegacyRect { x: number; y: number; w: number; h: number }

export const LEGACY_FPS = { sixel: 12, blocks: 10 } as const;

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const even = (value: number): number => {
  const rounded = Math.floor(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
};
const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));

export function legacyDetect(environment: NodeJS.ProcessEnv): LegacyBackend {
  const override = environment.DUMBEDITOR_PREVIEW?.trim().toLowerCase();
  if (override === "blocks" || override === "sixel") return override;
  if (environment.WT_SESSION) return "sixel";
  if (/sixel/i.test(environment.TERM ?? "")) return "sixel";
  return "blocks";
}

function legacyPreviewSize(info: MediaInfo, maxColumns: number, maxRows: number): LegacySize {
  const columnLimit = even(Math.max(0, Math.floor(maxColumns)));
  const pixelHeightLimit = even(Math.max(0, Math.floor(maxRows) * 2));
  if (columnLimit < 2 || pixelHeightLimit < 2) return { width: 0, height: 0 };
  const scale = Math.min(1, columnLimit / info.width, pixelHeightLimit / info.height);
  const width = even(Math.max(2, Math.floor(info.width * scale)));
  const height = even(Math.max(2, Math.floor(info.height * scale)));
  return { width, height };
}

export function legacyPreviewRenderSize(info: MediaInfo, maxColumns: number, maxRows: number, backend: LegacyBackend): LegacySize {
  if (backend === "blocks") return legacyPreviewSize(info, maxColumns, maxRows);
  const cellWidth = positiveInteger(process.env.DUMBEDITOR_CELL_WIDTH, 10);
  const cellHeight = positiveInteger(process.env.DUMBEDITOR_CELL_HEIGHT, 20);
  const widthLimit = even(Math.max(0, Math.floor(maxColumns - 2) * cellWidth));
  const heightLimit = even(Math.max(0, Math.floor(maxRows) * cellHeight));
  if (widthLimit < 2 || heightLimit < 2) return { width: 0, height: 0 };
  const scale = Math.min(widthLimit / info.width, heightLimit / info.height);
  return {
    width: even(Math.max(2, Math.floor(info.width * scale))),
    height: even(Math.max(2, Math.floor(info.height * scale))),
  };
}

export function legacyFrameFits(frame: LegacyFrame, rect: LegacyRect): boolean {
  const cellWidth = positiveInteger(process.env.DUMBEDITOR_CELL_WIDTH, 10);
  const cellHeight = positiveInteger(process.env.DUMBEDITOR_CELL_HEIGHT, 20);
  const columns = frame.backend === "sixel" ? Math.ceil(frame.size.width / cellWidth) : frame.size.width;
  const rows = frame.backend === "sixel" ? Math.ceil(frame.size.height / cellHeight) : Math.ceil(frame.size.height / 2);
  return columns <= rect.w && rows <= rect.h;
}

export function legacyBuildVideoLayer(frame: LegacyFrame, rect: LegacyRect): string {
  if (!frame.encoded) return "";
  const cellWidth = positiveInteger(process.env.DUMBEDITOR_CELL_WIDTH, 10);
  const imageColumns = frame.backend === "sixel" ? Math.ceil(frame.size.width / cellWidth) : frame.size.width;
  const column = rect.x + Math.max(0, Math.floor((rect.w - imageColumns) / 2)) + 1;
  const row = rect.y + 1;
  if (frame.backend === "sixel") return `\u001B7\u001B[${row};${column}H${frame.encoded}\u001B8`;
  const lines = frame.encoded.split("\n").slice(0, rect.h);
  let output = "\u001B7";
  for (let index = 0; index < lines.length; index += 1) output += `\u001B[${row + index};${column}H${lines[index]}`;
  return `${output}\u001B8`;
}

export interface LegacyLayout {
  bandRows: number;
  leftSidebarColumns: number;
  videoColumns: number;
  rightSidebarColumns: number;
  gap: number;
}

export function legacyShellLayout(terminal: { columns: number; rows: number }, media: MediaInfo | null, backend: LegacyBackend): LegacyLayout {
  const FIXED_ROWS = 9;
  const MAX_VIDEO_SHARE = 0.6;
  const available = Math.max(8, terminal.rows - FIXED_ROWS);
  const minimumChat = terminal.rows < 24 ? 2 : terminal.rows < 32 ? 4 : 7;
  const maximumBand = Math.max(6, Math.min(available - minimumChat, Math.floor(terminal.rows * MAX_VIDEO_SHARE)));
  const sidebarColumns = terminal.columns >= 130 ? clamp(Math.floor((terminal.columns - 82) / 2), 18, 26) : 0;
  const gap = sidebarColumns > 0 ? 1 : 0;
  const videoColumns = Math.max(20, terminal.columns - sidebarColumns * 2 - gap * 2);
  const columns = { leftSidebarColumns: sidebarColumns, videoColumns, rightSidebarColumns: sidebarColumns, gap };
  if (!media) return { bandRows: maximumBand, ...columns };
  const aspect = media.width / media.height;
  const cellWidth = positiveInteger(process.env.DUMBEDITOR_CELL_WIDTH, 10);
  const cellHeight = positiveInteger(process.env.DUMBEDITOR_CELL_HEIGHT, 20);
  const ideal = backend === "sixel"
    ? Math.ceil(((videoColumns - 2) * cellWidth) / aspect / cellHeight)
    : Math.ceil((videoColumns - 2) / aspect / 2);
  return { bandRows: clamp(ideal, 6, maximumBand), ...columns };
}
```

- [ ] **Step 2: Write the contract test**

Create `tests/windows-contract.test.ts`:

```ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { detectPreviewBackend, encodePreviewFrame, previewRenderSize, rgbToAnsi, rgbToSixel } from "../src/core/media.js";
import { shellLayout } from "../src/shell/layout.js";
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
  assert.deepEqual(LEGACY_FPS, { sixel: 12, blocks: 10 });
});
```

- [ ] **Step 3: Add the file to the `test` script**

In `package.json`, append ` .test-dist/tests/windows-contract.test.js` to the end of the `test` script's file list (after `transcription.test.js`).

- [ ] **Step 4: Run the new tests against the current code**

Run: `npm test 2>&1 | Select-String -Pattern "windows-contract|not ok|# (pass|fail)"` (PowerShell) or `npm test`.
Expected: all pass (these only describe the current behaviour). If one fails, the frozen copy is wrong: fix the copy to match `master`, never the live code.

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/legacy-preview.ts tests/windows-contract.test.ts package.json
git commit -F <message file: "test: pin the Windows picture behaviour before the painter slot">
```

---

### Task 2: The painter slot (pure refactor)

**Files:**
- Create: `src/shell/preview/painters/types.ts`, `cell-size.ts`, `sixel.ts`, `blocks.ts`, `index.ts`, `tests/painters.test.ts`
- Modify: `src/core/media.ts`, `src/shell/preview/video-layer.ts`, `src/shell/preview/playback.ts`, `src/shell/preview/preview-host.ts`, `src/shell/preview/layered-terminal.ts`, `src/shell/layout.ts`, `package.json` (test list)

**Interfaces:**
- Consumes: `rgbToSixel`, `rgbToAnsi`, `previewRenderSize` (media.ts), `PreviewSize`, `PreviewBackend`.
- Produces:
  - `painterFor(id: PainterId): Painter`, `explainBackend(env: NodeJS.ProcessEnv): string` from `painters/index.ts`.
  - `cellSize(environment?: NodeJS.ProcessEnv): CellSize` from `painters/cell-size.ts`.
  - `Painter { id; fps; renderSize(media, columns, rows); encode(rgb, size); cells(size); idealRows(columns, aspect); place(frame, rect); remove() }`.
  - `LayerHooks.remove?(): string` on `LayeredTerminal`.

- [ ] **Step 1: Write the failing painter tests**

Create `tests/painters.test.ts`:

```ts
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

test("stopping removes a picture that is still on screen before giving the terminal back", () => {
  const { inner, terminal } = layered(() => "<DEL>");
  terminal.write("a");
  // Flush the first frame synchronously the way a running app would have by now.
  return tick().then(() => {
    const mark = inner.mark();
    terminal.write("leave");
    terminal.stop();
    assert.equal(inner.since(mark), "<DEL>leave");
  });
});
```

(`inner.mark()` / `inner.since(mark)` exist on `FakeTerminal`; `since` returns the concatenation of writes after the mark. If `since` is named differently in `tests/helpers/fake-terminal.ts`, use the existing name.)

- [ ] **Step 2: Run to confirm it fails**

Run: `npm test` (the new file is added in Step 6; for now `npx tsc -p tsconfig.test.json` fails to compile: `painters/cell-size.js` not found).
Expected: compile errors for the missing modules.

- [ ] **Step 3: Create the painter modules**

`src/shell/preview/painters/cell-size.ts`:

```ts
export interface CellSize { width: number; height: number }

/**
 * The pixel size of one terminal cell, used to turn a picture's size into cells. Sixel and block layouts need a
 * guess: 10x20 unless DUMBEDITOR_CELL_WIDTH / DUMBEDITOR_CELL_HEIGHT say otherwise.
 */
export function cellSize(environment: NodeJS.ProcessEnv = process.env): CellSize {
  return {
    width: positiveInteger(environment.DUMBEDITOR_CELL_WIDTH, 10),
    height: positiveInteger(environment.DUMBEDITOR_CELL_HEIGHT, 20),
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
```

`src/shell/preview/painters/types.ts`:

```ts
import type { PreviewBackend, PreviewSize } from "../../../core/media.js";
import type { MediaInfo } from "../../../types.js";

/** A rectangle in terminal cells, 0-based from the top-left of the screen. */
export interface CellRect { x: number; y: number; w: number; h: number }

/** The id of a painter. It is the backend name the rest of the app already uses. */
export type PainterId = PreviewBackend;

export interface EncodedFrame {
  /** What the painter's `encode` made: a Sixel image, or for the block painter, text rows separated by newlines. */
  encoded: string;
  size: PreviewSize;
  backend: PainterId;
}

/** Turns RGB frames into something the video layer can place, and knows how the picture covers the screen. */
export interface Painter {
  readonly id: PainterId;
  /** Frames per second asked of FFmpeg while playing. */
  readonly fps: number;
  /** Pixel size of the picture for a rectangle of columns x rows cells. */
  renderSize(media: MediaInfo, columns: number, rows: number): PreviewSize;
  /** One RGB24 frame to the string the layer carries. */
  encode(rgb: Buffer, size: PreviewSize): string;
  /** Terminal cells the encoded picture covers. */
  cells(size: PreviewSize): { columns: number; rows: number };
  /** Rows of the band that suit a video of this aspect ratio in this many columns. */
  idealRows(columns: number, aspect: number): number;
  /** Escape sequences that draw the picture centred in the rectangle, leaving the cursor where it was. */
  place(frame: EncodedFrame, rect: CellRect): string;
  /** Escape sequences that take the picture off the screen. Empty when text drawn over it is enough. */
  remove(): string;
}
```

`src/shell/preview/painters/sixel.ts`:

```ts
import { previewRenderSize, rgbToSixel } from "../../../core/media.js";
import { cellSize } from "./cell-size.js";
import type { Painter } from "./types.js";

function cells(size: { width: number; height: number }): { columns: number; rows: number } {
  const cell = cellSize();
  return { columns: Math.ceil(size.width / cell.width), rows: Math.ceil(size.height / cell.height) };
}

/** A Sixel image painted at an absolute position (Windows Terminal, and terminals that advertise Sixel). */
export const sixelPainter: Painter = {
  id: "sixel",
  fps: 12,
  renderSize: (media, columns, rows) => previewRenderSize(media, columns, rows, "sixel"),
  encode: (rgb, size) => rgbToSixel(rgb, size.width, size.height),
  cells,
  idealRows(columns, aspect) {
    const cell = cellSize();
    return Math.ceil(((columns - 2) * cell.width) / aspect / cell.height);
  },
  place(frame, rect) {
    const column = rect.x + Math.max(0, Math.floor((rect.w - cells(frame.size).columns) / 2)) + 1;
    const row = rect.y + 1;
    return `\u001B7\u001B[${row};${column}H${frame.encoded}\u001B8`;
  },
  remove: () => "",
};
```

`src/shell/preview/painters/blocks.ts`:

```ts
import { previewRenderSize, rgbToAnsi } from "../../../core/media.js";
import type { Painter } from "./types.js";

/** Half-block characters with 24-bit colour: two picture rows per text row. Works in any terminal. */
export const blocksPainter: Painter = {
  id: "blocks",
  fps: 10,
  renderSize: (media, columns, rows) => previewRenderSize(media, columns, rows, "blocks"),
  encode: (rgb, size) => rgbToAnsi(rgb, size.width, size.height),
  cells: (size) => ({ columns: size.width, rows: Math.ceil(size.height / 2) }),
  idealRows: (columns, aspect) => Math.ceil((columns - 2) / aspect / 2),
  place(frame, rect) {
    const column = rect.x + Math.max(0, Math.floor((rect.w - frame.size.width) / 2)) + 1;
    const row = rect.y + 1;
    const lines = frame.encoded.split("\n").slice(0, rect.h);
    let output = "\u001B7";
    for (let index = 0; index < lines.length; index += 1) output += `\u001B[${row + index};${column}H${lines[index]}`;
    return `${output}\u001B8`;
  },
  remove: () => "",
};
```

`src/shell/preview/painters/index.ts`:

```ts
import { blocksPainter } from "./blocks.js";
import { sixelPainter } from "./sixel.js";
import type { Painter, PainterId } from "./types.js";

export type { CellRect, EncodedFrame, Painter, PainterId } from "./types.js";
export { cellSize } from "./cell-size.js";

const PAINTERS: Record<PainterId, Painter> = { sixel: sixelPainter, blocks: blocksPainter };

export function painterFor(id: PainterId): Painter {
  return PAINTERS[id];
}

/** Why `detectPreviewBackend` chose what it chose, in words a user can act on (used by `dumbeditor doctor`). */
export function explainBackend(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.DUMBEDITOR_PREVIEW?.trim().toLowerCase();
  if (override === "blocks" || override === "sixel") return `set by DUMBEDITOR_PREVIEW=${override}`;
  if (environment.WT_SESSION) return "Windows Terminal (Sixel)";
  if (/sixel/i.test(environment.TERM ?? "")) return "TERM advertises Sixel";
  return "no Sixel support detected in this terminal";
}
```

- [ ] **Step 4: Move the callers onto the slot**

`src/shell/preview/video-layer.ts` — replace the whole file:

```ts
import { painterFor } from "./painters/index.js";
import type { CellRect, EncodedFrame } from "./painters/types.js";

export type { CellRect, EncodedFrame } from "./painters/types.js";

/** Whether the picture, drawn at its own size, fits inside the rectangle. After a resize the old picture is bigger than the new rectangle until a new one is made. */
export function frameFits(frame: EncodedFrame, rect: CellRect): boolean {
  const { columns, rows } = painterFor(frame.backend).cells(frame.size);
  return columns <= rect.w && rows <= rect.h;
}

/**
 * The escape sequences that paint one picture inside the video rectangle: save the cursor, move, draw, restore.
 * The cursor is never hidden, because the composer's cursor must stay visible.
 */
export function buildVideoLayer(frame: EncodedFrame, rect: CellRect): string {
  if (!frame.encoded) return "";
  return painterFor(frame.backend).place(frame, rect);
}
```

`src/core/media.ts` — add `import { cellSize } from "../shell/preview/painters/cell-size.js";` at the top (below the other imports) and in `previewRenderSize` replace

```ts
  const cellWidth = positiveInteger(process.env.DUMBEDITOR_CELL_WIDTH, 10);
  const cellHeight = positiveInteger(process.env.DUMBEDITOR_CELL_HEIGHT, 20);
```

with

```ts
  const { width: cellWidth, height: cellHeight } = cellSize();
```

If `positiveInteger` is now unused in `media.ts`, delete it.

`src/shell/layout.ts` — import `painterFor` from `./preview/painters/index.js`; delete the two cell constants and the `positiveInteger` helper; replace the `ideal` expression with:

```ts
  const ideal = painterFor(backend).idealRows(videoColumns, aspect);
```

`src/shell/preview/playback.ts` — change the imports and three spots:

```ts
import {
  extractRawFrame, streamRawPreview,
  type PreviewBackend, type PreviewSize, type PreviewStream,
} from "../../core/media.js";
import { painterFor } from "./painters/index.js";
```

then `const size = previewRenderSize(media, input.columns, input.rows, input.backend);` becomes

```ts
    const painter = painterFor(input.backend);
    const size = painter.renderSize(media, input.columns, input.rows);
```

`fps: input.backend === "sixel" ? 12 : 10,` becomes `fps: painter.fps,`, and in `queue` replace `encodePreviewFrame(next.buffer, size, backend)` with `painterFor(backend).encode(next.buffer, size)`.

`src/shell/preview/layered-terminal.ts`:
- In `LayerHooks` add
  ```ts
  /** Escape sequences that take the picture off the screen, for painters whose picture outlives the text drawn over it. */
  remove?(): string;
  ```
- In `stop()`:
  ```ts
  stop(): void {
    this.stopped = true;
    const cleanup = this.lastKey !== null ? this.hooks.remove?.() ?? "" : "";
    const data = cleanup + this.pending.join("");
  ```
  (the rest of `stop()` is unchanged).
- In `flush()` replace the `if (!layer) { ... }` block with:
  ```ts
    if (!layer) {
      let cleanup = "";
      if (this.lastKey !== null) { this.lastKey = null; this.forced = true; cleanup = this.hooks.remove?.() ?? ""; }
      const out = data.endsWith(SYNC_END) && cleanup ? `${data.slice(0, -SYNC_END.length)}${cleanup}${SYNC_END}` : data + cleanup;
      if (out) this.inner.write(out);
      return;
    }
  ```

`src/shell/preview/preview-host.ts` — import `painterFor`/`PainterId`, track the last painter drawn, pass the hook:

```ts
import { painterFor, type PainterId } from "./painters/index.js";
...
  private drawn: PainterId | null = null;

  constructor(inner: Terminal, private readonly options: PreviewHostOptions) {
    this.terminal = new LayeredTerminal(inner, {
      layer: () => this.layer(),
      bandText: (rect) => this.options.screenLines().slice(rect.y, rect.y + rect.h).join("\n"),
      remove: () => (this.drawn ? painterFor(this.drawn).remove() : ""),
      ...(options.onResize ? { onResize: options.onResize } : {}),
    });
  }
```

and in `layer()`, right after the `frameFits` check: `this.drawn = this.frame.backend;`.

- [ ] **Step 5: Type-check and run the contract plus painter tests**

Add ` .test-dist/tests/painters.test.js` to the `test` script.
Run: `npm run check` then `npm test`.
Expected: no type errors; `windows-contract` and `painters` pass **unchanged**; the whole suite (185 + new) passes. If a contract test fails, the refactor changed behaviour: fix the refactor.

- [ ] **Step 6: Commit**

```bash
git add src tests package.json
git commit -F <message file: "refactor: put the picture behind a painter slot, Windows output unchanged">
```

---

### Task 3: FFmpeg capabilities

**Files:**
- Create: `src/core/ffmpeg-capabilities.ts`, `tests/ffmpeg-capabilities.test.ts`
- Modify: `package.json` (test list)

**Interfaces:**
- Produces: `FfmpegCapabilities { version: string | null; filters: ReadonlySet<string>; encoders: ReadonlySet<string> }`, `parseFilters(text)`, `parseEncoders(text)`, `parseVersion(text)`, `loadCapabilities(run?)`, `ffmpegCapabilities()` (memoized), `resetFfmpegCapabilities()`, `chooseTextRenderer(caps, env?) : "libass" | "images"`, `type RunCommand`.

- [ ] **Step 1: Write the failing tests**

Create `tests/ffmpeg-capabilities.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseTextRenderer, loadCapabilities, parseEncoders, parseFilters, parseVersion, type FfmpegCapabilities,
} from "../src/core/ffmpeg-capabilities.js";

const FILTERS = `Filters:
  T.. = Timeline support
  .S. = Slice threading
  ..C = Command support
  A = Audio input/output
  V = Video input/output
  | = Source or sink filter
 ... abench            A->A       Benchmark part of a filtergraph.
 T.C adelay            A->A       Delay one or more audio channels.
 ... scale             V->V       Scale the input video size and/or convert the image format.
 T.. overlay           VV->V      Overlay a video source on top of the input.
 ..C ass               V->V       Render ASS subtitles onto input video using the libass library.
 ... subtitles         V->V       Render text subtitles onto input video using the libass library.
`;
const SLIM_FILTERS = FILTERS.split("\n").filter((line) => !/ ass | subtitles /.test(line)).join("\n");
const ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V.S... gif                  GIF (Graphics Interchange Format)
 A....D aac                  AAC (Advanced Audio Coding)
 S..... srt                  SubRip subtitle
`;
const VERSION = "ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with Apple clang\n";

test("parses filter names and ignores the legend", () => {
  const names = parseFilters(FILTERS);
  for (const name of ["abench", "adelay", "scale", "overlay", "ass", "subtitles"]) assert.ok(names.has(name), name);
  assert.equal(names.has("="), false);
  assert.equal(names.size, 6);
});

test("parses encoder names and ignores the legend", () => {
  const names = parseEncoders(ENCODERS);
  assert.deepEqual([...names].sort(), ["aac", "gif", "libx264", "srt"]);
});

test("parses the version", () => {
  assert.equal(parseVersion(VERSION), "7.1.1");
  assert.equal(parseVersion("nonsense"), null);
});

test("loads the three outputs through the injected runner and tolerates a failing one", async () => {
  const run = async (_command: string, args: string[]) => (args.includes("-filters") ? FILTERS : args.includes("-encoders") ? ENCODERS : VERSION);
  const caps = await loadCapabilities(run);
  assert.equal(caps?.version, "7.1.1");
  assert.ok(caps?.filters.has("ass"));
  assert.ok(caps?.encoders.has("libx264"));
  assert.equal(await loadCapabilities(async () => { throw new Error("no ffmpeg"); }), null);
});

test("picks libass when the ass filter exists, images when it does not, libass when FFmpeg cannot be asked", () => {
  const full: FfmpegCapabilities = { version: "7", filters: parseFilters(FILTERS), encoders: new Set() };
  const slim: FfmpegCapabilities = { version: "7", filters: parseFilters(SLIM_FILTERS), encoders: new Set() };
  assert.equal(chooseTextRenderer(full, {}), "libass");
  assert.equal(chooseTextRenderer(slim, {}), "images");
  assert.equal(chooseTextRenderer(null, {}), "libass", "an unreadable probe keeps today's behaviour");
});

test("DUMBEDITOR_TEXT_RENDERER forces a path", () => {
  const full: FfmpegCapabilities = { version: "7", filters: parseFilters(FILTERS), encoders: new Set() };
  assert.equal(chooseTextRenderer(full, { DUMBEDITOR_TEXT_RENDERER: "images" }), "images");
  assert.equal(chooseTextRenderer(null, { DUMBEDITOR_TEXT_RENDERER: " IMAGES " }), "images");
  const slim: FfmpegCapabilities = { version: "7", filters: parseFilters(SLIM_FILTERS), encoders: new Set() };
  assert.equal(chooseTextRenderer(slim, { DUMBEDITOR_TEXT_RENDERER: "libass" }), "libass");
  assert.equal(chooseTextRenderer(full, { DUMBEDITOR_TEXT_RENDERER: "nonsense" }), "libass");
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx tsc -p tsconfig.test.json`. Expected: cannot find `../src/core/ffmpeg-capabilities.js`.

- [ ] **Step 3: Implement**

`src/core/ffmpeg-capabilities.ts`:

```ts
import { runProcess } from "./process.js";

export interface FfmpegCapabilities {
  /** The FFmpeg version string ("7.1.1"), or null when it could not be read. */
  version: string | null;
  filters: ReadonlySet<string>;
  encoders: ReadonlySet<string>;
}

export type RunCommand = (command: string, args: string[]) => Promise<string>;

const defaultRun: RunCommand = async (command, args) => {
  const result = await runProcess(command, args, { timeoutMs: 15_000, maxOutputBytes: 2_000_000 });
  return result.stdout.toString("utf8");
};

/** Filter names from `ffmpeg -filters`. The legend lines ("T.. = Timeline support") do not match. */
export function parseFilters(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[T.][S.][C.]\s+([A-Za-z0-9_]+)(?:\s|$)/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

/** Encoder names from `ffmpeg -encoders`. The legend lines ("V..... = Video") do not match. */
export function parseEncoders(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[VAS][.FSXBD]{5}\s+([A-Za-z0-9_]+)(?:\s|$)/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

export function parseVersion(text: string): string | null {
  return /^ffmpeg version (\S+)/m.exec(text)?.[1] ?? null;
}

/** Ask FFmpeg what it can do. Null when FFmpeg cannot be run at all. */
export async function loadCapabilities(run: RunCommand = defaultRun): Promise<FfmpegCapabilities | null> {
  try {
    const [version, filters, encoders] = await Promise.all([
      run("ffmpeg", ["-version"]),
      run("ffmpeg", ["-hide_banner", "-filters"]),
      run("ffmpeg", ["-hide_banner", "-encoders"]),
    ]);
    return { version: parseVersion(version), filters: parseFilters(filters), encoders: parseEncoders(encoders) };
  } catch {
    return null;
  }
}

let cached: Promise<FfmpegCapabilities | null> | null = null;

/** Asked once per process. */
export function ffmpegCapabilities(): Promise<FfmpegCapabilities | null> {
  cached ??= loadCapabilities();
  return cached;
}

export function resetFfmpegCapabilities(): void {
  cached = null;
}

export type TextRenderer = "libass" | "images";

/**
 * How text and captions are drawn: through libass (the `ass` filter) when this FFmpeg has it, otherwise as images.
 * When FFmpeg cannot be asked the answer is libass, which is what the editor always did. DUMBEDITOR_TEXT_RENDERER
 * forces a path (used by tests).
 */
export function chooseTextRenderer(caps: FfmpegCapabilities | null, environment: NodeJS.ProcessEnv = process.env): TextRenderer {
  const forced = environment.DUMBEDITOR_TEXT_RENDERER?.trim().toLowerCase();
  if (forced === "images" || forced === "libass") return forced;
  if (!caps) return "libass";
  return caps.filters.has("ass") ? "libass" : "images";
}
```

- [ ] **Step 4: Run and commit**

Add ` .test-dist/tests/ffmpeg-capabilities.test.js` to the `test` script. Run `npm run check; npm test`. Expected: pass.

```bash
git add src/core/ffmpeg-capabilities.ts tests/ffmpeg-capabilities.test.ts package.json
git commit -F <message file: "feat: read what FFmpeg can do and choose how text is drawn">
```

---

### Task 4: Caption parser and text images

**Files:**
- Create: `src/core/captions.ts`, `src/core/text-image.ts`, `assets/fonts/*.woff`, `assets/fonts/OFL.txt`, `tests/captions.test.ts`, `tests/text-image.test.ts`
- Modify: `package.json` (`optionalDependencies`, `files`, test list), `tsup.config.ts` (external), `THIRD_PARTY.md`

**Interfaces:**
- Produces:
  - `parseCues(source: string, extension: ".srt" | ".vtt"): Cue[]` and `interface Cue { start: number; end: number; text: string }`.
  - `loadCanvas(): Promise<CanvasModule | null>`, `wrapLines(text, maxWidth, widthOf): string[]`, `renderTextImage(options): Promise<TextImage>`, `interface TextImage { png: Buffer; width: number; height: number; x: number; y: number }`, `class ImageTextUnavailable extends Error`.

- [ ] **Step 1: Add the dependency and the font files**

```bash
npm install --save-optional @napi-rs/canvas
npm install --no-save @fontsource/noto-sans
```

Copy into `assets/fonts/` from `node_modules/@fontsource/noto-sans/files/`: `noto-sans-latin-700-normal.woff`, `noto-sans-latin-ext-700-normal.woff`, `noto-sans-cyrillic-700-normal.woff`, `noto-sans-greek-700-normal.woff`, and the licence file `node_modules/@fontsource/noto-sans/LICENSE` as `assets/fonts/OFL.txt`. Then check the library accepts WOFF with a one-off script:

```ts
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
console.log(GlobalFonts.registerFromPath("assets/fonts/noto-sans-latin-700-normal.woff", "T"));
const c = createCanvas(80, 40); const x = c.getContext("2d"); x.font = "bold 30px T"; x.fillText("Hi", 4, 30);
console.log((await c.encode("png")).length);
```

Expected: a truthy registration and a PNG length above 100. **If WOFF is rejected**, replace the four files with TTF files from `@expo-google-fonts/noto-sans` (`NotoSans_700Bold.ttf`, one file covering Latin, Greek and Cyrillic) and use that single file in `FONT_FILES` below. Record the final choice and the size of `@napi-rs/canvas` for the current platform (`du`-style folder size of `node_modules/@napi-rs`) in the commit message.

`package.json`: add `"assets"` to `files`, and confirm the dependency is under `optionalDependencies`.
`tsup.config.ts`: add `external: ["@napi-rs/canvas"]` to the config object (open the file; keep its other options).
`THIRD_PARTY.md`: add two entries: `@napi-rs/canvas` (MIT) and "Noto Sans Bold subsets via @fontsource/noto-sans (SIL Open Font License 1.1, see assets/fonts/OFL.txt)", following the file's existing format.

- [ ] **Step 2: Write the failing parser tests**

Create `tests/captions.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseCues } from "../src/core/captions.js";

test("parses an SRT with a BOM, CRLF and a sequence number", () => {
  const srt = "\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nHello there\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nSecond\r\nline\r\n";
  assert.deepEqual(parseCues(srt, ".srt"), [
    { start: 1, end: 2.5, text: "Hello there" },
    { start: 3, end: 4, text: "Second\nline" },
  ]);
});

test("strips tags and positioning codes, drops empty cues and keeps cues sorted", () => {
  const srt = "2\n00:00:05,000 --> 00:00:06,000\n{\\an8}<i>Top</i> <font color=\"red\">text</font>\n\n1\n00:00:01,000 --> 00:00:02,000\n   \n\n3\n00:00:00,500 --> 00:00:01,000\nFirst\n";
  assert.deepEqual(parseCues(srt, ".srt"), [
    { start: 0.5, end: 1, text: "First" },
    { start: 5, end: 6, text: "Top text" },
  ]);
});

test("overlapping cues are both kept", () => {
  const cues = parseCues("1\n00:00:01,000 --> 00:00:03,000\nA\n\n2\n00:00:02,000 --> 00:00:04,000\nB\n", ".srt");
  assert.equal(cues.length, 2);
});

test("parses WebVTT with a header, notes, cue ids, short timestamps and settings", () => {
  const vtt = "WEBVTT\n\nNOTE written by hand\n\nintro\n00:01.000 --> 00:02.000 align:start position:10%\nHi\n\n00:00:03.500 --> 00:00:05.000\n<v Bob>Hello</v>\n";
  assert.deepEqual(parseCues(vtt, ".vtt"), [
    { start: 1, end: 2, text: "Hi" },
    { start: 3.5, end: 5, text: "Hello" },
  ]);
});

test("ignores cues whose end is not after the start, and returns nothing for an empty file", () => {
  assert.deepEqual(parseCues("1\n00:00:02,000 --> 00:00:01,000\nbad\n", ".srt"), []);
  assert.deepEqual(parseCues("", ".srt"), []);
  assert.deepEqual(parseCues("not a subtitle file at all", ".srt"), []);
});
```

- [ ] **Step 3: Implement the parser**

`src/core/captions.ts`:

```ts
export interface Cue { start: number; end: number; text: string }

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function seconds(text: string): number | null {
  const match = TIME.exec(text);
  if (!match) return null;
  const [, hours = "0", minutes = "0", secs = "0", fraction = "0"] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(secs) + Number(fraction.padEnd(3, "0")) / 1000;
}

/** Cues from SRT or WebVTT text: tags and positioning codes are removed, empty or backwards cues dropped, sorted by start. */
export function parseCues(source: string, extension: ".srt" | ".vtt"): Cue[] {
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const cues: Cue[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n");
    if (extension === ".vtt" && /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0]?.trim() ?? "")) continue;
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing < 0) continue;
    const [from = "", to = ""] = (lines[timing] as string).split("-->");
    const start = seconds(from);
    const end = seconds(to.trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null || end <= start) continue;
    const body = lines.slice(timing + 1).join("\n")
      .replace(/\{\\[^}]*\}/g, "")
      .replace(/<[^>]*>/g, "")
      .split("\n").map((line) => line.trim()).join("\n").trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}
```

- [ ] **Step 4: Write the failing text image tests**

Create `tests/text-image.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { loadCanvas, renderTextImage, wrapLines } from "../src/core/text-image.js";

const width = (text: string) => text.length * 10;

test("wrapLines breaks at spaces, keeps explicit line breaks and never splits a word", () => {
  assert.deepEqual(wrapLines("one two three four", 100, width), ["one two", "three", "four"]);
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
```

- [ ] **Step 5: Implement the renderer**

`src/core/text-image.ts`:

```ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TextPosition } from "./advanced-editor.js";

type CanvasModule = typeof import("@napi-rs/canvas");

export class ImageTextUnavailable extends Error {
  constructor() {
    super("Drawing text needs either an FFmpeg with libass or the optional image library (@napi-rs/canvas), and neither is available. Run `dumbeditor doctor` to see how to fix it.");
    this.name = "ImageTextUnavailable";
  }
}

const FONT_FILES: Array<[family: string, file: string]> = [
  ["DumbEditor Latin", "noto-sans-latin-700-normal.woff"],
  ["DumbEditor Latin Ext", "noto-sans-latin-ext-700-normal.woff"],
  ["DumbEditor Cyrillic", "noto-sans-cyrillic-700-normal.woff"],
  ["DumbEditor Greek", "noto-sans-greek-700-normal.woff"],
];
const FONT_STACK = `${FONT_FILES.map(([family]) => `"${family}"`).join(", ")}, sans-serif`;
const MARGIN = 20;
const OUTLINE = 2;
const SHADOW = 1;

let loaded: Promise<CanvasModule | null> | null = null;

function fontDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(directory, "assets", "fonts"))) return join(directory, "assets", "fonts");
    directory = dirname(directory);
  }
  throw new Error("The bundled fonts were not found");
}

/** The optional canvas library with the bundled fonts registered, or null when it is not installed. */
export function loadCanvas(): Promise<CanvasModule | null> {
  loaded ??= import("@napi-rs/canvas")
    .then((canvas) => {
      const directory = fontDirectory();
      for (const [family, file] of FONT_FILES) canvas.GlobalFonts.registerFromPath(join(directory, file), family);
      return canvas;
    })
    .catch(() => null);
  return loaded;
}

/** Greedy word wrap. Explicit line breaks stay, and a word longer than the line gets a line of its own. */
export function wrapLines(text: string, maxWidth: number, widthOf: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const attempt = line ? `${line} ${word}` : word;
      if (line && widthOf(attempt) > maxWidth) { lines.push(line); line = word; } else line = attempt;
    }
    lines.push(line);
  }
  return lines;
}

export interface TextImage { png: Buffer; width: number; height: number; x: number; y: number }

export interface TextImageOptions {
  videoWidth: number;
  videoHeight: number;
  text: string;
  fontSize: number;
  color: string;
  position: TextPosition;
}

function parts(position: TextPosition): { horizontal: "left" | "center" | "right"; vertical: "top" | "middle" | "bottom" } {
  if (position === "center") return { horizontal: "center", vertical: "middle" };
  const [vertical, horizontal] = position.split("-") as ["top" | "bottom", "left" | "center" | "right"];
  return { horizontal, vertical };
}

/**
 * Draw the text on a transparent image cropped to the text, and say where to lay it on the video. The look follows the
 * libass style the editor used: bold, a 2 px dark outline, a soft shadow, 20 px margins.
 */
export async function renderTextImage(options: TextImageOptions): Promise<TextImage> {
  if (!/^#?[0-9a-f]{6}$/i.test(options.color)) throw new Error("Text color must be a six digit hex color");
  const canvas = await loadCanvas();
  if (!canvas) throw new ImageTextUnavailable();
  const font = `bold ${options.fontSize}px ${FONT_STACK}`;
  const measure = canvas.createCanvas(1, 1).getContext("2d");
  measure.font = font;
  const widthOf = (text: string) => measure.measureText(text).width;
  const lines = wrapLines(options.text, Math.max(1, options.videoWidth - MARGIN * 2), widthOf);
  const lineHeight = Math.round(options.fontSize * 1.2);
  const pad = OUTLINE + SHADOW + 2;
  const width = Math.min(options.videoWidth, Math.ceil(Math.max(...lines.map(widthOf))) + pad * 2);
  const height = Math.min(options.videoHeight, lines.length * lineHeight + pad * 2);
  const image = canvas.createCanvas(width, height);
  const context = image.getContext("2d");
  const { horizontal, vertical } = parts(options.position);
  context.font = font;
  context.textAlign = horizontal;
  context.textBaseline = "middle";
  context.lineJoin = "round";
  const textX = horizontal === "left" ? pad : horizontal === "right" ? width - pad : width / 2;
  const colour = options.color.startsWith("#") ? options.color : `#${options.color}`;
  lines.forEach((line, index) => {
    const y = pad + index * lineHeight + lineHeight / 2;
    context.fillStyle = "rgba(0,0,0,0.5)";
    context.fillText(line, textX + SHADOW, y + SHADOW);
    context.lineWidth = OUTLINE * 2;
    context.strokeStyle = "#000000";
    context.strokeText(line, textX, y);
    context.fillStyle = colour;
    context.fillText(line, textX, y);
  });
  const x = horizontal === "left" ? MARGIN : horizontal === "right" ? options.videoWidth - MARGIN - width : Math.round((options.videoWidth - width) / 2);
  const y = vertical === "top" ? MARGIN : vertical === "bottom" ? options.videoHeight - MARGIN - height : Math.round((options.videoHeight - height) / 2);
  return {
    png: await image.encode("png"),
    width, height,
    x: Math.max(0, Math.min(options.videoWidth - width, x)),
    y: Math.max(0, Math.min(options.videoHeight - height, y)),
  };
}
```

(Verify the library API names with the TypeScript compiler. If `GlobalFonts.registerFromPath`, `encode("png")`, `loadImage`, or `measureText` differ in the installed version, adapt to the installed typings; the tests above pin the behaviour, not the names.)

- [ ] **Step 6: Run and commit**

Add ` .test-dist/tests/captions.test.js .test-dist/tests/text-image.test.js` to the `test` script. Run `npm run check; npm test`. Expected: pass.

```bash
git add src/core/captions.ts src/core/text-image.ts assets package.json package-lock.json tsup.config.ts THIRD_PARTY.md tests
git commit -F <message file: "feat: draw text and captions as images (optional canvas, bundled Noto Sans)", include the measured @napi-rs/canvas size>
```

---

### Task 5: Use the image path when libass is missing

**Files:**
- Modify: `src/core/advanced-editor.ts`, `tests/advanced-editor.test.ts`

**Interfaces:**
- Consumes: `ffmpegCapabilities`, `chooseTextRenderer` (Task 3); `parseCues` (Task 4); `renderTextImage`, `ImageTextUnavailable` (Task 4).
- Produces: `export const MAX_IMAGE_CUES = 200` from `advanced-editor.ts`.

- [ ] **Step 1: Restore the full test and add the image-path tests**

In `tests/advanced-editor.test.ts`, undo the macOS workaround: remove the `filters`/`hasAss` lines and the `if (hasAss) { ... } else { console.warn(...) }` wrapper so the text and captions checks run unconditionally (dedent the block), and restore `assert.equal(store.snapshot.versions.length, 7);` (delete the comment above it and the ternary). The default renderer on macOS (no libass) now takes the image path, so the same assertions cover it.

Append these tests to the file (they use the file's existing helpers `createFixtures`, `brightPixelCount`, `changedPixelCount`):

```ts
test("text and captions drawn as images give the same result as libass: inside the range only", { timeout: 120_000 }, async () => {
  const saved = process.env.DUMBEDITOR_TEXT_RENDERER;
  process.env.DUMBEDITOR_TEXT_RENDERER = "images";
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-images-"));
  try {
    const source = join(directory, "source.mp4");
    const music = join(directory, "music.wav");
    const image = join(directory, "overlay.ppm");
    const subtitles = join(directory, "captions.srt");
    await createFixtures({ source, music, image, subtitles });
    const store = await ProjectStore.open(source);
    await store.setVersionLimit(10);

    const text = await executeAdvancedEdit(store, {
      action: "text", text: "Hello, DumbEditor!", range: { start: 0.3, end: 1.3 }, position: "center", fontSize: 24, color: "#ffffff",
    }, "add title");
    assert.equal(text.version.action, "Added text at 00:00.3–00:01.3");
    const inside = await brightPixelCount(text.version.filePath, 0.8);
    const outside = await brightPixelCount(text.version.filePath, 0.1);
    const after = await brightPixelCount(text.version.filePath, 2.0);
    assert.ok(inside > outside + 20, `text appears inside the range (${inside} vs ${outside})`);
    assert.ok(after <= outside + 5, `and is gone after it (${after} vs ${outside})`);

    await store.revert("v0000");
    const captioned = await executeAdvancedEdit(store, { action: "subtitles", filePath: subtitles }, "burn captions");
    assert.equal(captioned.version.action, "Burned in subtitles");
    assert.ok(await changedPixelCount(captioned.version.filePath, 0.1, 0.8) > 20);
  } finally {
    if (saved === undefined) delete process.env.DUMBEDITOR_TEXT_RENDERER; else process.env.DUMBEDITOR_TEXT_RENDERER = saved;
    await rm(directory, { recursive: true, force: true });
  }
});

test("without libass an .ass file is refused, an empty caption file is refused, and too many cues fail before rendering", { timeout: 120_000 }, async () => {
  const saved = process.env.DUMBEDITOR_TEXT_RENDERER;
  process.env.DUMBEDITOR_TEXT_RENDERER = "images";
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-images-errors-"));
  try {
    const source = join(directory, "source.mp4");
    await createFixtures({ source, music: join(directory, "m.wav"), image: join(directory, "o.ppm"), subtitles: join(directory, "c.srt") });
    const store = await ProjectStore.open(source);
    const ass = join(directory, "styled.ass");
    await writeFile(ass, "[Script Info]\n", "utf8");
    await assert.rejects(executeAdvancedEdit(store, { action: "subtitles", filePath: ass }, "x"), /libass.*dumbeditor doctor/s);
    const empty = join(directory, "empty.srt");
    await writeFile(empty, "nothing here", "utf8");
    await assert.rejects(executeAdvancedEdit(store, { action: "subtitles", filePath: empty }, "x"), /no readable cues/);
    const many = join(directory, "many.srt");
    let body = "";
    for (let index = 0; index < MAX_IMAGE_CUES + 1; index += 1) {
      const start = index * 0.01;
      body += `${index + 1}\n00:00:${String(Math.floor(start)).padStart(2, "0")},${String(Math.round((start % 1) * 1000)).padStart(3, "0")} --> 00:00:03,900\ncue ${index}\n\n`;
    }
    await writeFile(many, body, "utf8");
    await assert.rejects(executeAdvancedEdit(store, { action: "subtitles", filePath: many }, "x"), /limit.*dumbeditor doctor/s);
    assert.equal(store.snapshot.versions.length, 1, "nothing was committed");
  } finally {
    if (saved === undefined) delete process.env.DUMBEDITOR_TEXT_RENDERER; else process.env.DUMBEDITOR_TEXT_RENDERER = saved;
    await rm(directory, { recursive: true, force: true });
  }
});
```

Update the test file's imports: `import { executeAdvancedEdit, MAX_IMAGE_CUES } from "../src/core/advanced-editor.js";`.

- [ ] **Step 2: Run to confirm failure**

Run: `npx tsc -p tsconfig.test.json`. Expected: `MAX_IMAGE_CUES` is not exported.

- [ ] **Step 3: Implement the image path**

In `src/core/advanced-editor.ts`:

Imports: add `readFile` to the `node:fs/promises` import; add

```ts
import { parseCues } from "./captions.js";
import { chooseTextRenderer, ffmpegCapabilities } from "./ffmpeg-capabilities.js";
import { ImageTextUnavailable, renderTextImage } from "./text-image.js";
```

Add near the top-level constants:

```ts
/** Captions drawn as images get one overlay each; past this many the render and the filter graph get heavy. */
export const MAX_IMAGE_CUES = 200;
```

In `prepareText`, directly after `const alignment = ASS_ALIGNMENT[position];` insert the image branch:

```ts
  if (chooseTextRenderer(await ffmpegCapabilities()) === "images") {
    const image = await renderTextImage({
      videoWidth: media.width, videoHeight: media.height, text, fontSize, color: edit.color ?? "#ffffff", position,
    });
    const imageName = "text-overlay.png";
    await writeFile(join(workspace, imageName), image.png);
    return {
      extraInputs: ["-i", imageName],
      graph: `[1:v]format=rgba[text];[0:v:0][text]overlay=x=${image.x}:y=${image.y}:enable='between(t,${fixed(range.start)},${fixed(range.end)})'[vout]`,
      video: "[vout]",
      audio: media.hasAudio ? "source" : null,
      summary: `Added text at ${formatRange(range)}`,
    };
  }
```

In `prepareSubtitles`, after the extension check and before `const subtitleName`, insert:

```ts
  if (chooseTextRenderer(await ffmpegCapabilities()) === "images") return prepareSubtitleImages(input, extension, media, workspace);
```

and add the function after `prepareSubtitles`:

```ts
async function prepareSubtitleImages(input: string, extension: string, media: MediaInfo, workspace: string): Promise<RenderPlan> {
  if (extension === ".ass" || extension === ".ssa") {
    throw new Error("Burning in .ass or .ssa subtitles needs an FFmpeg with libass. Run `dumbeditor doctor` to see how to install one, or use an .srt or .vtt file.");
  }
  const cues = parseCues(await readFile(input, "utf8"), extension as ".srt" | ".vtt")
    .filter((cue) => cue.start < media.duration)
    .map((cue) => ({ ...cue, end: Math.min(cue.end, media.duration) }));
  if (cues.length === 0) throw new Error("The subtitle file has no readable cues inside the video");
  if (cues.length > MAX_IMAGE_CUES) {
    throw new Error(`This FFmpeg has no libass, so captions are drawn as images, and ${MAX_IMAGE_CUES} cues is the limit (the file has ${cues.length}). Run \`dumbeditor doctor\` to see how to install an FFmpeg with libass.`);
  }
  const fontSize = Math.max(12, Math.round((media.height * 16) / 288));
  const extraInputs: string[] = [];
  const parts: string[] = [];
  let previous = "0:v:0";
  for (const [index, cue] of cues.entries()) {
    const image = await renderTextImage({
      videoWidth: media.width, videoHeight: media.height, text: cue.text, fontSize, color: "#ffffff", position: "bottom-center",
    });
    const name = `cue-${index + 1}.png`;
    await writeFile(join(workspace, name), image.png);
    extraInputs.push("-i", name);
    const label = index === cues.length - 1 ? "vout" : `o${index + 1}`;
    parts.push(`[${index + 1}:v]format=rgba[c${index + 1}]`);
    parts.push(`[${previous}][c${index + 1}]overlay=x=${image.x}:y=${image.y}:enable='between(t,${fixed(cue.start)},${fixed(cue.end)})'[${label}]`);
    previous = label;
  }
  return { extraInputs, graph: parts.join(";"), video: "[vout]", audio: media.hasAudio ? "source" : null, summary: "Burned in subtitles" };
}
```

Wrap the text image call so a missing library is explained (both `renderTextImage` call sites throw `ImageTextUnavailable` already with the doctor pointer; `ImageTextUnavailable` is imported so the type exists for `instanceof` checks in later work, remove the import if the compiler reports it unused).

- [ ] **Step 4: Run and commit**

Run `npm run check; npm test`. Expected: the restored full test and both new tests pass on Windows (libass path for the first, images for the new ones). Also run the new image test on a no-libass setup if one is available; CI macOS covers it.

```bash
git add src/core/advanced-editor.ts tests/advanced-editor.test.ts
git commit -F <message file: "feat: text and captions work on an FFmpeg without libass">
```

---

### Task 6: `dumbeditor doctor`

**Files:**
- Create: `src/platform/hints.ts`, `src/platform/doctor.ts`, `tests/doctor.test.ts`
- Modify: `src/cli.ts` (subcommand and help text), `package.json` (test list)

**Interfaces:**
- Consumes: `FfmpegCapabilities`, `loadCapabilities` (Task 3); `loadCanvas` (Task 4); `detectPreviewBackend` (media.ts); `explainBackend`, `PainterId` (Task 2); `localSandboxStatus` (sandbox.ts).
- Produces: `installHints(platform)`, `buildReport(inputs)`, `formatReport(report)`, `gatherInputs(env?)`, `runDoctor(env?): Promise<number>`, `REQUIRED_FILTERS`, `REQUIRED_ENCODERS`.

- [ ] **Step 1: Write the failing tests**

Create `tests/doctor.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseEncoders, parseFilters, type FfmpegCapabilities } from "../src/core/ffmpeg-capabilities.js";
import { buildReport, formatReport, REQUIRED_FILTERS, type DoctorInputs } from "../src/platform/doctor.js";
import { installHints } from "../src/platform/hints.js";

const names = (list: readonly string[]) => list.map((name) => ` ... ${name}            V->V       x`).join("\n");
const filters = (extra: string[]) => parseFilters(`Filters:\n${names([...REQUIRED_FILTERS, ...extra])}\n`);
const encoders = parseEncoders(" V....D libx264              x\n A....D aac                  x\n");
const full: FfmpegCapabilities = { version: "7.1", filters: filters(["ass", "subtitles"]), encoders };
const slim: FfmpegCapabilities = { version: "9.0.2", filters: filters([]), encoders };

const base: DoctorInputs = {
  node: "v22.19.0", platform: "darwin", ffmpeg: full, ffprobe: true, ffplay: true, imageLibrary: true,
  painter: { id: "blocks", reason: "no Sixel support detected in this terminal" },
  sandbox: { available: true, detail: "Anthropic Sandbox Runtime" }, providerKey: true,
};
const byLabel = (report: ReturnType<typeof buildReport>, label: RegExp) => report.checks.find((check) => label.test(check.label));

test("a complete setup passes with no required failures", () => {
  const report = buildReport(base);
  assert.equal(report.ok, true);
  assert.equal(byLabel(report, /text/i)?.status, "ok");
  assert.match(byLabel(report, /text/i)?.detail ?? "", /libass/);
});

test("the Homebrew-slim FFmpeg passes through images when the image library is there, and warns when it is not", () => {
  const withLibrary = buildReport({ ...base, ffmpeg: slim });
  assert.equal(withLibrary.ok, true);
  assert.match(byLabel(withLibrary, /text/i)?.detail ?? "", /images/);
  const without = buildReport({ ...base, ffmpeg: slim, imageLibrary: false });
  assert.equal(without.ok, true, "text is optional");
  assert.equal(byLabel(without, /text/i)?.status, "warn");
  assert.ok((byLabel(without, /text/i)?.fix ?? []).join("\n").includes("ffmpeg-full"));
});

test("a missing FFmpeg fails with the install command for the OS and does not crash", () => {
  const report = buildReport({ ...base, ffmpeg: null, ffprobe: false, ffplay: false });
  assert.equal(report.ok, false);
  const ffmpeg = byLabel(report, /^ffmpeg$/i);
  assert.equal(ffmpeg?.status, "fail");
  assert.ok((ffmpeg?.fix ?? []).join("\n").includes("brew install ffmpeg-full"));
  assert.ok(formatReport(report).includes("[fail]"));
  const windows = buildReport({ ...base, platform: "win32", ffmpeg: null });
  assert.ok((byLabel(windows, /^ffmpeg$/i)?.fix ?? []).join("\n").includes("winget install Gyan.FFmpeg"));
});

test("missing encoders and filters are named", () => {
  const noEncoder: FfmpegCapabilities = { ...full, encoders: parseEncoders(" A....D aac  x\n") };
  const report = buildReport({ ...base, ffmpeg: noEncoder });
  assert.equal(report.ok, false);
  assert.match(byLabel(report, /encoders/i)?.detail ?? "", /libx264/);
  const noOverlay: FfmpegCapabilities = { ...full, filters: parseFilters(names(REQUIRED_FILTERS.filter((name) => name !== "overlay"))) };
  assert.match(byLabel(buildReport({ ...base, ffmpeg: noOverlay }), /filters/i)?.detail ?? "", /overlay/);
});

test("old Node fails; a missing ffplay, key, sandbox and a block-art terminal only warn", () => {
  assert.equal(buildReport({ ...base, node: "v20.11.0" }).ok, false);
  const report = buildReport({ ...base, ffplay: false, providerKey: false, sandbox: { available: false, detail: "bubblewrap is missing" } });
  assert.equal(report.ok, true);
  for (const label of [/ffplay/i, /provider|key/i, /sandbox/i, /terminal/i]) assert.equal(byLabel(report, label)?.status, "warn", String(label));
});

test("the report never contains a secret value", () => {
  const text = formatReport(buildReport({ ...base, providerKey: true }));
  assert.ok(!/sk-/.test(text));
  assert.match(text, /OPENROUTER_API_KEY/);
});

test("install hints exist for every platform", () => {
  for (const platform of ["win32", "darwin", "linux", "freebsd"] as const) assert.ok(installHints(platform).length > 0, platform);
});
```

- [ ] **Step 2: Run to confirm failure**

Run `npx tsc -p tsconfig.test.json`. Expected: cannot find `../src/platform/doctor.js`.

- [ ] **Step 3: Implement hints**

`src/platform/hints.ts`:

```ts
/** How to get an FFmpeg with everything DumbEditor can use, for each operating system. */
export function installHints(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return [
      "brew install ffmpeg-full",
      "ffmpeg-full is keg-only: add its folder to PATH (Apple Silicon: /opt/homebrew/opt/ffmpeg-full/bin, Intel: /usr/local/opt/ffmpeg-full/bin)",
      "or: brew tap homebrew-ffmpeg/ffmpeg && brew install homebrew-ffmpeg/ffmpeg/ffmpeg",
    ];
  }
  if (platform === "win32") return ["winget install Gyan.FFmpeg"];
  return [
    "Debian, Ubuntu: sudo apt install ffmpeg",
    "Fedora: sudo dnf install ffmpeg (needs RPM Fusion)",
    "or a static build from https://johnvansickle.com/ffmpeg/",
  ];
}
```

- [ ] **Step 4: Implement the report**

`src/platform/doctor.ts`:

```ts
import { loadCapabilities, type FfmpegCapabilities } from "../core/ffmpeg-capabilities.js";
import { detectPreviewBackend } from "../core/media.js";
import { runProcess } from "../core/process.js";
import { localSandboxStatus } from "../core/sandbox.js";
import { loadCanvas } from "../core/text-image.js";
import { explainBackend, type PainterId } from "../shell/preview/painters/index.js";
import { installHints } from "./hints.js";

/** Filters the editor's own commands use. Every FFmpeg build has them. */
export const REQUIRED_FILTERS = [
  "scale", "fps", "crop", "overlay", "volume", "colorchannelmixer", "hue", "boxblur", "vignette", "unsharp", "fade",
  "trim", "atrim", "setpts", "asetpts", "concat", "amix", "afade", "adelay", "atempo", "hstack", "format",
] as const;
export const REQUIRED_ENCODERS = ["libx264", "aac"] as const;
const MINIMUM_NODE = [22, 19] as const;

export interface DoctorInputs {
  node: string;
  platform: NodeJS.Platform;
  ffmpeg: FfmpegCapabilities | null;
  ffprobe: boolean;
  ffplay: boolean;
  imageLibrary: boolean;
  painter: { id: PainterId; reason: string };
  sandbox: { available: boolean; detail: string };
  providerKey: boolean;
}

export type CheckStatus = "ok" | "warn" | "fail";
export interface Check { label: string; status: CheckStatus; detail: string; fix?: string[] }
export interface DoctorReport { checks: Check[]; ok: boolean }

function nodeIsRecentEnough(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor >= MINIMUM_NODE[1]);
}

export function buildReport(inputs: DoctorInputs): DoctorReport {
  const hints = installHints(inputs.platform);
  const checks: Check[] = [];
  const add = (check: Check) => { checks.push(check); };

  add(nodeIsRecentEnough(inputs.node)
    ? { label: "Node", status: "ok", detail: inputs.node }
    : { label: "Node", status: "fail", detail: `${inputs.node} is too old`, fix: [`Install Node ${MINIMUM_NODE.join(".")} or newer: https://nodejs.org`] });

  const caps = inputs.ffmpeg;
  add(caps
    ? { label: "FFmpeg", status: "ok", detail: caps.version ? `version ${caps.version}` : "found" }
    : { label: "FFmpeg", status: "fail", detail: "ffmpeg did not run", fix: hints });
  add(inputs.ffprobe
    ? { label: "ffprobe", status: "ok", detail: "found" }
    : { label: "ffprobe", status: "fail", detail: "ffprobe did not run (it comes with FFmpeg)", fix: hints });

  if (caps) {
    const missingEncoders = REQUIRED_ENCODERS.filter((name) => !caps.encoders.has(name));
    add(missingEncoders.length === 0
      ? { label: "Encoders", status: "ok", detail: REQUIRED_ENCODERS.join(", ") }
      : { label: "Encoders", status: "fail", detail: `missing: ${missingEncoders.join(", ")}`, fix: hints });
    const missingFilters = REQUIRED_FILTERS.filter((name) => !caps.filters.has(name));
    add(missingFilters.length === 0
      ? { label: "Filters", status: "ok", detail: "everything the editor uses is there" }
      : { label: "Filters", status: "fail", detail: `missing: ${missingFilters.join(", ")}`, fix: hints });
    if (caps.filters.has("ass")) add({ label: "Text and captions", status: "ok", detail: "drawn through libass" });
    else if (inputs.imageLibrary) add({ label: "Text and captions", status: "ok", detail: "drawn as images (this FFmpeg has no libass; SRT and VTT work, .ass files do not)" });
    else add({
      label: "Text and captions", status: "warn",
      detail: "this FFmpeg has no libass and the image library is not installed, so text overlays and captions will fail",
      fix: ["Use an FFmpeg with libass:", ...hints],
    });
  } else {
    add({ label: "Text and captions", status: "warn", detail: "cannot tell without FFmpeg" });
  }

  add(inputs.ffplay
    ? { label: "ffplay", status: "ok", detail: "found (the preview plays sound)" }
    : { label: "ffplay", status: "warn", detail: "not found: the preview plays without sound", fix: hints });
  add(inputs.painter.id === "sixel"
    ? { label: "Terminal picture", status: "ok", detail: `sharp Sixel picture (${inputs.painter.reason})` }
    : {
        label: "Terminal picture", status: "warn", detail: `block art (${inputs.painter.reason})`,
        fix: ["For a sharp picture use Windows Terminal or a terminal with Sixel, or set DUMBEDITOR_PREVIEW=sixel if yours supports it."],
      });
  add(inputs.sandbox.available
    ? { label: "Agent sandbox", status: "ok", detail: inputs.sandbox.detail }
    : { label: "Agent sandbox", status: "warn", detail: `${inputs.sandbox.detail}: the agent cannot run scripts` });
  add(inputs.providerKey
    ? { label: "Provider key", status: "ok", detail: "OPENROUTER_API_KEY is set" }
    : { label: "Provider key", status: "warn", detail: "OPENROUTER_API_KEY is not set: the agent is off until you run `dumbeditor setup`" });

  return { checks, ok: checks.every((check) => check.status !== "fail") };
}

const MARK: Record<CheckStatus, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[fail]" };

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(`${MARK[check.status]} ${check.label}: ${check.detail}`);
    for (const fix of check.fix ?? []) lines.push(`         -> ${fix}`);
  }
  const failures = report.checks.filter((check) => check.status === "fail").length;
  lines.push("", failures === 0 ? "Everything the editor needs is in place." : `${failures} required thing${failures === 1 ? " is" : "s are"} missing.`);
  return lines.join("\n");
}

const runs = (command: string): Promise<boolean> =>
  runProcess(command, ["-version"], { timeoutMs: 8_000, maxOutputBytes: 64_000 }).then(() => true, () => false);

export async function gatherInputs(environment: NodeJS.ProcessEnv = process.env): Promise<DoctorInputs> {
  const [ffmpeg, ffprobe, ffplay, canvas, sandbox] = await Promise.all([
    loadCapabilities(), runs("ffprobe"), runs("ffplay"), loadCanvas(), localSandboxStatus().catch(() => ({ available: false, detail: "could not be checked" })),
  ]);
  return {
    node: process.version, platform: process.platform, ffmpeg, ffprobe, ffplay, imageLibrary: canvas !== null,
    painter: { id: detectPreviewBackend(environment), reason: explainBackend(environment) },
    sandbox, providerKey: Boolean(environment.OPENROUTER_API_KEY?.trim()),
  };
}

/** Prints the report and returns the exit code: 0 when nothing required is missing, 1 otherwise. */
export async function runDoctor(environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  const report = buildReport(await gatherInputs(environment));
  console.log(formatReport(report));
  return report.ok ? 0 : 1;
}
```

- [ ] **Step 5: Wire the subcommand and the help text**

In `src/cli.ts`, right after the `setup` block (before the `--help` block) add:

```ts
if (args[0] === "doctor") {
  const { runDoctor } = await import("./platform/doctor.js");
  process.exit(await runDoctor());
}
```

In the usage and reference text, next to each `dumbeditor setup` line add a matching line (keep the existing column alignment): usage block `  dumbeditor doctor` and reference block `  dumbeditor doctor     Check FFmpeg, text support and the terminal picture`.

- [ ] **Step 6: Run, smoke-test, commit**

Add ` .test-dist/tests/doctor.test.js` to the `test` script. Run `npm run check; npm test; npm run build; node dist/cli.js doctor`.
Expected: tests pass; the real report prints each check and exits 0 on this machine; `$LASTEXITCODE` reports 0 (PowerShell). Also run with no FFmpeg on the PATH (`$env:PATH` without it, in a subshell) and confirm `[fail] FFmpeg` and exit code 1 with no stack trace.

```bash
git add src/platform src/cli.ts tests/doctor.test.ts package.json
git commit -F <message file: "feat: dumbeditor doctor checks FFmpeg, text support and the terminal picture">
```

---

### Task 7: Docs, spec sync, final checks

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-10-03-mac-linux-foundation-design.md`

- [ ] **Step 1: README**

Update the platform table (the Windows/macOS/Linux rows) and the FFmpeg install text:
- macOS row: preview "Block art in most terminals; Sixel in iTerm2, WezTerm and VS Code (set `DUMBEDITOR_PREVIEW=sixel`); a Kitty/iTerm2 picture is planned", text "libass when your FFmpeg has it, otherwise drawn as images (SRT and VTT; `.ass` needs libass)".
- Add under the FFmpeg install block: for macOS prefer `brew install ffmpeg-full` (and the PATH note) because Homebrew's plain `ffmpeg` has no libass.
- Add a short "Check your setup" paragraph: `dumbeditor doctor` lists what is missing and prints the install command for your system; exit code 1 if something required is missing.

- [ ] **Step 2: Sync the spec with what was built**

In the spec: replace section 4.1's interface block and 4.2 table rows to match the "Deviations from the spec" list at the top of this plan (field name kept, no `CellSize` parameter, `idealRows`, `detectPreviewBackend` stays in `media.ts`, `doctor` under `src/platform/`), and note in 6.2 that PNGs are cropped and positioned with `overlay=x:y` without `-loop 1`. Add the measured `@napi-rs/canvas` size and the WOFF/TTF font decision to section 10 and mark open decisions 1 to 3 as decided with those facts (the caption cap stays 200 unless the measurement in Task 5 showed a problem).

- [ ] **Step 3: Full verification**

Run: `npm run quality` and `npm run release:check` (shows the package contents; confirm `assets/fonts` is included and no `.test-dist` is).
Expected: typecheck, all tests, build and pack listing succeed. Run `node dist/cli.js doctor`, then start the app on the sample video in Windows Terminal and play, pause, resize and open a panel as in PR #2's checklist.

- [ ] **Step 4: Commit**

```bash
git add README.md docs
git commit -F <message file: "docs: Mac/Linux notes, doctor, and sync the foundation spec">
```
