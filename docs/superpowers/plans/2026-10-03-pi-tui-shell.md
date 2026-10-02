# DumbEditor pi-tui Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DumbEditor's Ink screen with a steady full-screen shell built on pi-tui, so long input, resizes, streaming answers and panels never move the panels, the video or the cursor, while keeping every screen and key the old UI had.

**Architecture:** A UI-free `ShellState` and a pure keymap; small pi-tui views; panels that replace the video band while open; a preview layer that paints the Sixel picture over a reserved rectangle and re-sends it only when it could have been erased; and one `ShellApp` that wires projects, commands, playback and the step 2 agent engine. The engine, the actions and the event stream are unchanged.

**Tech Stack:** TypeScript (strict, ESM), `@earendil-works/pi-tui@1.0.0` (pinned), `@xterm/headless` (tests only), the step 2 core, `node:test`, FFmpeg.

**Spec:** `docs/superpowers/specs/2026-10-03-pi-tui-shell-design.md`. Evidence for the renderer choice: `docs/superpowers/spikes/pi-tui/SPIKE-REPORT.md`.

## Working conventions

- Work in `C:\Users\SHREYASH KUMAR SINGH\Desktop\DumbEditor` (Git Bash path `/c/Users/SHREYASH KUMAR SINGH/Desktop/DumbEditor`) on branch `ui/pi-tui-shell`. Run every command from that folder.
- That folder is owned by a different Windows user, so git refuses it by default. In each Git Bash session define this once instead of changing global git config:

```bash
git() { command git -c safe.directory='*' "$@"; }
```

- Commit messages below carry no attribution trailer; add the one your environment requires. Do not push or publish to npm.
- Every task ends with the whole suite green (`npm test`) and `npx tsc --noEmit` clean. A task may be reviewed and rejected independently of its neighbours.
- Code and tests in this plan were replayed task by task in clean copies of the repository: each task compiled and passed the whole suite before the next was applied.
- Do not put backslash escapes inside `node -e` or heredoc scripts when editing files; use the editor tools. Windows file paths and regular expressions get mangled by the shell.

## Deviations from the spec (decided while building, each reflected in the code below)

1. **Panels replace the video band** (as the old UI did) instead of floating pi-tui overlays (spec sections 4 and 10). The video is then hidden by layout, so a panel can never sit under a Sixel picture, and the picture returns once when the panel closes.
2. **Slash-command suggestions use the editor's own dropdown** (typing `/` lists commands, Tab completes) instead of replacing the chat area with a list.
3. **Composer height is pi-tui's own rule** (grows to 30% of the terminal, minimum 5 lines, then scrolls inside) instead of the spec's 1 to 4 rows. The video band does not depend on it, as the spec requires; the chat takes or gives the rows.
4. **Text fields in panels are pi-tui `Input`**: Ctrl+U clears the model search (it was Ctrl+A), Ctrl+A and Ctrl+E move the cursor, and a prefilled field starts with the cursor at the end.
5. **Window focus regain** is detected in the terminal wrapper (pi-tui swallows the focus report before application key handlers) and redraws the picture.
6. **Switching the base-agent model keeps the chat history** (the old code dropped it); this closes a deferred minor from the step 2 review.
7. **Mouse capture stays at pi-tui's default** (wheel scrolling, drag-to-select with copy). The manual checklist asks the author to confirm it does not get in the way; making it opt-in is a one-line change if it does.

## Global Constraints

- Node `>=22.19.0` (unchanged); `@earendil-works/pi-tui` pinned at exactly `1.0.0`; `@xterm/headless` is a dev dependency only.
- pi-tui is imported only from `src/shell/` (and `tests/`); nothing in `src/core/` may import it.
- The step 2 engine, actions registry, session store and event stream are not modified.
- The video band height depends only on the terminal size and the video's shape, never on the composer.
- The picture layer never hides the cursor, and is re-sent only when the picture, its rectangle, or the text under it changed, or after a clear, a resize, or a regained window focus.
- Every panel renders exactly `bandRows` rows of exactly the band's width.
- Style: 2-space indent, ESM imports with `.js` specifiers, and the repo's strict compiler options (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`).
- No test spends provider credits or needs a real terminal; FFmpeg is real.

## Review Focus

Inputs most likely to hurt a real user that the spec does not spell out. Each has a test in the task that owns the code.

1. **A long or multi-line paste** (the 2026-10-03 failure): the composer grows or scrolls and nothing else moves. Test: `a long pasted input grows the composer without moving the band or repainting the video` (Task 5).
2. **Awkward window sizes and resizing**, including very small and very large terminals. Tests: `resizing keeps the layout consistent...`, `a very small terminal still draws every row within its width...` (Task 5).
3. **A panel opened over a playing or streaming video**, and the picture coming back once. Tests: `a panel replaces the band, takes the keys, hides the video, and returns it once when it closes` (Task 5), `the preview host paints each new picture...` (Task 4).
4. **The window losing and regaining focus** (Windows Terminal can drop Sixel images). Test: `draws the picture again when the window regains focus, and still passes the key on` (Task 4).
5. **Quitting in the middle of playback or a run**: no frames, sound or keys after `dispose`, children stopped. Test: `disposing the app while the video plays stops the picture, the sound and every key` (Task 8).
6. **A slow, failing or out-of-order model catalog, and a failed save** in the model picker. Tests: `model picker: a failed catalog or save shows the reason...`, `model picker ignores a slow answer after the user went back` (Task 7).
7. **Typing while an export runs, and text the agent never read.** Tests: `while an export runs typing is blocked but the play keys still work` (Task 5), `queued text the agent never read goes back to the composer` (Task 2).

---
## File map

| Path | Status | Responsibility |
| --- | --- | --- |
| `src/shell/layout.ts` | create | Terminal size and video shape to the fixed band sizes |
| `src/shell/state/{shell-state,engine-bridge}.ts`, `src/shell/work-state.ts` | create | Everything the screen shows, and the engine-event to state mapping |
| `src/shell/input/{keymap,keys}.ts` | create | Global key to intent, as pure functions |
| `src/shell/preview/*.ts` (5 files) | create | Picture placement, the layered terminal, playback, sound, the preview host |
| `src/shell/views/*.ts` (8 files), `src/shell/screen.ts` | create | The views and the layout that assembles them on pi-tui's alternate screen |
| `src/shell/overlays/*.ts` (11 files) | create | The panels and their shared frame helpers |
| `src/shell/{commands,engine-factory,app}.ts` | create | Slash commands, agent creation, and the application that wires everything |
| `src/cli.ts` | rename from `cli.tsx`, modify | Starts the shell instead of Ink |
| `src/ui/*` (18 files) | delete | The Ink UI |
| `tests/shell-*.test.ts` (9 files), `tests/helpers/fake-terminal.ts` | create | Unit tests, emulated-terminal layout tests, end-to-end tests |
| `tests/{keys,model-picker}.test.ts`, `tests/helpers/project.ts` | modify | New import paths; retrying cleanup |
| `tests/{layout,text-layout,terminal-layers}.test.ts` | delete | Tests of deleted Ink code |
| `package.json`, `package-lock.json`, `tsup.config.ts`, `tsconfig.json`, `README.md` | modify | Dependencies, entry point, docs |

## Task 1: Dependencies, test terminal and the layout function

**Files:**
- Modify: `package.json`, `package-lock.json` (by npm), `tests/helpers/project.ts`
- Create: `src/shell/layout.ts`, `tests/helpers/fake-terminal.ts`, `tests/shell-layout.test.ts`

**Interfaces:**
- Produces: `shellLayout(terminal: { columns: number; rows: number }, media: MediaInfo | null, backend: PreviewBackend): ShellLayout` where `ShellLayout = { bandRows; leftSidebarColumns; videoColumns; rightSidebarColumns }` (the band height never depends on what is typed).
- Produces (tests): `FakeTerminal` (a pi-tui `Terminal` that draws into an emulator: `new FakeTerminal(columns = 120, rows = 40)`, `send(data)`, `resize(columns, rows)`, `settle(ms = 90)`, `screen(): string[]`, `mark()`, `since(mark)`, `writes`), `sixelPlacements(output)` and `STUB_SIXEL`.

- [ ] **Step 1: Make sure the branch is clean and add the dependencies**

```bash
git() { command git -c safe.directory='*' "$@"; }
git switch ui/pi-tui-shell
git status --short
npm install --save-exact @earendil-works/pi-tui@1.0.0
npm install --save-dev --save-exact @xterm/headless
```

Expected: `git status --short` prints nothing before the installs; afterwards `package.json` lists `@earendil-works/pi-tui` at `1.0.0` and `@xterm/headless` at `6.0.0` with no `^`. (`@xterm/headless` is a test-only emulator and is CommonJS, which is why `fake-terminal.ts` loads it with `createRequire`.)

- [ ] **Step 2: Write the tests and the test terminal**

The `tests/helpers/project.ts` change makes temp-folder cleanup retry, because Windows keeps a video file locked for a moment after FFmpeg exits:

Apply this change to `tests/helpers/project.ts`:

```diff
--- a/tests/helpers/project.ts
+++ b/tests/helpers/project.ts
@@ -31,7 +31,8 @@
     async cleanup() {
       if (previousConfig === undefined) delete process.env.DUMBEDITOR_CONFIG_DIR;
       else process.env.DUMBEDITOR_CONFIG_DIR = previousConfig;
-      await rm(directory, { recursive: true, force: true });
+      // Windows keeps a file locked for a moment after FFmpeg exits, so retry the removal.
+      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
     },
   };
 }
```

Create `tests/helpers/fake-terminal.ts`:

```typescript
import { createRequire } from "node:module";
import type { Terminal } from "@earendil-works/pi-tui";

// @xterm/headless is CommonJS; load it the way Node's ESM loader can.
const { Terminal: XTerm } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");

/** A pi-tui terminal that draws into an emulator, so tests can read the screen and the bytes written. */
export class FakeTerminal implements Terminal {
  readonly writes: string[] = [];
  private cols: number;
  private rowCount: number;
  private readonly emulator: InstanceType<typeof XTerm>;
  private readonly pending: Promise<void>[] = [];
  private onInput: (data: string) => void = () => undefined;
  private onResize: () => void = () => undefined;

  constructor(columns = 120, rows = 40) {
    this.cols = columns;
    this.rowCount = rows;
    this.emulator = new XTerm({ cols: columns, rows, allowProposedApi: true });
  }

  get columns(): number { return this.cols; }
  get rows(): number { return this.rowCount; }
  get kittyProtocolActive(): boolean { return false; }
  start(onInput: (data: string) => void, onResize: () => void): void { this.onInput = onInput; this.onResize = onResize; }
  stop(): void { /* nothing to restore */ }
  async drainInput(): Promise<void> { /* no stdin */ }
  write(data: string): void {
    this.writes.push(data);
    this.pending.push(new Promise<void>((done) => { this.emulator.write(data, done); }));
  }
  moveBy(lines: number): void { this.write(lines > 0 ? `\x1b[${lines}B` : lines < 0 ? `\x1b[${-lines}A` : ""); }
  hideCursor(): void { this.write("\x1b[?25l"); }
  showCursor(): void { this.write("\x1b[?25h"); }
  clearLine(): void { this.write("\x1b[2K"); }
  clearFromCursor(): void { this.write("\x1b[J"); }
  clearScreen(): void { this.write("\x1b[2J\x1b[H"); }
  setTitle(): void { /* not shown */ }
  setProgress(): void { /* not shown */ }

  /** Type or paste: the same bytes a real terminal would send. */
  send(data: string): void { this.onInput(data); }
  resize(columns: number, rows: number): void {
    this.cols = columns;
    this.rowCount = rows;
    this.emulator.resize(columns, rows);
    this.onResize();
  }
  /** Wait for pi-tui's render timers and for the emulator to consume everything written. */
  async settle(ms = 90): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await Promise.all(this.pending.splice(0));
  }
  /** What is on screen now, one string per row, trailing spaces trimmed. */
  screen(): string[] {
    const buffer = this.emulator.buffer.active;
    return Array.from({ length: this.rowCount }, (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? "");
  }
  mark(): number { return this.writes.length; }
  since(mark: number): string { return this.writes.slice(mark).join(""); }
}

/** Where Sixel images were placed (1-based row and column of the cursor move just before each image). */
export function sixelPlacements(output: string): Array<[number, number]> {
  return [...output.matchAll(/\x1b\[(\d+);(\d+)H(?:\x1b[78])?\x1bP[\d;]*q/g)].map((match) => [Number(match[1]), Number(match[2])]);
}

export const STUB_SIXEL = "\x1bPq\"1;1;40;40#0;2;0;0;0#0!40~\x1b\\";
```

Create `tests/shell-layout.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { shellLayout } from "../src/shell/layout.js";
import type { MediaInfo } from "../src/types.js";

const media = (width: number, height: number): MediaInfo => ({ path: "test.mp4", width, height, duration: 10, fps: 30, hasAudio: true, formatName: "mov,mp4" });

test("sizes the video band from the picture's shape and keeps room for the chat", () => {
  assert.deepEqual(shellLayout({ columns: 120, rows: 40 }, media(1280, 720), "sixel"),
    { bandRows: 29, leftSidebarColumns: 0, videoColumns: 120, rightSidebarColumns: 0 });
  assert.deepEqual(shellLayout({ columns: 80, rows: 24 }, media(1280, 720), "blocks"),
    { bandRows: 13, leftSidebarColumns: 0, videoColumns: 80, rightSidebarColumns: 0 });
  assert.equal(shellLayout({ columns: 120, rows: 40 }, media(1080, 1920), "sixel").bandRows, 29, "a tall video is capped by the room available");
});

test("shows sidebars only on wide terminals and shares the rest with the video", () => {
  assert.deepEqual(shellLayout({ columns: 160, rows: 50 }, media(1280, 720), "sixel"),
    { bandRows: 30, leftSidebarColumns: 26, videoColumns: 108, rightSidebarColumns: 26 });
  assert.equal(shellLayout({ columns: 129, rows: 50 }, media(1280, 720), "sixel").leftSidebarColumns, 0);
});

test("without a video the band takes all the room it may, and short terminals keep two chat rows", () => {
  assert.equal(shellLayout({ columns: 100, rows: 20 }, null, "sixel").bandRows, 11);
  assert.equal(shellLayout({ columns: 100, rows: 40 }, null, "sixel").bandRows, 29);
});
```

Add the new test file to the `test` script in `package.json`:

```diff
--- a/package.json
+++ b/package.json
@@ -17,7 +17,7 @@
     "build": "tsup",
     "check": "tsc --noEmit",
     "dev": "tsx src/cli.tsx",
-    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/transcription.test.js",
+    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/shell-layout.test.js .test-dist/tests/transcription.test.js",
     "quality": "npm run check && npm test && npm run build",
     "release:check": "npm run quality && npm pack --dry-run",
     "prepublishOnly": "npm run quality"
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL with `error TS2307: Cannot find module '../src/shell/layout.js'`.

- [ ] **Step 4: Write the implementation**

Create `src/shell/layout.ts`:

```typescript
import type { PreviewBackend } from "../core/media.js";
import type { MediaInfo } from "../types.js";

export interface ShellLayout {
  /** Height of the band that holds the sidebars and the video. It never depends on what is typed. */
  bandRows: number;
  leftSidebarColumns: number;
  videoColumns: number;
  rightSidebarColumns: number;
}

/** Rows outside the band and the chat: header, timeline, controls hint, status line, and a one-row composer with its border. */
const FIXED_ROWS = 7;

export function shellLayout(
  terminal: { columns: number; rows: number },
  media: MediaInfo | null,
  backend: PreviewBackend,
): ShellLayout {
  const available = Math.max(8, terminal.rows - FIXED_ROWS);
  const minimumChat = terminal.rows < 24 ? 2 : 4;
  const maximumBand = Math.max(6, available - minimumChat);
  const sidebarColumns = terminal.columns >= 130 ? clamp(Math.floor((terminal.columns - 82) / 2), 18, 26) : 0;
  const videoColumns = Math.max(20, terminal.columns - sidebarColumns * 2);
  const columns = { leftSidebarColumns: sidebarColumns, videoColumns, rightSidebarColumns: sidebarColumns };
  if (!media) return { bandRows: maximumBand, ...columns };

  const aspect = media.width / media.height;
  const cellWidth = positiveInteger(process.env.DUMBEDITOR_CELL_WIDTH, 10);
  const cellHeight = positiveInteger(process.env.DUMBEDITOR_CELL_HEIGHT, 20);
  const ideal = backend === "sixel"
    ? Math.ceil(((videoColumns - 2) * cellWidth) / aspect / cellHeight)
    : Math.ceil((videoColumns - 2) / aspect / 2);
  return { bandRows: clamp(ideal, 6, maximumBand), ...columns };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx tsc -p tsconfig.test.json && node --test .test-dist/tests/shell-layout.test.js
npm test
```

Expected: 3 passed in `shell-layout`, then the whole suite: 106 tests, 105 passed, 1 skipped (the live OpenRouter test), 0 failed.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tests src/shell
git commit -m "build: add pi-tui, an emulated terminal for tests and the shell layout function"
```

## Task 2: Shell state and the engine bridge

**Files:**
- Create: `src/shell/work-state.ts`, `src/shell/state/shell-state.ts`, `src/shell/state/engine-bridge.ts`, `tests/shell-state.test.ts`
- Modify: `package.json` (`test` script)

**Interfaces:**
- Consumes: `EngineEvent` (`src/core/engine/events.ts`), `Engine.on` (step 2), `ChatMessage`, `MediaInfo`, `Selection`, `VersionEntry`, `UsageSummary`, `AgentAsset`.
- Produces: `class ShellState` (plain fields: `projectName`, `versionId`, `versions`, `versionLimit`, `media`, `playhead`, `playing`, `volume`, `selection`, `messages`, `chatExpanded`, `agentRunning`, `loader`, `status`, `usage`, `assets`, `overlay`, `approval`, `choice`, `agentModel`, `permissionMode`; getters `busy` and `videoMutationActive`; methods `subscribe`, `setProject`, `setVersions`, `setMedia`, `setPlayhead`, `movePlayhead`, `setPlaying`, `togglePlaying`, `adjustVolume`, `setIn`, `setOut`, `setSelection`, `setMessages`, `addMessage`, `clearMessages`, `appendLive`, `endLive`, `setChatExpanded`, `toggleChatExpanded`, `restoreComposerText`, `takeComposerRestore`, `openOverlay`, `closeOverlay`, `openApproval`, `openChoice`, `clearPrompts`, `setLoader`, `setStatus`, `setAgentRunning`, `setUsage`, `setAssets`, `setAgentModel`, `setPermissionMode`), `OverlayKind`, `ApprovalRequest`, `ChoicePrompt`, `TranscriptMessage`, `Loader`.
- Produces: `bindEngineEvents(state, engine: Pick<Engine, "on">, { label: () => string; persistAnswer: (text: string) => void }): () => void` and `isVideoMutationStage(stage: string): boolean`.

- [ ] **Step 1: Write the tests**

Create `tests/shell-state.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import type { EngineEvent } from "../src/core/engine/events.js";
import { bindEngineEvents } from "../src/shell/state/engine-bridge.js";
import { ShellState } from "../src/shell/state/shell-state.js";
import { isVideoMutationStage } from "../src/shell/work-state.js";

class FakeEngine {
  private listeners = new Set<(event: EngineEvent) => void>();
  on(listener: (event: EngineEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(event: EngineEvent): void { for (const listener of this.listeners) listener(event); }
}

function setup() {
  const state = new ShellState();
  const engine = new FakeEngine();
  const saved: string[] = [];
  const off = bindEngineEvents(state, engine, { label: () => "glm", persistAnswer: (text) => saved.push(text) });
  return { state, engine, saved, off };
}
const texts = (state: ShellState) => state.messages.map((message) => `${message.label ?? message.role}:${message.text}`);

test("streams the answer into one live message and saves it once when the run ends", () => {
  const { state, engine, saved } = setup();
  engine.emit({ type: "run_start", runId: "r1" });
  assert.equal(state.agentRunning, true);
  engine.emit({ type: "text_delta", text: "Hello " });
  engine.emit({ type: "text_delta", text: "there" });
  assert.deepEqual(texts(state), ["glm:Hello there"]);
  assert.equal(state.messages[0]?.live, true);
  engine.emit({ type: "run_end", reason: "done", message: "Hello there" });
  assert.equal(state.messages[0]?.live, false);
  assert.deepEqual(texts(state), ["glm:Hello there"], "the final message is not shown twice");
  assert.deepEqual(saved, ["Hello there"]);
  assert.equal(state.agentRunning, false);
  assert.equal(state.loader, null);
});

test("shows tool calls in order, and ends the streamed text before a tool line", () => {
  const { state, engine } = setup();
  engine.emit({ type: "run_start", runId: "r1" });
  engine.emit({ type: "text_delta", text: "Let me look." });
  engine.emit({ type: "tool_start", callId: "c1", name: "inspect_video_frames", summary: "Inspect 3 frame(s)", risk: "read" });
  assert.equal(state.messages[0]?.live, false);
  assert.deepEqual(state.loader, { source: "glm", stage: "Inspect 3 frame(s)" });
  engine.emit({ type: "tool_end", callId: "c1", ok: true, summary: "Looked at 3 frames" });
  engine.emit({ type: "tool_start", callId: "c2", name: "remove_ranges", summary: "Remove 3s-4s", risk: "edit" });
  engine.emit({ type: "tool_end", callId: "c2", ok: false, summary: "Range is outside the video" });
  assert.deepEqual(texts(state), ["glm:Let me look.", "tool:▸ Inspect 3 frame(s)", "tool:✓ Looked at 3 frames", "tool:▸ Remove 3s-4s", "tool:✗ Range is outside the video"]);
});

test("an approval request opens the approval panel and the end of the run closes it", () => {
  const { state, engine } = setup();
  engine.emit({ type: "run_start", runId: "r1" });
  engine.emit({ type: "approval_request", id: "a1", kind: "action", name: "generate_asset", summary: "Generate an image", risk: "spend" });
  assert.equal(state.overlay, "approval");
  assert.equal(state.approval?.id, "a1");
  engine.emit({ type: "run_end", reason: "aborted", message: "" });
  assert.equal(state.overlay, null);
  assert.equal(state.approval, null);
  assert.equal(state.messages.at(-1)?.text, "Stopped.");
});

test("a choice request opens the choice panel", () => {
  const { state, engine } = setup();
  engine.emit({ type: "choice_request", id: "q1", question: "Which?", options: ["A", "B"], allowCustom: true });
  assert.equal(state.overlay, "choice");
  assert.deepEqual(state.choice, { id: "q1", question: "Which?", options: ["A", "B"], allowCustom: true });
});

test("queued text the agent never read goes back to the composer", () => {
  const { state, engine } = setup();
  engine.emit({ type: "steer_dropped", texts: ["make it red", "and shorter"] });
  assert.equal(state.takeComposerRestore(), "make it red and shorter");
  assert.equal(state.takeComposerRestore(), null, "only once");
  assert.match(state.messages.at(-1)?.text ?? "", /back in the input box/);
});

test("reports errors, the spend limit and a queued message", () => {
  const { state, engine } = setup();
  engine.emit({ type: "steer_queued", text: "hi" });
  assert.match(state.status, /Queued/);
  engine.emit({ type: "error", message: "provider exploded", retryable: true });
  assert.deepEqual(texts(state).at(-1), "error:provider exploded");
  engine.emit({ type: "run_end", reason: "budget", message: "" });
  assert.match(state.messages.at(-1)?.text ?? "", /spend limit/);
});

test("stops listening to the engine when unbound", () => {
  const { state, engine, off } = setup();
  off();
  engine.emit({ type: "run_start", runId: "r1" });
  assert.equal(state.agentRunning, false);
});

test("opening a panel pauses playback and leaves chat focus; closing returns to the editor", () => {
  const state = new ShellState();
  state.setMedia({ path: "a.mp4", width: 1280, height: 720, duration: 20, fps: 30, hasAudio: true, formatName: "mp4" });
  state.setPlaying(true);
  state.setChatExpanded(true);
  state.openOverlay("help");
  assert.deepEqual([state.overlay, state.playing, state.chatExpanded], ["help", false, false]);
  state.closeOverlay();
  assert.equal(state.overlay, null);
});

test("moves the playhead within the video and marks in and out at the playhead", () => {
  const state = new ShellState();
  state.setMedia({ path: "a.mp4", width: 1280, height: 720, duration: 20, fps: 30, hasAudio: true, formatName: "mp4" });
  state.movePlayhead(-5);
  assert.equal(state.playhead, 0);
  state.movePlayhead(8);
  state.setIn();
  state.movePlayhead(100);
  state.setOut();
  assert.deepEqual([state.playhead, state.selection], [20, { in: 8, out: 20 }]);
});

test("notifies subscribers of changes until they unsubscribe", () => {
  const state = new ShellState();
  let calls = 0;
  const off = state.subscribe(() => { calls += 1; });
  state.setStatus("one");
  off();
  state.setStatus("two");
  assert.equal(calls, 1);
});

test("locks preview controls only while a rendered version is changing", () => {
  assert.equal(isVideoMutationStage("planning the edit"), false);
  assert.equal(isVideoMutationStage("reviewing tool results"), false);
  assert.equal(isVideoMutationStage("Generating music with a model"), false);
  assert.equal(isVideoMutationStage("Rendering with FFmpeg"), true);
  assert.equal(isVideoMutationStage("Checking custom render"), true);
  assert.equal(isVideoMutationStage("Saving new version"), true);
  const state = new ShellState();
  state.setLoader({ source: "Editor", stage: "Saving new version" });
  assert.deepEqual([state.busy, state.videoMutationActive], [true, true]);
  state.setAgentRunning(true);
  assert.equal(state.busy, false, "an agent run never blocks typing");
});
```

Add `shell-state` to the `test` script:

```diff
--- a/package.json
+++ b/package.json
@@ -17,7 +17,7 @@
     "build": "tsup",
     "check": "tsc --noEmit",
     "dev": "tsx src/cli.tsx",
-    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/shell-layout.test.js .test-dist/tests/transcription.test.js",
+    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/shell-layout.test.js .test-dist/tests/shell-state.test.js .test-dist/tests/transcription.test.js",
     "quality": "npm run check && npm test && npm run build",
     "release:check": "npm run quality && npm pack --dry-run",
     "prepublishOnly": "npm run quality"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL with `Cannot find module '../src/shell/state/engine-bridge.js'` (and the same for `shell-state` and `work-state`).

- [ ] **Step 3: Write the implementation**

Create `src/shell/work-state.ts`:

```typescript
export function isVideoMutationStage(stage: string): boolean {
  return /rendering with ffmpeg|rendering the agent's custom ffmpeg composition|checking rendered video|checking custom render|saving new version/i.test(stage);
}
```

Create `src/shell/state/shell-state.ts`:

```typescript
import type { AgentAsset } from "../../core/agent-workspace.js";
import type { ChoiceRequest } from "../../core/choice.js";
import type { EngineEvent } from "../../core/engine/events.js";
import { EMPTY_USAGE_SUMMARY, type UsageSummary } from "../../core/usage.js";
import type { ChatMessage, MediaInfo, Selection, VersionEntry } from "../../types.js";
import { isVideoMutationStage } from "../work-state.js";

export type OverlayKind = "help" | "history" | "model" | "music" | "export" | "assets" | "projects" | "approval" | "choice";
export type ApprovalRequest = Extract<EngineEvent, { type: "approval_request" }>;
export type ChoicePrompt = ChoiceRequest & { id: string };

export interface Loader { source: string; stage: string }

/** One line item of the conversation. `label` is a model name, or "tool" / "editor" / "error" for non-chat lines. */
export interface TranscriptMessage {
  id: string;
  role: ChatMessage["role"];
  text: string;
  label?: string;
  live: boolean;
}

/**
 * Everything the screen shows, with no terminal code in it. Views read it, intents change it, and every
 * change notifies subscribers once so the screen can redraw.
 */
export class ShellState {
  projectName: string | null = null;
  versionId = "";
  versions: VersionEntry[] = [];
  versionLimit = 5;
  media: MediaInfo | null = null;
  playhead = 0;
  playing = false;
  volume = 70;
  selection: Selection = { in: null, out: null };
  messages: TranscriptMessage[] = [];
  chatExpanded = false;
  agentRunning = false;
  loader: Loader | null = null;
  status = "Ready";
  usage: UsageSummary = EMPTY_USAGE_SUMMARY;
  assets: AgentAsset[] = [];
  overlay: OverlayKind | null = null;
  approval: ApprovalRequest | null = null;
  choice: ChoicePrompt | null = null;
  agentModel = "editor model";
  permissionMode: "ask" | "auto" = "ask";

  private readonly listeners = new Set<() => void>();
  private liveId: string | null = null;
  private counter = 0;
  private composerRestore: string | null = null;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Typing is blocked only by non-agent work (an export, a render); text sent to a running agent steers it. */
  get busy(): boolean { return this.loader !== null && !this.agentRunning; }
  get videoMutationActive(): boolean { return this.loader !== null && isVideoMutationStage(this.loader.stage); }

  setProject(name: string | null, versionId: string, versionLimit = this.versionLimit): void {
    this.projectName = name; this.versionId = versionId; this.versionLimit = versionLimit; this.emit();
  }
  setVersions(versions: VersionEntry[], versionId: string): void { this.versions = versions; this.versionId = versionId; this.emit(); }
  setMedia(media: MediaInfo | null): void { this.media = media; this.emit(); }
  setAgentModel(model: string): void { this.agentModel = model; this.emit(); }
  setPermissionMode(mode: "ask" | "auto"): void { this.permissionMode = mode; this.emit(); }
  setUsage(usage: UsageSummary): void { this.usage = usage; this.emit(); }
  setAssets(assets: AgentAsset[]): void { this.assets = assets; this.emit(); }
  setStatus(status: string): void { this.status = status; this.emit(); }
  setLoader(loader: Loader | null): void { this.loader = loader; this.emit(); }
  setAgentRunning(running: boolean): void { this.agentRunning = running; this.emit(); }

  // Playback and marks ---------------------------------------------------------------------------
  setPlayhead(seconds: number): void {
    const limit = this.media?.duration ?? 0;
    this.playhead = Math.max(0, Math.min(limit, seconds));
    this.emit();
  }
  movePlayhead(delta: number): void { this.setPlayhead(this.playhead + delta); }
  setPlaying(playing: boolean): void { this.playing = playing; this.emit(); }
  togglePlaying(): void { if (this.media) this.setPlaying(!this.playing); }
  adjustVolume(delta: number): void { this.volume = Math.max(0, Math.min(100, this.volume + delta)); this.emit(); }
  setIn(): void { this.selection = { ...this.selection, in: this.playhead }; this.emit(); }
  setOut(): void { this.selection = { ...this.selection, out: this.playhead }; this.emit(); }
  setSelection(selection: Selection): void { this.selection = { in: selection.in, out: selection.out }; this.emit(); }

  // Conversation ---------------------------------------------------------------------------------
  setMessages(history: readonly ChatMessage[]): void {
    this.liveId = null;
    this.messages = history.map((item) => ({ id: this.nextId(), role: item.role, text: item.content, ...(item.label ? { label: item.label } : {}), live: false }));
    this.emit();
  }
  addMessage(role: ChatMessage["role"], text: string, label?: string): void {
    this.messages = [...this.messages, { id: this.nextId(), role, text, ...(label ? { label } : {}), live: false }];
    this.emit();
  }
  clearMessages(): void { this.liveId = null; this.messages = []; this.emit(); }
  /** Add streamed text to the message being written, starting one if needed. */
  appendLive(text: string, label: string): void {
    const live = this.messages.find((message) => message.id === this.liveId);
    if (live) live.text += text;
    else {
      this.liveId = this.nextId();
      this.messages = [...this.messages, { id: this.liveId, role: "assistant", text, label, live: true }];
    }
    this.emit();
  }
  /** Stop streaming into the current message and return what it holds. */
  endLive(): string | null {
    const live = this.messages.find((message) => message.id === this.liveId);
    this.liveId = null;
    if (!live) return null;
    live.live = false;
    this.emit();
    return live.text;
  }
  setChatExpanded(expanded: boolean): void { this.chatExpanded = expanded; this.emit(); }
  toggleChatExpanded(): void {
    if (!this.chatExpanded) { this.playing = false; this.overlay = null; }
    this.chatExpanded = !this.chatExpanded;
    this.emit();
  }
  restoreComposerText(text: string): void { this.composerRestore = text; this.emit(); }
  takeComposerRestore(): string | null { const text = this.composerRestore; this.composerRestore = null; return text; }

  // Panels ---------------------------------------------------------------------------------------
  openOverlay(kind: OverlayKind): void {
    this.playing = false; this.chatExpanded = false; this.overlay = kind; this.emit();
  }
  closeOverlay(): void { this.overlay = null; this.emit(); }
  openApproval(request: ApprovalRequest): void { this.approval = request; this.openOverlay("approval"); }
  openChoice(request: ChoicePrompt): void { this.choice = request; this.openOverlay("choice"); }
  clearPrompts(): void {
    this.approval = null; this.choice = null;
    if (this.overlay === "approval" || this.overlay === "choice") this.overlay = null;
    this.emit();
  }

  private nextId(): string { this.counter += 1; return `m${this.counter}`; }
  private emit(): void { for (const listener of this.listeners) listener(); }
}
```

Create `src/shell/state/engine-bridge.ts`:

```typescript
import type { Engine } from "../../core/engine/engine.js";
import type { EngineEvent } from "../../core/engine/events.js";
import type { ShellState } from "./shell-state.js";

export interface BridgeOptions {
  /** The model name shown on the agent's lines; read each time because the user can change the model. */
  label: () => string;
  /** Called once with each finished answer so it can be saved in the project's chat history. */
  persistAnswer: (text: string) => void;
}

/** Turn the engine's events into state changes. Returns the function that stops listening. */
export function bindEngineEvents(state: ShellState, engine: Pick<Engine, "on">, options: BridgeOptions): () => void {
  return engine.on((event) => apply(state, event, options));
}

function apply(state: ShellState, event: EngineEvent, options: BridgeOptions): void {
  const label = options.label();
  switch (event.type) {
    case "run_start":
      state.setAgentRunning(true);
      state.setLoader({ source: label, stage: "Thinking" });
      break;
    case "text_delta":
      state.appendLive(event.text, label);
      if (state.loader?.stage !== "Writing response") state.setLoader({ source: label, stage: "Writing response" });
      break;
    case "tool_start":
      state.endLive();
      state.addMessage("assistant", `▸ ${event.summary}`, "tool");
      state.setLoader({ source: event.name === "run_sandbox_script" ? "Sandbox" : label, stage: event.summary });
      break;
    case "tool_progress":
      state.setLoader({ source: state.loader?.source ?? label, stage: event.stage });
      break;
    case "tool_end":
      state.addMessage("assistant", `${event.ok ? "✓" : "✗"} ${event.summary}`, "tool");
      break;
    case "approval_request":
      state.openApproval(event);
      break;
    case "choice_request":
      state.openChoice({ id: event.id, question: event.question, options: event.options, allowCustom: event.allowCustom });
      break;
    case "steer_queued":
      state.setStatus("Queued · the agent will read it after its current step");
      break;
    case "steer_dropped":
      state.restoreComposerText(event.texts.join(" "));
      state.addMessage("assistant", "The agent stopped before it read your queued message. It is back in the input box.", "editor");
      break;
    case "compaction":
      if (event.phase === "start") state.setLoader({ source: state.loader?.source ?? label, stage: "Compacting conversation" });
      else if (event.tokensBefore !== undefined) state.addMessage("assistant", `Compacted earlier conversation (${event.tokensBefore} → ${event.tokensAfter ?? 0} tokens).`, "editor");
      break;
    case "error":
      state.addMessage("assistant", event.message, "error");
      break;
    case "run_end": {
      const streamed = state.endLive();
      state.setAgentRunning(false);
      state.setLoader(null);
      state.clearPrompts();
      if (event.reason === "done" && event.message) {
        if (streamed === null || streamed.trim() !== event.message.trim()) state.addMessage("assistant", event.message, label);
        options.persistAnswer(event.message);
      }
      if (event.reason === "aborted") state.addMessage("assistant", "Stopped.", "editor");
      if (event.reason === "budget") state.addMessage("assistant", "Stopped at the spend limit. Raise it with /budget.", "editor");
      state.setStatus(event.reason === "done" ? `${label} · done` : event.reason === "error" ? `${label} request failed` : "Stopped");
      break;
    }
    default:
      break;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc -p tsconfig.test.json && node --test .test-dist/tests/shell-state.test.js
npm test
```

Expected: 11 passed in `shell-state`, then the whole suite: 117 tests, 116 passed, 1 skipped (the live OpenRouter test), 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/shell tests package.json
git commit -m "feat: add the shell state and the engine event bridge"
```

## Task 3: Global keys

**Files:**
- Create: `src/shell/input/keys.ts`, `src/shell/input/keymap.ts`, `tests/shell-keymap.test.ts`
- Modify: `package.json` (`test` script)

**Interfaces:**
- Produces: `resolveKey(data: string, context: KeyContext): Intent | null` (null means the focused component handles the key), `KeyContext = { overlayOpen; composerEmpty; agentRunning; busy; videoMutationActive; chatExpanded; hasMedia }`, `Intent` (`interrupt`, `ignore`, `toggle-chat-focus`, `collapse-chat`, `abort-agent`, `clear-composer`, `scroll-chat`, `scroll-chat-page`, `seek`, `toggle-play`, `volume`, `mark-in`, `mark-out`, `open-assets`), `isFocusReport(input)`, `playbackStart(time, duration)`.

- [ ] **Step 1: Write the tests**

Create `tests/shell-keymap.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { resolveKey, type KeyContext } from "../src/shell/input/keymap.js";
import { isFocusReport, playbackStart } from "../src/shell/input/keys.js";

const idle: KeyContext = { overlayOpen: false, composerEmpty: true, agentRunning: false, busy: false, videoMutationActive: false, chatExpanded: false, hasMedia: true };
const ctx = (changes: Partial<KeyContext> = {}): KeyContext => ({ ...idle, ...changes });

const CTRL_C = "\x03", CTRL_G = "\x07", CTRL_O = "\x0f", CTRL_P = "\x10";
const ESC = "\x1b", UP = "\x1b[A", DOWN = "\x1b[B", RIGHT = "\x1b[C", LEFT = "\x1b[D", PAGE_UP = "\x1b[5~", PAGE_DOWN = "\x1b[6~";

test("Ctrl+C interrupts, even while a panel is open", () => {
  assert.deepEqual(resolveKey(CTRL_C, ctx()), { type: "interrupt" });
  assert.deepEqual(resolveKey(CTRL_C, ctx({ overlayOpen: true })), { type: "interrupt" });
});

test("focus reports from the terminal are swallowed, so [I and [O never reach the input", () => {
  assert.deepEqual(resolveKey("\x1b[I", ctx()), { type: "ignore" });
  assert.deepEqual(resolveKey("[I", ctx({ overlayOpen: true })), { type: "ignore" });
  assert.deepEqual(resolveKey("\x1b[O", ctx({ overlayOpen: true })), { type: "ignore" });
  assert.ok(isFocusReport("[I") && isFocusReport("\x1b[O") && !isFocusReport("i"));
});

test("an open panel gets every other key itself", () => {
  for (const key of [UP, "a", ESC, CTRL_P, CTRL_G, "["]) assert.equal(resolveKey(key, ctx({ overlayOpen: true })), null);
});

test("with an empty composer the arrows seek and scroll, and the single keys edit volume and marks", () => {
  assert.deepEqual(resolveKey(LEFT, ctx()), { type: "seek", seconds: -5 });
  assert.deepEqual(resolveKey(RIGHT, ctx()), { type: "seek", seconds: 5 });
  assert.deepEqual(resolveKey(UP, ctx()), { type: "scroll-chat", rows: 1 });
  assert.deepEqual(resolveKey(DOWN, ctx()), { type: "scroll-chat", rows: -1 });
  assert.deepEqual(resolveKey("+", ctx()), { type: "volume", delta: 5 });
  assert.deepEqual(resolveKey("=", ctx()), { type: "volume", delta: 5 });
  assert.deepEqual(resolveKey("-", ctx()), { type: "volume", delta: -5 });
  assert.deepEqual(resolveKey("[", ctx()), { type: "mark-in" });
  assert.deepEqual(resolveKey("]", ctx()), { type: "mark-out" });
});

test("once something is typed those same keys belong to the composer", () => {
  for (const key of [LEFT, RIGHT, UP, DOWN, "+", "-", "[", "]", "a"]) assert.equal(resolveKey(key, ctx({ composerEmpty: false })), null, JSON.stringify(key));
});

test("Ctrl+P plays, Ctrl+O opens the assets, Ctrl+G expands the chat, whatever is typed", () => {
  assert.deepEqual(resolveKey(CTRL_P, ctx({ composerEmpty: false })), { type: "toggle-play" });
  assert.deepEqual(resolveKey(CTRL_O, ctx({ composerEmpty: false })), { type: "open-assets" });
  assert.deepEqual(resolveKey(CTRL_G, ctx({ composerEmpty: false })), { type: "toggle-chat-focus" });
});

test("Escape collapses the chat, then stops the agent, then clears the composer", () => {
  assert.deepEqual(resolveKey(ESC, ctx({ chatExpanded: true, agentRunning: true })), { type: "collapse-chat" });
  assert.deepEqual(resolveKey(ESC, ctx({ agentRunning: true })), { type: "abort-agent" });
  assert.deepEqual(resolveKey(ESC, ctx({ agentRunning: true, composerEmpty: false })), { type: "clear-composer" });
  assert.deepEqual(resolveKey(ESC, ctx({ composerEmpty: false })), { type: "clear-composer" });
  assert.equal(resolveKey(ESC, ctx()), null);
});

test("page keys scroll the chat by a page", () => {
  assert.deepEqual(resolveKey(PAGE_UP, ctx()), { type: "scroll-chat-page", direction: 1 });
  assert.deepEqual(resolveKey(PAGE_DOWN, ctx({ composerEmpty: false })), { type: "scroll-chat-page", direction: -1 });
});

test("while an export or render runs, typing is swallowed but seeking, volume and chat scrolling still work", () => {
  const busy = ctx({ busy: true, composerEmpty: false });
  assert.deepEqual(resolveKey("a", busy), { type: "ignore" });
  assert.deepEqual(resolveKey(UP, busy), { type: "scroll-chat", rows: 1 });
  assert.deepEqual(resolveKey(LEFT, busy), { type: "seek", seconds: -5 });
  assert.deepEqual(resolveKey("-", busy), { type: "volume", delta: -5 });
  const rendering = ctx({ busy: true, videoMutationActive: true });
  assert.deepEqual(resolveKey(LEFT, rendering), { type: "ignore" }, "no seeking while the video is being replaced");
  assert.deepEqual(resolveKey(CTRL_P, rendering), { type: "ignore" });
});

test("playback restarts from the beginning when it is at the end", () => {
  assert.equal(playbackStart(19.98, 20), 0);
  assert.equal(playbackStart(5, 20), 5);
});
```

Add `shell-keymap` to the `test` script:

```diff
--- a/package.json
+++ b/package.json
@@ -17,7 +17,7 @@
     "build": "tsup",
     "check": "tsc --noEmit",
     "dev": "tsx src/cli.tsx",
-    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/shell-layout.test.js .test-dist/tests/shell-state.test.js .test-dist/tests/transcription.test.js",
+    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/shell-layout.test.js .test-dist/tests/shell-state.test.js .test-dist/tests/shell-keymap.test.js .test-dist/tests/transcription.test.js",
     "quality": "npm run check && npm test && npm run build",
     "release:check": "npm run quality && npm pack --dry-run",
     "prepublishOnly": "npm run quality"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL with `Cannot find module '../src/shell/input/keymap.js'` and `'../src/shell/input/keys.js'`.

- [ ] **Step 3: Write the implementation**

pi-tui's own input handler swallows the window focus report (`ESC [ I`) before application listeners run, so the keymap only has to make sure focus reports never reach a text field. Regaining focus is handled in Task 4, at the terminal wrapper.

Create `src/shell/input/keys.ts`:

```typescript
// Focus reporting (CSI ? 1004 h) makes the terminal send ESC[I and ESC[O when the window gains or loses focus.
// They must never reach a text field, so they are recognised with or without the leading ESC.
export function isFocusReport(input: string): boolean {
  return input === "[I" || input === "[O" || input === "\u001B[I" || input === "\u001B[O";
}

// Where audio and video playback begin: replaying from the end restarts at zero.
export function playbackStart(time: number, duration: number): number {
  return time >= duration - 0.05 ? 0 : time;
}
```

Create `src/shell/input/keymap.ts`:

```typescript
import { matchesKey } from "@earendil-works/pi-tui";
import { isFocusReport } from "./keys.js";

/** What a global key press means. The app turns each intent into a state change or an engine call. */
export type Intent =
  | { type: "interrupt" }
  | { type: "ignore" }
  | { type: "toggle-chat-focus" }
  | { type: "collapse-chat" }
  | { type: "abort-agent" }
  | { type: "clear-composer" }
  | { type: "scroll-chat"; rows: number }
  | { type: "scroll-chat-page"; direction: 1 | -1 }
  | { type: "seek"; seconds: number }
  | { type: "toggle-play" }
  | { type: "volume"; delta: number }
  | { type: "mark-in" }
  | { type: "mark-out" }
  | { type: "open-assets" };

export interface KeyContext {
  overlayOpen: boolean;
  composerEmpty: boolean;
  agentRunning: boolean;
  /** An export or render is running; typing is blocked but the agent is not. */
  busy: boolean;
  videoMutationActive: boolean;
  chatExpanded: boolean;
  hasMedia: boolean;
}

const SEEK_SECONDS = 5;
const VOLUME_STEP = 5;

/**
 * Decide what a key means before the focused component sees it. Returns null when the key is not global,
 * so the composer or the open panel handles it as text or navigation.
 */
export function resolveKey(data: string, context: KeyContext): Intent | null {
  if (isFocusReport(data)) return { type: "ignore" };
  if (matchesKey(data, "ctrl+c")) return { type: "interrupt" };
  if (context.overlayOpen) return null;
  if (matchesKey(data, "ctrl+g")) return { type: "toggle-chat-focus" };
  if (matchesKey(data, "escape")) {
    if (context.chatExpanded) return { type: "collapse-chat" };
    if (context.agentRunning && context.composerEmpty) return { type: "abort-agent" };
    return context.composerEmpty ? null : { type: "clear-composer" };
  }
  if (matchesKey(data, "pageUp")) return { type: "scroll-chat-page", direction: 1 };
  if (matchesKey(data, "pageDown")) return { type: "scroll-chat-page", direction: -1 };
  if (context.busy) return busyIntent(data, context);
  if (matchesKey(data, "ctrl+o")) return { type: "open-assets" };
  if (matchesKey(data, "ctrl+p")) return context.hasMedia ? { type: "toggle-play" } : null;
  if (!context.composerEmpty) return null;
  if (matchesKey(data, "left")) return { type: "seek", seconds: -SEEK_SECONDS };
  if (matchesKey(data, "right")) return { type: "seek", seconds: SEEK_SECONDS };
  if (matchesKey(data, "up")) return { type: "scroll-chat", rows: 1 };
  if (matchesKey(data, "down")) return { type: "scroll-chat", rows: -1 };
  if (data === "+" || data === "=") return { type: "volume", delta: VOLUME_STEP };
  if (data === "-") return { type: "volume", delta: -VOLUME_STEP };
  if (data === "[") return { type: "mark-in" };
  if (data === "]") return { type: "mark-out" };
  return null;
}

function busyIntent(data: string, context: KeyContext): Intent {
  if (matchesKey(data, "up")) return { type: "scroll-chat", rows: 1 };
  if (matchesKey(data, "down")) return { type: "scroll-chat", rows: -1 };
  if (data === "+" || data === "=") return { type: "volume", delta: VOLUME_STEP };
  if (data === "-") return { type: "volume", delta: -VOLUME_STEP };
  if (!context.videoMutationActive) {
    if (matchesKey(data, "left")) return { type: "seek", seconds: -SEEK_SECONDS };
    if (matchesKey(data, "right")) return { type: "seek", seconds: SEEK_SECONDS };
    if (matchesKey(data, "ctrl+p")) return { type: "toggle-play" };
  }
  return { type: "ignore" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc -p tsconfig.test.json && node --test .test-dist/tests/shell-keymap.test.js
npm test
```

Expected: 10 passed in `shell-keymap`, then the whole suite: 127 tests, 126 passed, 1 skipped (the live OpenRouter test), 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/shell tests package.json
git commit -m "feat: add the shell keymap"
```

## Task 4: The video layer: picture placement, playback, sound and the preview host

**Files:**
- Create: `src/shell/preview/video-layer.ts`, `layered-terminal.ts`, `playback.ts`, `audio.ts`, `preview-host.ts`, `tests/shell-preview.test.ts`
- Modify: `package.json` (`test` script)

**Interfaces:**
- Consumes: `previewRenderSize`, `extractRawFrame`, `streamRawPreview`, `encodePreviewFrame`, `playAudio` (`src/core/media.ts`), `terminateProcess`, `playbackStart` (Task 3), `FakeTerminal` (Task 1).
- Produces: `buildVideoLayer(frame: EncodedFrame, rect: CellRect): string`; `CellRect = { x; y; w; h }` (0-based cells); `LayeredTerminal` (a pi-tui `Terminal` wrapper with `force()` and `paint()`; `VideoLayer = { rect; revision; output }`); `PlaybackController` (`update(input: PlaybackInput)`, `dispose()`; reports `PlaybackFrame = { encoded; size; backend; time }`); `AudioController` (`update(input: AudioInput)`, `dispose()`); `PreviewHost` (`terminal`, `setFrame(frame)`, `clear()`, `repaint()`).

- [ ] **Step 1: Write the tests**

Create `tests/shell-preview.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { extractRawFrame, previewRenderSize, type PreviewSize } from "../src/core/media.js";
import { buildVideoLayer } from "../src/shell/preview/video-layer.js";
import { LayeredTerminal, type VideoLayer } from "../src/shell/preview/layered-terminal.js";
import { AudioController } from "../src/shell/preview/audio.js";
import { PlaybackController, type PlaybackFrame } from "../src/shell/preview/playback.js";
import { PreviewHost } from "../src/shell/preview/preview-host.js";
import { FakeTerminal, sixelPlacements, STUB_SIXEL } from "./helpers/fake-terminal.js";
import { makeProject } from "./helpers/project.js";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("places a Sixel picture centred in the video rectangle, and block pictures row by row", () => {
  const size: PreviewSize = { width: 400, height: 200 };
  const sixel = buildVideoLayer({ encoded: STUB_SIXEL, size, backend: "sixel" }, { x: 22, y: 1, w: 60, h: 10 });
  assert.deepEqual(sixelPlacements(sixel), [[2, 22 + 1 + 10]], "rectangle x 22, 40 columns wide picture in 60 columns leaves 10 either side");
  assert.ok(sixel.startsWith("\x1b7") && sixel.endsWith("\x1b8"), "cursor is saved and restored");
  assert.ok(!sixel.includes("\x1b[?25l"), "the cursor must stay visible for the composer");
  const blocks = buildVideoLayer({ encoded: "aaa\nbbb\nccc", size: { width: 3, height: 6 }, backend: "blocks" }, { x: 0, y: 1, w: 7, h: 2 });
  assert.ok(blocks.includes("\x1b[2;3Haaa") && blocks.includes("\x1b[3;3Hbbb"));
  assert.ok(!blocks.includes("ccc"), "rows beyond the rectangle are cut");
});

function layered(initial: Partial<VideoLayer> = {}) {
  const inner = new FakeTerminal(80, 24);
  const state = { layer: { rect: { x: 10, y: 1, w: 40, h: 10 }, revision: 1, output: "<IMG>", ...initial } as VideoLayer | null, band: "band-a" };
  const terminal = new LayeredTerminal(inner, { layer: () => state.layer, bandText: () => state.band });
  return { inner, state, terminal };
}

test("writes each frame and the video layer as one synchronized update", async () => {
  const { inner, terminal } = layered();
  terminal.write("frame-one");
  terminal.write("frame-two");
  await tick();
  assert.equal(inner.writes.length, 1, "frames written in the same tick are sent together");
  assert.equal(inner.writes[0], `${SYNC_START}frame-oneframe-two<IMG>${SYNC_END}`);
  terminal.write(`${SYNC_START}x${SYNC_END}`);
  terminal.write("");
  await tick();
  assert.equal(inner.writes.at(-1), `${SYNC_START}x${SYNC_END}`, "unchanged picture is not sent again");
});

test("sends the picture again only when the video, its rectangle, or the text under it changed", async () => {
  const { inner, state, terminal } = layered();
  const frame = async (text = "f") => { terminal.write(`${SYNC_START}${text}${SYNC_END}`); await tick(); return inner.writes.at(-1) ?? ""; };
  assert.ok((await frame()).includes("<IMG>"), "first frame");
  assert.ok(!(await frame()).includes("<IMG>"), "nothing changed");
  state.layer = { ...state.layer!, revision: 2 };
  assert.ok((await frame()).includes("<IMG>"), "new video frame");
  state.layer = { ...state.layer!, rect: { x: 11, y: 1, w: 40, h: 10 } };
  assert.ok((await frame()).includes("<IMG>"), "rectangle moved");
  state.band = "band-b";
  assert.ok((await frame()).includes("<IMG>"), "text under the picture was rewritten");
  assert.ok(!(await frame()).includes("<IMG>"), "and then it settles");
});

test("brings the picture back after it was hidden, after a clear, and after the window is resized", async () => {
  const { inner, state, terminal } = layered();
  const frame = async () => { terminal.write(`${SYNC_START}f${SYNC_END}`); await tick(); return inner.writes.at(-1) ?? ""; };
  await frame();
  const visible = state.layer;
  state.layer = null;
  assert.ok(!(await frame()).includes("<IMG>"), "hidden while a panel covers it");
  state.layer = visible;
  assert.ok((await frame()).includes("<IMG>"), "back when the panel closes");
  assert.ok(!(await frame()).includes("<IMG>"));
  terminal.clearScreen();
  assert.ok((await frame()).includes("<IMG>"), "after a screen clear");
  assert.ok(!(await frame()).includes("<IMG>"));
  terminal.force();
  assert.ok((await frame()).includes("<IMG>"), "when asked, for example when the window regains focus");
});

test("draws the picture again when the window regains focus, and still passes the key on", async () => {
  const { inner, terminal } = layered();
  const received: string[] = [];
  terminal.start((data) => received.push(data), () => undefined);
  terminal.write(`${SYNC_START}f${SYNC_END}`);
  await tick();
  terminal.write(`${SYNC_START}f${SYNC_END}`);
  await tick();
  assert.ok(!(inner.writes.at(-1) ?? "").includes("<IMG>"), "settled");
  inner.send(String.fromCharCode(27) + "[I");
  await tick();
  assert.ok((inner.writes.at(-1) ?? "").includes("<IMG>"), "the picture is sent again without waiting for pi-tui");
  assert.deepEqual(received, [String.fromCharCode(27) + "[I"]);
});

test("playback gives a still frame, then streams frames while playing, and stops when disposed", { timeout: 60_000 }, async () => {
  const project = await makeProject();
  try {
    const media = project.state.media;
    const rect = { columns: 60, rows: 12 };
    const size = previewRenderSize(media, rect.columns, rect.rows, "sixel");
    const direct = await extractRawFrame(project.store.current.filePath, 1, size);
    assert.equal(direct.length, size.width * size.height * 3);

    const frames: PlaybackFrame[] = [];
    let ended = 0;
    const errors: Error[] = [];
    const playback = new PlaybackController({
      onFrame: (frame) => frames.push(frame), onEnd: () => { ended += 1; }, onError: (error) => errors.push(error),
    });
    const input = { filePath: project.store.current.filePath, media, columns: rect.columns, rows: rect.rows, backend: "sixel" as const, playing: false, time: 1 };
    playback.update(input);
    await waitFor(() => frames.length > 0);
    assert.equal(frames[0]?.time, 1);
    assert.match(frames[0]?.encoded ?? "", /^\x1bP[\d;]*q/, "a Sixel picture");
    assert.deepEqual(frames[0]?.size, size);

    const still = frames.length;
    playback.update({ ...input });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(frames.length, still, "the same input does not start the work again");

    playback.update({ ...input, playing: true, time: 0 });
    await waitFor(() => frames.length > still + 2);
    assert.ok(frames.at(-1)!.time >= 0);
    await waitFor(() => ended === 1, 20_000);
    assert.deepEqual(errors, []);

    playback.update({ ...input, time: 2 });
    await waitFor(() => frames.at(-1)?.time === 2);
    playback.update({ ...input, playing: true, time: 2 });
    const resumed = frames.length;
    await waitFor(() => frames.length > resumed + 1);
    const before = frames.length;
    playback.dispose();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(frames.length - before <= 1, "no frames after dispose");
    assert.equal(ended, 1, "disposing is not the same as reaching the end");
  } finally {
    await project.cleanup();
  }
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("audio plays only while the preview plays, and a burst of volume changes restarts it once", async () => {
  const started: Array<[number, number]> = [];
  let stopped = 0;
  const audio = new AudioController(() => undefined, {
    spawn: (_file, start, volume) => { started.push([start, volume]); return {} as never; },
    terminate: (child) => { if (child) stopped += 1; },
    debounceMs: 30,
  });
  const base = { filePath: "a.mp4", hasAudio: true, start: 2, volume: 70 };
  audio.update({ ...base, playing: false });
  assert.deepEqual(started, [], "nothing plays while paused");
  audio.update({ ...base, playing: true });
  assert.deepEqual(started, [[2, 70]]);
  audio.update({ ...base, playing: true, volume: 75, start: 3 });
  audio.update({ ...base, playing: true, volume: 80, start: 4 });
  assert.equal(started.length, 1, "waits for the volume to settle");
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.deepEqual(started.at(-1), [4, 80], "restarts once, from the current position, at the final volume");
  assert.equal(stopped, 1);
  audio.update({ ...base, volume: 80, start: 5, playing: false });
  assert.equal(stopped, 2, "pausing stops the sound");
  audio.update({ ...base, hasAudio: false, playing: true });
  assert.equal(started.length, 2, "a video without a sound track plays nothing");
  audio.dispose();
});

test("the preview host paints each new picture in the video rectangle, and hides it on request", async () => {
  const inner = new FakeTerminal(80, 24);
  let visible = true;
  const host = new PreviewHost(inner, { visible: () => visible, rect: () => ({ x: 0, y: 1, w: 80, h: 10 }), screenLines: () => [] });
  const frame = { encoded: STUB_SIXEL, size: { width: 400, height: 200 }, backend: "sixel" as const };
  host.setFrame(frame);
  await tick();
  assert.deepEqual(sixelPlacements(inner.writes.join("")), [[2, 21]], "centred: 40 columns wide in 80");
  const mark = inner.mark();
  host.setFrame(frame);
  await tick();
  assert.equal(sixelPlacements(inner.since(mark)).length, 1, "a new picture is painted at once, without a pi-tui frame");
  const again = inner.mark();
  host.repaint();
  await tick();
  assert.equal(sixelPlacements(inner.since(again)).length, 1, "repaint draws it again");
  visible = false;
  const hidden = inner.mark();
  host.setFrame(frame);
  await tick();
  assert.equal(sixelPlacements(inner.since(hidden)).length, 0, "not drawn while a panel covers it");
  visible = true;
  host.clear();
  host.terminal.write("x");
  await tick();
  assert.equal(sixelPlacements(inner.since(hidden)).length, 0, "nothing to draw after clear");
});
```

Add `shell-preview` to the `test` script:

```diff
--- a/package.json
+++ b/package.json
@@ -17,7 +17,7 @@
     "build": "tsup",
     "check": "tsc --noEmit",
     "dev": "tsx src/cli.tsx",
-    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/shell-layout.test.js .test-dist/tests/shell-state.test.js .test-dist/tests/shell-keymap.test.js .test-dist/tests/transcription.test.js",
+    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/shell-layout.test.js .test-dist/tests/shell-state.test.js .test-dist/tests/shell-keymap.test.js .test-dist/tests/shell-preview.test.js .test-dist/tests/transcription.test.js",
     "quality": "npm run check && npm test && npm run build",
     "release:check": "npm run quality && npm pack --dry-run",
     "prepublishOnly": "npm run quality"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL with `Cannot find module` for `video-layer`, `layered-terminal`, `playback`, `audio` and `preview-host` under `src/shell/preview/`.

- [ ] **Step 3: Write the implementation**

How it works: pi-tui draws text only, so the picture is a separate layer. `LayeredTerminal` holds each frame pi-tui writes for one microtask (so pi-tui has updated its copy of the screen), then writes the frame and the layer as one synchronized update, and sends the layer again only when the picture, its rectangle, or the text rows under it changed. The cursor is never hidden, because the composer's cursor must stay visible. The real Sixel encoder starts with `ESC P 0;1;0 q`, not `ESC P q`, so the tests match `ESC P` followed by digits and semicolons.

Create `src/shell/preview/video-layer.ts`:

```typescript
import type { PreviewBackend, PreviewSize } from "../../core/media.js";

/** A rectangle in terminal cells, 0-based from the top-left of the screen. */
export interface CellRect { x: number; y: number; w: number; h: number }

export interface EncodedFrame {
  /** A Sixel image, or for the block backend, text rows separated by newlines. */
  encoded: string;
  size: PreviewSize;
  backend: PreviewBackend;
}

/**
 * The escape sequences that paint one picture inside the video rectangle: save the cursor, move, draw, restore.
 * The cursor is never hidden, because the composer's cursor must stay visible.
 */
export function buildVideoLayer(frame: EncodedFrame, rect: CellRect): string {
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

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
```

Create `src/shell/preview/layered-terminal.ts`:

```typescript
import type { Terminal } from "@earendil-works/pi-tui";
import type { CellRect } from "./video-layer.js";

const SYNC_START = "\u001B[?2026h";
const SYNC_END = "\u001B[?2026l";
const FOCUS_IN = "\u001B[I";

export interface VideoLayer {
  rect: CellRect;
  /** Changes whenever there is a new picture to show. */
  revision: number;
  /** The escape sequences that paint the picture (see buildVideoLayer). */
  output: string;
}

export interface LayerHooks {
  /** The picture to show now, or null when nothing should be drawn (no video, or a panel covers it). */
  layer(): VideoLayer | null;
  /** The text currently drawn in the rows of the rectangle, used to notice when something may have erased the picture. */
  bandText(rect: CellRect): string;
  onResize?(): void;
}

/**
 * Wraps the terminal pi-tui draws on. pi-tui writes text only, so the video is a separate layer: each frame
 * is held for one microtask (so pi-tui has updated its copy of the screen), then written together with the
 * layer as one synchronized update. The layer is sent again only when something could have erased it.
 */
export class LayeredTerminal implements Terminal {
  private pending: string[] = [];
  private scheduled = false;
  private forced = true;
  private lastKey: string | null = null;

  constructor(private readonly inner: Terminal, private readonly hooks: LayerHooks) {}

  get columns(): number { return this.inner.columns; }
  get rows(): number { return this.inner.rows; }
  get kittyProtocolActive(): boolean { return this.inner.kittyProtocolActive; }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inner.start((data) => {
      // Windows Terminal can drop Sixel images when its window regains focus; pi-tui swallows the focus
      // report, so watch for it here and draw the picture again.
      if (data === FOCUS_IN) { this.forced = true; this.schedule(); }
      onInput(data);
    }, () => { this.forced = true; this.hooks.onResize?.(); onResize(); });
  }
  stop(): void { this.inner.stop(); }
  drainInput(maxMs?: number, idleMs?: number): Promise<void> { return this.inner.drainInput(maxMs, idleMs); }
  moveBy(lines: number): void { this.inner.moveBy(lines); }
  hideCursor(): void { this.inner.hideCursor(); }
  showCursor(): void { this.inner.showCursor(); }
  clearLine(): void { this.inner.clearLine(); }
  clearFromCursor(): void { this.inner.clearFromCursor(); }
  clearScreen(): void { this.forced = true; this.inner.clearScreen(); }
  setTitle(title: string): void { this.inner.setTitle(title); }
  setProgress(active: boolean): void { this.inner.setProgress(active); }

  /** Send the picture with the next frame, for example because the window regained focus and may have dropped it. */
  force(): void { this.forced = true; }

  write(data: string): void {
    this.pending.push(data);
    this.schedule();
  }

  /** Draw the picture now even though pi-tui has nothing to draw, for example for a new video frame. */
  paint(): void { this.schedule(); }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.scheduled = false;
    const data = this.pending.join("");
    this.pending = [];
    const layer = this.hooks.layer();
    if (!layer) {
      if (this.lastKey !== null) { this.lastKey = null; this.forced = true; }
      if (data) this.inner.write(data);
      return;
    }
    const key = `${layer.rect.x},${layer.rect.y},${layer.rect.w},${layer.rect.h}|${layer.revision}|${this.hooks.bandText(layer.rect)}`;
    if (!this.forced && key === this.lastKey) {
      if (data) this.inner.write(data);
      return;
    }
    this.lastKey = key;
    this.forced = false;
    this.inner.write(data.endsWith(SYNC_END)
      ? `${data.slice(0, -SYNC_END.length)}${layer.output}${SYNC_END}`
      : `${SYNC_START}${data}${layer.output}${SYNC_END}`);
  }
}
```

Create `src/shell/preview/playback.ts`:

```typescript
import {
  encodePreviewFrame, extractRawFrame, previewRenderSize, streamRawPreview,
  type PreviewBackend, type PreviewSize, type PreviewStream,
} from "../../core/media.js";
import type { MediaInfo } from "../../types.js";
import { playbackStart } from "../input/keys.js";

export interface PlaybackInput {
  filePath: string | null | undefined;
  media: MediaInfo | null;
  /** Room for the picture, in terminal cells. */
  columns: number;
  rows: number;
  backend: PreviewBackend;
  playing: boolean;
  /** Where to show a still frame, or where playing starts. */
  time: number;
}

export interface PlaybackFrame {
  encoded: string;
  size: PreviewSize;
  backend: PreviewBackend;
  time: number;
}

export interface PlaybackCallbacks {
  onFrame(frame: PlaybackFrame): void;
  /** The video played to its end. Not called when playback is stopped or replaced. */
  onEnd(): void;
  onError(error: Error): void;
}

/**
 * Turns "what should the preview show" into pictures. While paused it shows one frame at the playhead; while
 * playing it streams frames from FFmpeg. Calling `update` again with the same input does nothing, so it can be
 * called on every state change.
 */
export class PlaybackController {
  private key = "";
  private generation = 0;
  private stopCurrent: () => void = () => undefined;
  private pending: { buffer: Buffer; time: number } | null = null;
  private draining = false;

  constructor(private readonly callbacks: PlaybackCallbacks) {}

  update(input: PlaybackInput): void {
    const key = JSON.stringify([input.filePath, input.media?.duration, input.media?.width, input.media?.height, input.columns, input.rows, input.backend, input.playing, input.playing ? null : input.time]);
    if (key === this.key) return;
    this.key = key;
    this.stop();
    const { filePath, media } = input;
    if (!filePath || !media) return;
    const size = previewRenderSize(media, input.columns, input.rows, input.backend);
    if (size.width === 0 || size.height === 0) return;
    const generation = this.generation;
    const deliver = (buffer: Buffer, time: number) => this.queue(generation, buffer, time, size, input.backend);

    if (!input.playing) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        void extractRawFrame(filePath, input.time, size, controller.signal)
          .then((frame) => deliver(frame, input.time))
          .catch((error: unknown) => { if (!controller.signal.aborted && generation === this.generation) this.callbacks.onError(toError(error)); });
      }, 40);
      this.stopCurrent = () => { clearTimeout(timer); controller.abort(); };
      return;
    }

    const preview: PreviewStream = streamRawPreview({
      filePath, start: playbackStart(input.time, media.duration), size, fps: input.backend === "sixel" ? 12 : 10,
      onFrame: (frame, time) => deliver(frame, Math.min(time, media.duration)),
      onEnd: () => { if (generation === this.generation) this.callbacks.onEnd(); },
      onError: (error) => { if (generation === this.generation) this.callbacks.onError(error); },
    });
    this.stopCurrent = () => preview.stop();
  }

  dispose(): void {
    this.key = "";
    this.stop();
  }

  private stop(): void {
    this.generation += 1;
    this.pending = null;
    this.stopCurrent();
    this.stopCurrent = () => undefined;
  }

  /** Keep only the newest frame while the previous one is still being encoded. */
  private queue(generation: number, buffer: Buffer, time: number, size: PreviewSize, backend: PreviewBackend): void {
    if (generation !== this.generation) return;
    this.pending = { buffer, time };
    if (this.draining) return;
    this.draining = true;
    const flush = (): void => {
      const next = this.pending;
      this.pending = null;
      if (next && generation === this.generation) {
        try {
          this.callbacks.onFrame({ encoded: encodePreviewFrame(next.buffer, size, backend), size, backend, time: next.time });
        } catch (error) {
          this.callbacks.onError(toError(error));
        }
      }
      if (this.pending && generation === this.generation) setImmediate(flush);
      else this.draining = false;
    };
    setImmediate(flush);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
```

Create `src/shell/preview/audio.ts`:

```typescript
import type { ChildProcess } from "node:child_process";
import { playAudio } from "../../core/media.js";
import { terminateProcess } from "../../core/process.js";

export interface AudioInput {
  filePath: string | undefined;
  hasAudio: boolean;
  playing: boolean;
  /** Where in the video the sound should start from. */
  start: number;
  volume: number;
}

export interface AudioDeps {
  spawn?: (filePath: string, start: number, volume: number, onError: (error: Error) => void) => ChildProcess | null;
  terminate?: (child: ChildProcess | null) => void;
  /** How long a volume change waits before the sound restarts, so a burst of key presses restarts it once. */
  debounceMs?: number;
}

/**
 * Plays the video's sound while the preview plays. ffplay cannot change volume while running, so a volume
 * change restarts it; the restart is debounced.
 */
export class AudioController {
  private child: ChildProcess | null = null;
  private key = "";
  private appliedVolume = 0;
  private latest: AudioInput | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly spawn: NonNullable<AudioDeps["spawn"]>;
  private readonly terminate: NonNullable<AudioDeps["terminate"]>;
  private readonly debounceMs: number;

  constructor(private readonly onError: (message: string) => void, deps: AudioDeps = {}) {
    this.spawn = deps.spawn ?? playAudio;
    this.terminate = deps.terminate ?? terminateProcess;
    this.debounceMs = deps.debounceMs ?? 400;
  }

  update(input: AudioInput): void {
    this.latest = input;
    const active = input.playing && input.hasAudio && Boolean(input.filePath);
    const key = `${input.filePath}|${active}`;
    if (key !== this.key) {
      this.key = key;
      this.clearTimer();
      this.stop();
      if (active) this.start(input);
      return;
    }
    if (active && input.volume !== this.appliedVolume && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        const current = this.latest;
        if (!current || !(current.playing && current.hasAudio && current.filePath)) return;
        this.stop();
        this.start(current);
      }, this.debounceMs);
      this.timer.unref();
    }
  }

  dispose(): void {
    this.clearTimer();
    this.key = "";
    this.stop();
  }

  private start(input: AudioInput): void {
    if (!input.filePath) return;
    this.appliedVolume = input.volume;
    this.child = this.spawn(input.filePath, input.start, input.volume, (error) => this.onError(`Audio preview unavailable: ${error.message}`));
  }

  private stop(): void {
    this.terminate(this.child);
    this.child = null;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
```

Create `src/shell/preview/preview-host.ts`:

```typescript
import type { Terminal } from "@earendil-works/pi-tui";
import { LayeredTerminal, type VideoLayer } from "./layered-terminal.js";
import { buildVideoLayer, type CellRect, type EncodedFrame } from "./video-layer.js";

export interface PreviewHostOptions {
  /** True when the picture should be on screen: a video is open and no panel or expanded chat covers the band. */
  visible(): boolean;
  rect(): CellRect;
  /** The rows pi-tui last drew, one string per terminal row. */
  screenLines(): string[];
  onResize?(): void;
}

/**
 * Owns the video picture. Hand `terminal` to pi-tui instead of the real terminal; new pictures are painted
 * straight away, and the picture is kept on screen across pi-tui's own redraws.
 */
export class PreviewHost {
  readonly terminal: LayeredTerminal;
  private frame: EncodedFrame | null = null;
  private revision = 0;
  private cached: { revision: number; rect: string; output: string } | null = null;

  constructor(inner: Terminal, private readonly options: PreviewHostOptions) {
    this.terminal = new LayeredTerminal(inner, {
      layer: () => this.layer(),
      bandText: (rect) => this.options.screenLines().slice(rect.y, rect.y + rect.h).join("\n"),
      ...(options.onResize ? { onResize: options.onResize } : {}),
    });
  }

  /** Show a new picture. */
  setFrame(frame: EncodedFrame): void {
    this.frame = frame;
    this.revision += 1;
    this.terminal.paint();
  }

  /** Forget the picture, for example when another video is opened. */
  clear(): void {
    this.frame = null;
    this.revision += 1;
    this.cached = null;
  }

  /** Draw the picture again, for example when the window regains focus (Windows Terminal can drop Sixel images). */
  repaint(): void {
    this.terminal.force();
    this.terminal.paint();
  }

  private layer(): VideoLayer | null {
    if (!this.frame || !this.options.visible()) return null;
    const rect = this.options.rect();
    const rectKey = `${rect.x},${rect.y},${rect.w},${rect.h}`;
    if (!this.cached || this.cached.revision !== this.revision || this.cached.rect !== rectKey) {
      this.cached = { revision: this.revision, rect: rectKey, output: buildVideoLayer(this.frame, rect) };
    }
    return { rect, revision: this.revision, output: this.cached.output };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/shell-preview.test.js
npm test
```

Expected: 8 passed in `shell-preview` (one renders real video with FFmpeg and takes about ten seconds), then the whole suite: 135 tests, 134 passed, 1 skipped (the live OpenRouter test), 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/shell tests package.json
git commit -m "feat: add the video layer, playback, sound and the preview host"
```

## Task 5: The screen: views, layout root and keys, proven with an emulated terminal

**Files:**
- Create: `src/shell/views/{style,header,timeline,controls,sidebars,transcript,composer,video-view}.ts`, `src/shell/screen.ts`, `tests/shell-views.test.ts`, `tests/shell-screen.test.ts`
- Modify: `package.json` (`test` script)

**Interfaces:**
- Consumes: everything from Tasks 1 to 4 (`ShellState`, `resolveKey`, `shellLayout`, `PreviewHost`), pi-tui's `TuiAltScreen`, `VStack`, `HStack`, `ScrollView`, `Editor`, `CombinedAutocompleteProvider`, `wrapTextWithAnsi`, `COMMANDS` (`src/core/commands.ts`).
- Produces: `createShellScreen(options: ScreenOptions): ShellScreen` with `ScreenOptions = { terminal; state; backend; commands; cwd; hooks: ScreenHooks; overlays?: (kind, context: OverlayContext) => Component | null; onLayout?: () => void }`, `ScreenHooks = { onSubmit; onInterrupt; onAbortAgent; onOpenAssets }`, `OverlayContext = { bandRows: () => number; close(): void }`; the screen exposes `tui`, `preview`, `composer`, `transcript`, `layout()`, `videoRect()`, `refresh()`, `start()`, `stop()`.
- Produces: `HeaderView`, `TimelineView`, `ControlsView`, `StatusView`, `ProjectSidebarView`, `AssetsSidebarView`, `boxed(lines, width, height)`, `assetIcon(kind)`, `MessageView`, `TranscriptView`, `Composer`, `VideoView`, and the text helpers in `style.ts` (`fitLine`, `spaceBetween`, `shorten`, `plain`, colours).

- [ ] **Step 1: Write the tests**

`shell-views` checks each view's rendered rows. `shell-screen` drives the whole screen through pi-tui against the emulated terminal, and includes the failure from the 2026-10-03 screenshot: a long pasted input, a resize, a streaming answer and a panel over the video must not move anything.

Create `tests/shell-views.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ShellState } from "../src/shell/state/shell-state.js";
import { ControlsView, StatusView } from "../src/shell/views/controls.js";
import { HeaderView } from "../src/shell/views/header.js";
import { AssetsSidebarView, ProjectSidebarView } from "../src/shell/views/sidebars.js";
import { plain, shorten, spaceBetween } from "../src/shell/views/style.js";
import { timelineBar } from "../src/shell/views/timeline.js";
import { MessageView } from "../src/shell/views/transcript.js";

const media = { path: "a.mp4", width: 1280, height: 720, duration: 20, fps: 30, hasAudio: true, formatName: "mp4" };

function stateWithProject(): ShellState {
  const state = new ShellState();
  state.setProject("Demo cut", "v0002", 5);
  state.setMedia(media);
  state.setAgentModel("glm");
  return state;
}

test("header: product name and project on the right, or what the editor is doing", () => {
  const state = stateWithProject();
  const header = new HeaderView(state);
  const idle = plain(header.render(60)[0] ?? "");
  assert.equal(idle.length, 60);
  assert.match(idle, /^DumbEditor +Demo cut · v0002$/);
  state.setLoader({ source: "glm", stage: "Rendering with FFmpeg" });
  assert.match(plain(header.render(80)[0] ?? ""), /^DumbEditor +◐ glm · Rendering with FFmpeg · video updating$/);
  state.setLoader({ source: "Sandbox", stage: "Running script" });
  assert.match(plain(header.render(80)[0] ?? ""), /◐ ⬡ SANDBOX · Running script/);
  assert.equal(visibleWidth(header.render(12)[0] ?? ""), 12, "a narrow header is cut, never wider than the screen");
});

test("play bar marks the playhead and the in and out points", () => {
  const bar = timelineBar(10, 20, { in: 5, out: 15 }, 80);
  assert.equal(bar.length, 56);
  assert.equal([...bar].filter((character) => character === "◆").length, 1);
  assert.ok(bar.includes("╞") && bar.includes("╡"));
  assert.equal(bar.indexOf("◆"), Math.round(0.5 * 55));
  assert.equal(timelineBar(0, 0, { in: null, out: null }, 80).indexOf("◆"), 0, "an empty video does not divide by zero");
});

test("controls row: play state, volume, marks and the hints that fit", () => {
  const state = stateWithProject();
  state.adjustVolume(-20);
  state.setPlayhead(8); state.setIn();
  const controls = new ControlsView(state, () => "sixel");
  const wide = plain(controls.render(130)[0] ?? "");
  assert.match(wide, /^Ⅱ paused · volume 50% · in 00:08\.0 +SIXEL · Ctrl\+P play/);
  assert.equal(wide.length, 130);
  assert.match(plain(controls.render(100)[0] ?? ""), /Ctrl\+P play · \+\/- volume/);
  state.setPlaying(true);
  assert.match(plain(controls.render(100)[0] ?? ""), /^▶ playing/);
});

test("status row: what is happening, what it costs, and which keys matter", () => {
  const state = stateWithProject();
  const status = new StatusView(state);
  assert.match(plain(status.render(160)[0] ?? ""), /^Ready · glm \$0\.0000 · Assets \$0\.0000 · Total \$0\.0000 · Enter to send · Ctrl\+C to quit/);
  state.setAgentRunning(true);
  state.setLoader({ source: "glm", stage: "Thinking" });
  assert.match(plain(status.render(160)[0] ?? ""), /glm is working .* Enter steers · Esc stops/);
  state.setAgentRunning(false);
  state.setLoader({ source: "Editor", stage: "Saving new version" });
  assert.match(plain(status.render(160)[0] ?? ""), /video updating · ↑\/↓ chat/);
});

test("project sidebar: boxed to its size, current version marked, extra versions counted", () => {
  const state = stateWithProject();
  state.setVersions(Array.from({ length: 12 }, (_, index) => ({ id: `v${String(11 - index).padStart(4, "0")}`, parentId: null, filePath: "x", action: `edit number ${index}`, request: "", createdAt: "", duration: 10 })) as never, "v0009");
  const sidebar = new ProjectSidebarView(state, () => 20);
  const lines = sidebar.render(24).map(plain);
  assert.equal(lines.length, 20);
  assert.ok(lines.every((line) => visibleWidth(line) === 24), "every row is exactly the sidebar width");
  assert.match(lines[0] ?? "", /^┌─+┐$/);
  assert.match(lines[19] ?? "", /^└─+┘$/);
  const text = lines.join("\n");
  assert.match(text, /● v0009/);
  assert.match(text, /○ v0011/);
  assert.match(text, /\+\d+ more/);
  assert.match(text, /Permissions: ask/);
});

test("assets sidebar: newest first with costs, or a hint when empty", () => {
  const state = stateWithProject();
  const sidebar = new AssetsSidebarView(state, () => 12);
  assert.match(sidebar.render(26).map(plain).join("\n"), /No assets yet/);
  state.setAssets([
    { id: "a1", kind: "image", description: "A blue title card", path: "p", source: "generated", costUsd: 0.04 },
    { id: "a2", kind: "music", description: "Calm piano", path: "q", source: "catalog" },
  ] as never);
  const text = sidebar.render(40).map(plain).join("\n");
  assert.ok(text.indexOf("Calm piano") < text.indexOf("A blue title card"), "newest first");
  assert.match(text, /♪ Calm piano +—/);
  assert.match(text, /▧ A blue title card +\$0\.04/);
});

test("a message shows who said it and wraps under its label with the markdown tidied", () => {
  const user = new MessageView({ id: "1", role: "user", text: "remove the first two seconds", live: false }, () => "glm");
  assert.equal(plain(user.render(80)[0] ?? ""), "you › remove the first two seconds");
  const agent = new MessageView({ id: "2", role: "assistant", text: "**Done.** I removed `0-2s`.\n- first item\n- second item", live: false }, () => "glm");
  assert.deepEqual(agent.render(80).map(plain), ["glm › Done. I removed 0-2s.", "    │ • first item", "    │ • second item"]);
  const long = new MessageView({ id: "3", role: "assistant", text: "word ".repeat(30).trim(), label: "tool", live: false }, () => "glm").render(30).map(plain);
  assert.ok(long.length > 2 && long.every((line) => visibleWidth(line) <= 30));
  assert.ok(long[0]?.startsWith("tool › ") && long[1]?.startsWith("     │ "));
});

test("text helpers cut and join without exceeding the width", () => {
  assert.equal(shorten("  a   lot    of   space  ", 40), "a lot of space");
  assert.equal(shorten("abcdefghij", 5), "abcd…");
  assert.equal(spaceBetween("left", "right", 14), "left     right");
  assert.equal(visibleWidth(spaceBetween("a long left side", "right", 12)), 12);
});
```

Create `tests/shell-screen.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { COMMANDS } from "../src/core/commands.js";
import { createShellScreen, type ShellScreen } from "../src/shell/screen.js";
import { ShellState } from "../src/shell/state/shell-state.js";
import { FakeTerminal, sixelPlacements, STUB_SIXEL } from "./helpers/fake-terminal.js";

const KEY = { ctrlC: "\x03", ctrlG: "\x07", ctrlO: "\x0f", ctrlP: "\x10", esc: "\x1b", left: "\x1b[D", right: "\x1b[C", enter: "\r" };
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

class StubPanel implements Component {
  keys: string[] = [];
  constructor(private readonly rows: () => number) {}
  render(width: number): string[] {
    return Array.from({ length: this.rows() }, (_, index) => (index === 1 ? "STUB PANEL".padEnd(width) : " ".repeat(width)));
  }
  handleInput(data: string): void { this.keys.push(data); }
  invalidate(): void { /* stateless */ }
}

async function boot(columns = 120, rows = 40) {
  const fake = new FakeTerminal(columns, rows);
  const state = new ShellState();
  state.setProject("demo", "v0000");
  state.setMedia({ path: "demo.mp4", width: 1280, height: 720, duration: 20, fps: 30, hasAudio: true, formatName: "mp4" });
  state.setAgentModel("glm");
  const calls = { submitted: [] as string[], interrupt: 0, abort: 0, assets: 0 };
  const panels: StubPanel[] = [];
  const screen: ShellScreen = createShellScreen({
    terminal: fake, state, backend: "sixel", commands: COMMANDS, cwd: process.cwd(),
    hooks: {
      onSubmit: (text) => calls.submitted.push(text), onInterrupt: () => { calls.interrupt += 1; },
      onAbortAgent: () => { calls.abort += 1; }, onOpenAssets: () => { calls.assets += 1; },
    },
    overlays: (_kind, context) => { const panel = new StubPanel(context.bandRows); panels.push(panel); return panel; },
  });
  screen.start();
  screen.preview.setFrame({ encoded: STUB_SIXEL, size: { width: 400, height: 200 }, backend: "sixel" });
  await fake.settle();
  const band = () => fake.screen().slice(0, screen.layout().bandRows + 1);
  return { fake, state, screen, calls, panels, band };
}
const typeText = async (fake: FakeTerminal, text: string) => { for (const character of text) { fake.send(character); await new Promise((resolve) => setTimeout(resolve, 6)); } await fake.settle(); };

test("draws the header, the video band, the play bar, the hints, the chat area and the status row", async () => {
  const { fake, screen } = await boot();
  const rows = fake.screen();
  assert.match(rows[0] ?? "", /^DumbEditor\s+demo · v0000$/);
  const { bandRows } = screen.layout();
  assert.match(rows[bandRows + 1] ?? "", /00:00.0 .*00:20.0/, "play bar under the video");
  assert.match(rows[bandRows + 2] ?? "", /Ⅱ paused · volume 70%/);
  assert.match(rows[39] ?? "", /^Ready · glm \$0\.0000/);
  assert.deepEqual(sixelPlacements(fake.writes.join("")).at(-1), [2, 41], "the picture is centred in the band, under the header");
  screen.stop();
});

test("a long pasted input grows the composer without moving the band or repainting the video", async () => {
  const { fake, screen, band } = await boot();
  const before = band();
  const mark = fake.mark();
  fake.send(paste("describe the video cd C:\\Users\\SHREYASH KUMAR SINGH\\Desktop ".repeat(12)));
  await fake.settle();
  assert.deepEqual(band(), before, "header, panels and video rows stay exactly where they were");
  assert.match(fake.screen()[39] ?? "", /^Ready/, "the status row stays last");
  const composerRows = fake.screen().filter((line) => /describe the video|C:\\Users|SINGH/.test(line)).length;
  assert.ok(composerRows >= 4, `composer grew to ${composerRows} rows`);
  const out = fake.since(mark);
  assert.equal(sixelPlacements(out).length, 0, "the video was not repainted");
  assert.ok(!out.includes("\x1b[2J"), "no full-screen clear");
  screen.stop();
});

test("typing never repaints the video", async () => {
  const { fake, screen } = await boot();
  const mark = fake.mark();
  await typeText(fake, "remove the last two seconds please");
  assert.equal(sixelPlacements(fake.since(mark)).length, 0);
  assert.match(fake.screen().join("\n"), /remove the last two seconds please/);
  screen.stop();
});

test("resizing keeps the layout consistent and puts the video at the new rectangle", async () => {
  const { fake, screen } = await boot();
  for (const [columns, rows] of [[80, 24], [160, 50], [100, 30], [120, 40]] as const) {
    const mark = fake.mark();
    fake.resize(columns, rows);
    await fake.settle();
    const screenRows = fake.screen();
    assert.match(screenRows[rows - 1] ?? "", /^Ready/, `${columns}x${rows}: status row`);
    assert.match(screenRows[0] ?? "", /^DumbEditor/, `${columns}x${rows}: header row`);
    const rect = screen.videoRect();
    const image = Math.ceil(400 / 10);
    assert.deepEqual(sixelPlacements(fake.since(mark)).at(-1), [rect.y + 1, rect.x + Math.floor((rect.w - image) / 2) + 1], `${columns}x${rows}: video placement`);
    assert.ok(screenRows.every((line) => line.length <= columns), `${columns}x${rows}: no row wider than the screen`);
    if (columns >= 130) {
      assert.match(screenRows[1] ?? "", /^┌─+┐/, "left sidebar");
      assert.match(screenRows[1] ?? "", /┌─+┐\s*$/, "right sidebar");
    }
  }
  screen.stop();
});

test("streaming 200 messages into the chat leaves the band and the video alone and follows the end", async () => {
  const { fake, state, screen, band } = await boot();
  const before = band();
  const mark = fake.mark();
  for (let index = 1; index <= 200; index += 1) {
    state.addMessage("assistant", `line ${index} from the agent`, "glm");
    if (index % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await fake.settle();
  assert.deepEqual(band(), before);
  assert.ok(fake.screen().some((line) => line.includes("line 200 from the agent")), "the newest line is visible");
  assert.equal(sixelPlacements(fake.since(mark)).length, 0);
  screen.stop();
});

test("a panel replaces the band, takes the keys, hides the video, and returns it once when it closes", async () => {
  const { fake, state, screen, panels } = await boot();
  state.openOverlay("help");
  await fake.settle();
  assert.ok(fake.screen().some((line) => line.includes("STUB PANEL")), "panel shown in the band");
  const mark = fake.mark();
  screen.preview.setFrame({ encoded: STUB_SIXEL, size: { width: 400, height: 200 }, backend: "sixel" });
  fake.send("x");
  await fake.settle();
  assert.deepEqual(panels[0]?.keys, ["x"], "the panel gets the key");
  assert.equal(screen.composer.text, "", "and the composer does not");
  assert.equal(sixelPlacements(fake.since(mark)).length, 0, "no video over a panel");
  const closing = fake.mark();
  state.closeOverlay();
  await fake.settle();
  assert.ok(!fake.screen().some((line) => line.includes("STUB PANEL")));
  assert.equal(sixelPlacements(fake.since(closing)).length, 1, "the video comes back once");
  fake.send("y");
  await fake.settle();
  assert.equal(screen.composer.text, "y", "the composer has the keys again");
  screen.stop();
});

test("Ctrl+G gives the whole body to the chat and Escape brings the band back", async () => {
  const { fake, state, screen } = await boot();
  state.addMessage("user", "hello");
  fake.send(KEY.ctrlG);
  await fake.settle();
  assert.equal(state.chatExpanded, true);
  assert.match(fake.screen()[1] ?? "", /you › hello/, "the chat starts right under the header");
  const mark = fake.mark();
  fake.send(KEY.esc);
  await fake.settle();
  assert.equal(state.chatExpanded, false);
  assert.match(fake.screen()[screen.layout().bandRows + 1] ?? "", /00:00/, "the play bar is back");
  assert.equal(sixelPlacements(fake.since(mark)).length, 1, "and so is the video");
  screen.stop();
});

test("while an export runs typing is blocked but the play keys still work", async () => {
  const { fake, state, screen } = await boot();
  state.setLoader({ source: "Editor", stage: "Preparing export" });
  await fake.settle();
  fake.send("a");
  fake.send(KEY.right);
  await fake.settle();
  assert.equal(screen.composer.text, "", "typing is blocked");
  assert.equal(state.playhead, 5, "seeking still works");
  state.setLoader(null);
  fake.send("b");
  await fake.settle();
  assert.equal(screen.composer.text, "b");
  screen.stop();
});

test("global keys: play, seek, marks, volume, assets, stop and interrupt", async () => {
  const { fake, state, screen, calls } = await boot();
  fake.send(KEY.ctrlP); await fake.settle();
  assert.equal(state.playing, true);
  fake.send(KEY.right); fake.send(KEY.right); fake.send("["); fake.send(KEY.right); fake.send("]"); fake.send("-"); await fake.settle();
  assert.deepEqual([state.playing, state.playhead, state.selection, state.volume], [false, 15, { in: 10, out: 15 }, 65]);
  fake.send(KEY.ctrlO); fake.send(KEY.ctrlC); await fake.settle();
  assert.deepEqual([calls.assets, calls.interrupt], [1, 1]);
  state.setAgentRunning(true);
  fake.send(KEY.esc); await fake.settle();
  assert.equal(calls.abort, 1);
  await typeText(fake, "later");
  fake.send(KEY.esc); await fake.settle();
  assert.equal(screen.composer.text, "", "Escape clears what was typed before it stops the agent");
  screen.stop();
});

test("Enter sends the typed line and empties the composer", async () => {
  const { fake, screen, calls } = await boot();
  await typeText(fake, "trim the intro");
  fake.send(KEY.enter);
  await fake.settle();
  assert.deepEqual(calls.submitted, ["trim the intro"]);
  assert.equal(screen.composer.text, "");
  screen.stop();
});

test("typing a slash lists the commands, and text the agent never read comes back to the composer", async () => {
  const { fake, state, screen } = await boot();
  fake.send("/");
  await fake.settle(200);
  assert.match(fake.screen().join("\n"), /clip-remove/, "slash commands are offered");
  fake.send(KEY.esc);
  screen.composer.clear();
  await fake.settle();
  state.restoreComposerText("make it red");
  await fake.settle();
  assert.equal(screen.composer.text, "make it red");
  screen.stop();
});

test("a very small terminal still draws every row within its width, and a regained window focus repaints the video", async () => {
  const { fake, screen } = await boot(50, 14);
  for (const [columns, rows] of [[50, 14], [40, 10], [30, 8], [200, 60]] as const) {
    fake.resize(columns, rows);
    await fake.settle();
    const screenRows = fake.screen();
    assert.equal(screenRows.length, rows);
    assert.match(screenRows[0] ?? "", /^DumbEditor/, `${columns}x${rows}: header`);
    assert.ok(screenRows.every((line) => line.length <= columns), `${columns}x${rows}: no row wider than the screen`);
  }
  const mark = fake.mark();
  fake.send("[I");
  await fake.settle();
  assert.equal(sixelPlacements(fake.since(mark)).length, 1, "the picture is drawn again when the window regains focus");
  assert.equal(screen.composer.text, "", "and the focus report is not typed");
  screen.stop();
});
```

Add both to the `test` script:

```diff
--- a/package.json
+++ b/package.json
@@ -17,7 +17,7 @@
     "build": "tsup",
     "check": "tsc --noEmit",
     "dev": "tsx src/cli.tsx",
-    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/shell-layout.test.js .test-dist/tests/shell-state.test.js .test-dist/tests/shell-keymap.test.js .test-dist/tests/shell-preview.test.js .test-dist/tests/transcription.test.js",
+    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/shell-layout.test.js .test-dist/tests/shell-state.test.js .test-dist/tests/shell-keymap.test.js .test-dist/tests/shell-preview.test.js .test-dist/tests/shell-views.test.js .test-dist/tests/shell-screen.test.js .test-dist/tests/transcription.test.js",
     "quality": "npm run check && npm test && npm run build",
     "release:check": "npm run quality && npm pack --dry-run",
     "prepublishOnly": "npm run quality"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL with `Cannot find module` for `src/shell/screen.js` and the files under `src/shell/views/`.

- [ ] **Step 3: Write the implementation**

Notes: the band (sidebars and video, or an open panel) has a fixed height from `shellLayout`, so the video never moves when the composer grows; the composer is pi-tui's `Editor`, which grows and then scrolls inside itself (it caps its visible lines at 30% of the terminal, minimum 5). `Ctrl+G` rebuilds the layout without the band so the chat takes the whole body. Typing is blocked while an export or render runs (`state.busy`), but the agent never blocks typing.

Create `src/shell/views/style.ts`:

```typescript
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const wrap = (open: number, close: number) => (text: string): string => `\u001B[${open}m${text}\u001B[${close}m`;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const inverse = wrap(7, 27);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);

/** Cut to the width (without an ellipsis marker when it already fits) and pad with spaces to exactly that width. */
export function fitLine(text: string, width: number): string {
  const cut = visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

/** Put `left` and `right` on one line of exactly `width` columns, dropping the right side first when it does not fit. */
export function spaceBetween(left: string, right: string, width: number): string {
  const free = width - visibleWidth(left) - visibleWidth(right);
  if (free >= 1) return `${left}${" ".repeat(free)}${right}`;
  return fitLine(left, width);
}

/** Collapse whitespace and cut a value to a number of characters, ending in an ellipsis when cut. */
export function shorten(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(1, limit - 1))}…`;
}

/** Remove escape sequences, for tests and for measuring. */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]|\u001B\][^\u0007]*\u0007|\u001B_[^\u001B]*\u001B\\/g, "");
}
```

Create `src/shell/views/header.ts`:

```typescript
import type { Component } from "@earendil-works/pi-tui";
import type { ShellState } from "../state/shell-state.js";
import { bold, cyan, dim, fitLine, magenta, spaceBetween, yellow } from "./style.js";

const LOADER_MARK = "◐";

/** One row: the product name on the left, what the editor is doing (or the project and version) on the right. */
export class HeaderView implements Component {
  constructor(private readonly state: ShellState) {}

  render(width: number): string[] {
    const { loader } = this.state;
    const right = loader
      ? (loader.source === "Sandbox" ? cyan : yellow)(`${LOADER_MARK} ${loader.source === "Sandbox" ? "⬡ SANDBOX" : loader.source} · ${loader.stage}${this.state.videoMutationActive ? " · video updating" : ""}`)
      : dim(this.state.projectName ? `${this.state.projectName} · ${this.state.versionId}` : "No video");
    return [fitLine(spaceBetween(bold(magenta("DumbEditor")), right, width), width)];
  }

  invalidate(): void { /* stateless */ }
}
```

Create `src/shell/views/timeline.ts`:

```typescript
import type { Component } from "@earendil-works/pi-tui";
import { formatTime } from "../../core/time.js";
import type { Selection } from "../../types.js";
import type { ShellState } from "../state/shell-state.js";
import { cyan, fitLine, gray } from "./style.js";

/** The play bar: time, a line with the playhead and the in/out marks, and the length. Centred under the video. */
export class TimelineView implements Component {
  constructor(private readonly state: ShellState, private readonly geometry: () => { leftPad: number; videoColumns: number }) {}

  render(width: number): string[] {
    const { media, playhead, selection } = this.state;
    if (!media) return [fitLine("", width)];
    const { leftPad, videoColumns } = this.geometry();
    const bar = timelineBar(playhead, media.duration, selection, videoColumns);
    const text = `${cyan(formatTime(playhead))} ${gray(bar)} ${gray(formatTime(media.duration))}`;
    const plainWidth = formatTime(playhead).length + bar.length + formatTime(media.duration).length + 2;
    const indent = leftPad + Math.max(0, Math.floor((videoColumns - plainWidth) / 2));
    return [fitLine(`${" ".repeat(indent)}${text}`, width)];
  }

  invalidate(): void { /* stateless */ }
}

export function timelineBar(current: number, duration: number, selection: Selection, columns: number): string {
  const length = Math.max(18, Math.min(90, columns - 24));
  const cursor = position(current, duration, length);
  const inPoint = selection.in === null ? -1 : position(selection.in, duration, length);
  const outPoint = selection.out === null ? -1 : position(selection.out, duration, length);
  let bar = "";
  for (let index = 0; index < length; index += 1) {
    if (index === cursor) bar += "◆";
    else if (index === inPoint) bar += "╞";
    else if (index === outPoint) bar += "╡";
    else if (index < cursor) bar += "━";
    else bar += "─";
  }
  return bar;
}

function position(value: number, duration: number, width: number): number {
  if (duration <= 0) return 0;
  return Math.max(0, Math.min(width - 1, Math.round((value / duration) * (width - 1))));
}
```

Create `src/shell/views/controls.ts`:

```typescript
import type { Component } from "@earendil-works/pi-tui";
import { formatTime } from "../../core/time.js";
import { formatUsd } from "../../core/usage.js";
import type { ShellState } from "../state/shell-state.js";
import { dim, fitLine, spaceBetween } from "./style.js";

/** The row under the timeline: play state, volume and marks on the left, key hints on the right. */
export class ControlsView implements Component {
  constructor(private readonly state: ShellState, private readonly backend: () => string) {}

  render(width: number): string[] {
    const { playing, volume, selection } = this.state;
    const left = `${playing ? "▶ playing" : "Ⅱ paused"} · volume ${volume}%${selection.in !== null ? ` · in ${formatTime(selection.in)}` : ""}${selection.out !== null ? ` · out ${formatTime(selection.out)}` : ""}`;
    const hint = width >= 120
      ? `${this.backend().toUpperCase()} · Ctrl+P play · ←/→ 5s · +/- volume · ↑/↓ chat · Ctrl+G focus`
      : "Ctrl+P play · +/- volume · ↑/↓ chat · Ctrl+G focus";
    return [fitLine(dim(spaceBetween(left, hint, width)), width)];
  }

  invalidate(): void { /* stateless */ }
}

/** The bottom row: status, what has been spent, and the keys that matter right now. */
export class StatusView implements Component {
  constructor(private readonly state: ShellState) {}

  render(width: number): string[] {
    const { loader, usage, agentModel, agentRunning, videoMutationActive, status } = this.state;
    const costs = `${agentModel} ${formatUsd(usage.lunaUsd)} · Assets ${formatUsd(usage.assetUsd)} · Total ${formatUsd(usage.totalUsd)}`;
    const text = loader
      ? `${loader.source} is working · ${costs} · ${agentRunning ? "Enter steers · Esc stops" : videoMutationActive ? "video updating · ↑/↓ chat" : "↑/↓ chat · ←/→ seek · Ctrl+P play"}`
      : `${status} · ${costs} · Enter to send · Ctrl+C to quit`;
    return [fitLine(dim(text), width)];
  }

  invalidate(): void { /* stateless */ }
}
```

Create `src/shell/views/sidebars.ts`:

```typescript
import type { Component } from "@earendil-works/pi-tui";
import type { AgentAsset } from "../../core/agent-workspace.js";
import { formatUsd } from "../../core/usage.js";
import type { ShellState } from "../state/shell-state.js";
import { bold, cyan, dim, fitLine, gray, green, magenta, shorten, yellow } from "./style.js";

export function assetIcon(kind: AgentAsset["kind"]): string {
  if (kind === "image") return "▧";
  if (kind === "video") return "▶";
  if (kind === "audio" || kind === "music") return "♪";
  return "≡";
}

/** Draw lines inside a single-line box exactly `width` wide and `height` tall. */
export function boxed(lines: string[], width: number, height: number): string[] {
  const inner = Math.max(1, width - 2);
  const content = Math.max(1, inner - 2);
  const top = gray(`┌${"─".repeat(inner)}┐`);
  const bottom = gray(`└${"─".repeat(inner)}┘`);
  const rows: string[] = [];
  for (let index = 0; index < Math.max(0, height - 2); index += 1) {
    rows.push(`${gray("│")} ${fitLine(lines[index] ?? "", content)} ${gray("│")}`);
  }
  return [top, ...rows, bottom].slice(0, Math.max(2, height));
}

/** Left of the video: project name, model, spend, and the version list. */
export class ProjectSidebarView implements Component {
  constructor(private readonly state: ShellState, private readonly bandRows: () => number) {}

  render(width: number): string[] {
    const { state } = this;
    const height = this.bandRows();
    const room = Math.max(1, height - 13);
    const inner = Math.max(1, width - 4);
    const visible = state.versions.slice(0, room);
    const lines = [
      bold(cyan("Project")),
      shorten(state.projectName ?? "No project", inner),
      shorten(state.agentModel, inner),
      dim(`Permissions: ${state.permissionMode}`),
      yellow(shorten(`${state.agentModel} ${formatUsd(state.usage.lunaUsd)}`, inner)),
      ...(state.usage.harnessUsd > 0 ? [yellow(`Harness ${formatUsd(state.usage.harnessUsd)}`)] : []),
      dim(`Total ${formatUsd(state.usage.totalUsd)}`),
      "",
      bold(magenta("Versions")),
      ...visible.map((version) => {
        const current = version.id === state.versionId;
        const line = `${current ? "●" : "○"} ${version.id} ${shorten(version.action, Math.max(4, width - 10))}`;
        return current ? green(line) : line;
      }),
      ...(state.versions.length > visible.length ? [dim(`+${state.versions.length - visible.length} more`)] : []),
      dim(`limit ${state.versionLimit} · /version`),
    ];
    return boxed(lines, width, height);
  }

  invalidate(): void { /* stateless */ }
}

/** Right of the video: generated and imported assets, newest first, with what they cost. */
export class AssetsSidebarView implements Component {
  constructor(private readonly state: ShellState, private readonly bandRows: () => number) {}

  render(width: number): string[] {
    const { state } = this;
    const height = this.bandRows();
    const room = Math.max(1, height - 7);
    const visible = [...state.assets].reverse().slice(0, room);
    const lines = [
      bold(cyan("Assets")),
      yellow(`Cost ${formatUsd(state.usage.assetUsd)}`),
      ...(visible.length === 0 ? [dim("No assets yet")] : visible.map((asset) =>
        `${assetIcon(asset.kind)} ${shorten(asset.description, Math.max(4, width - 14))} ${dim(asset.costUsd === undefined ? "—" : formatUsd(asset.costUsd, asset.costEstimated))}`)),
      ...(state.assets.length > visible.length ? [dim(`+${state.assets.length - visible.length} more`)] : []),
      dim("Ctrl+O to browse"),
    ];
    return boxed(lines, width, height);
  }

  invalidate(): void { /* stateless */ }
}
```

Create `src/shell/views/transcript.ts`:

```typescript
import { Container, ScrollView, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { TranscriptMessage } from "../state/shell-state.js";
import { cyan, dim, magenta, red } from "./style.js";

/** One message: `you › text`, or `model › text`, with wrapped lines indented under the label. */
export class MessageView implements Component {
  constructor(private readonly message: TranscriptMessage, private readonly agentModel: () => string) {}

  render(width: number): string[] {
    const { message } = this;
    const label = message.role === "user" ? "you" : (message.label ?? this.agentModel());
    const color = message.role === "user" ? cyan : label === "error" ? red : label === "tool" ? dim : magenta;
    const first = `${color(label)} › `;
    const indent = `${" ".repeat(label.length)} │ `;
    const prefixWidth = label.length + 3;
    const room = Math.max(4, width - prefixWidth);
    const output: string[] = [];
    for (const logical of cleanTerminalMarkdown(message.text).split(/\r?\n/)) {
      const pieces = logical.trim() === "" ? [""] : wrapTextWithAnsi(logical, room);
      for (const piece of pieces) output.push(`${output.length === 0 ? first : dim(indent)}${piece}`);
    }
    return output.length > 0 ? output : [first];
  }

  invalidate(): void { /* rendered fresh every frame */ }
}

/** The conversation: a scrolling list of messages that follows the newest line until the user scrolls up. */
export class TranscriptView {
  readonly view: ScrollView;
  private readonly container = new Container();
  private ids: string[] = [];

  constructor(private readonly agentModel: () => string) {
    this.view = new ScrollView(this.container, { follow: "end", primary: true });
  }

  /** Make the list match the messages. Streaming changes to an existing message need no rebuild. */
  sync(messages: readonly TranscriptMessage[]): void {
    const ids = messages.map((message) => message.id);
    if (ids.length === this.ids.length && ids.every((id, index) => id === this.ids[index])) return;
    this.container.clear();
    for (const message of messages) this.container.addChild(new MessageView(message, this.agentModel));
    this.ids = ids;
  }

  /** Positive rows scroll toward older messages. */
  scrollBy(rows: number): void { this.view.scrollBy(-rows); }
  scrollToEnd(): void { this.view.scrollToEnd(); }
  /** A page: the visible height minus one row of overlap. */
  pageRows(): number { return Math.max(1, this.view.viewportHeight - 1); }
}

function cleanTerminalMarkdown(value: string): string {
  return value
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ");
}
```

Create `src/shell/views/composer.ts`:

```typescript
import { CombinedAutocompleteProvider, Editor, type TUI } from "@earendil-works/pi-tui";
import type { CommandDefinition } from "../../core/commands.js";
import { cyan, dim, gray, yellow } from "./style.js";

export interface ComposerOptions {
  commands: readonly CommandDefinition[];
  /** Folder that `@file` completion starts from. */
  cwd: string;
  onSubmit(text: string): void;
}

/** The message box: pi-tui's multi-line editor with slash-command completion. It grows, then scrolls inside itself. */
export class Composer {
  readonly editor: Editor;

  constructor(tui: TUI, options: ComposerOptions) {
    this.editor = new Editor(tui, {
      borderColor: gray,
      selectList: { selectedPrefix: cyan, selectedText: cyan, description: dim, scrollInfo: dim, noMatch: dim },
    });
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(
      options.commands.map((command) => ({ name: command.name.replace(/^\//, ""), description: `${command.usage}  ${command.description}` })),
      options.cwd,
    ));
    this.editor.onSubmit = (text) => {
      const request = text.trim();
      if (!request) return;
      this.editor.addToHistory(request);
      this.clear();
      options.onSubmit(request);
    };
  }

  get text(): string { return this.editor.getText(); }
  isEmpty(): boolean { return this.editor.getText().length === 0; }
  clear(): void { this.editor.setText(""); }
  /** Put text back, after whatever is already typed. */
  restore(text: string): void {
    const current = this.editor.getText();
    this.editor.setText(current ? `${current} ${text}` : text);
  }
  /** Yellow while an export or render blocks typing. */
  setBusy(busy: boolean): void { this.editor.borderColor = busy ? yellow : gray; }
}
```

Create `src/shell/views/video-view.ts`:

```typescript
import type { Component } from "@earendil-works/pi-tui";
import type { ShellState } from "../state/shell-state.js";
import { dim } from "./style.js";

/** Reserves the video rectangle as blank cells. The picture itself is painted over them by the preview host. */
export class VideoView implements Component {
  constructor(private readonly state: ShellState, private readonly bandRows: () => number) {}

  render(width: number): string[] {
    const rows = this.bandRows();
    const lines = Array.from({ length: rows }, () => " ".repeat(width));
    if (!this.state.media) {
      const text = "No video loaded";
      lines[Math.floor(rows / 2)] = " ".repeat(Math.max(0, Math.floor((width - text.length) / 2))) + dim(text) + " ".repeat(Math.max(0, width - Math.floor((width - text.length) / 2) - text.length));
    }
    return lines;
  }

  invalidate(): void { /* stateless */ }
}
```

Create `src/shell/screen.ts`:

```typescript
import { HStack, TuiAltScreen, VStack, type Component, type Terminal } from "@earendil-works/pi-tui";
import type { CommandDefinition } from "../core/commands.js";
import type { PreviewBackend } from "../core/media.js";
import { resolveKey, type Intent, type KeyContext } from "./input/keymap.js";
import { shellLayout, type ShellLayout } from "./layout.js";
import { PreviewHost } from "./preview/preview-host.js";
import type { CellRect } from "./preview/video-layer.js";
import type { OverlayKind, ShellState } from "./state/shell-state.js";
import { StatusView, ControlsView } from "./views/controls.js";
import { Composer } from "./views/composer.js";
import { HeaderView } from "./views/header.js";
import { AssetsSidebarView, ProjectSidebarView } from "./views/sidebars.js";
import { TimelineView } from "./views/timeline.js";
import { TranscriptView } from "./views/transcript.js";
import { VideoView } from "./views/video-view.js";

export interface OverlayContext {
  /** Height of the band the panel fills. */
  bandRows: () => number;
  close(): void;
}

export interface ScreenHooks {
  /** A line the user sent: a slash command, or a request for the agent. */
  onSubmit(text: string): void;
  /** Ctrl+C: stop the agent if it is running, otherwise quit. */
  onInterrupt(): void;
  onAbortAgent(): void;
  onOpenAssets(): void;
}

export interface ScreenOptions {
  terminal: Terminal;
  state: ShellState;
  backend: PreviewBackend;
  commands: readonly CommandDefinition[];
  cwd: string;
  hooks: ScreenHooks;
  /** Builds the panel for an overlay kind. A panel replaces the video band while it is open and receives the keys. */
  overlays?: (kind: OverlayKind, context: OverlayContext) => Component | null;
  /** Called after the layout was rebuilt, for example after a resize, so playback can use the new picture size. */
  onLayout?: () => void;
}

/** pi-tui's screen with the editor's layout: header, a band (sidebars and video, or a panel), timeline, chat, composer, status. */
export function createShellScreen(options: ScreenOptions) {
  const { state, backend, hooks } = options;
  let layout: ShellLayout = { bandRows: 0, leftSidebarColumns: 0, videoColumns: 0, rightSidebarColumns: 0 };
  let layoutKey = "";
  let activeOverlay: { kind: OverlayKind; component: Component } | null = null;

  const preview: PreviewHost = new PreviewHost(options.terminal, {
    visible: () => state.media !== null && state.overlay === null && !state.chatExpanded,
    rect: () => videoRect(),
    screenLines: () => tui.getScreenLines(),
    onResize: () => relayout(),
  });
  const tui = new TuiAltScreen(preview.terminal, true);
  const bandRows = () => layout.bandRows;

  const transcript = new TranscriptView(() => state.agentModel);
  const composer = new Composer(tui, { commands: options.commands, cwd: options.cwd, onSubmit: (text) => hooks.onSubmit(text) });
  const header = new HeaderView(state);
  const timeline = new TimelineView(state, () => ({ leftPad: layout.leftSidebarColumns, videoColumns: layout.videoColumns }));
  const controls = new ControlsView(state, () => backend);
  const status = new StatusView(state);
  const video = new VideoView(state, bandRows);
  const left = new ProjectSidebarView(state, bandRows);
  const right = new AssetsSidebarView(state, bandRows);

  function videoRect(): CellRect {
    return { x: layout.leftSidebarColumns, y: 1, w: layout.videoColumns, h: layout.bandRows };
  }

  function band(): Component {
    if (activeOverlay) return activeOverlay.component;
    const entries = [];
    if (layout.leftSidebarColumns > 0) entries.push({ component: left, basis: layout.leftSidebarColumns, grow: 0, shrink: 0 });
    entries.push({ component: video, basis: 0, grow: 1, minSize: 1 });
    if (layout.rightSidebarColumns > 0) entries.push({ component: right, basis: layout.rightSidebarColumns, grow: 0, shrink: 0 });
    return new HStack(entries);
  }

  function buildRoot(): Component {
    const chat = { component: transcript.view, basis: 0, grow: 1, minSize: 1 };
    const tail = [{ component: composer.editor, basis: "auto" as const, shrink: 1, minSize: 1 }, { component: status, basis: 1, grow: 0, shrink: 0 }];
    if (state.chatExpanded) return new VStack([{ component: header, basis: 1, grow: 0, shrink: 0 }, chat, ...tail]);
    return new VStack([
      { component: header, basis: 1, grow: 0, shrink: 0 },
      { component: band(), basis: layout.bandRows, grow: 0, shrink: 0 },
      { component: timeline, basis: 1, grow: 0, shrink: 0 },
      { component: controls, basis: 1, grow: 0, shrink: 0 },
      chat,
      ...tail,
    ]);
  }

  /** Rebuild the layout when anything that shapes it changed. */
  function relayout(): void {
    layout = shellLayout({ columns: options.terminal.columns, rows: options.terminal.rows }, state.media, backend);
    const key = `${options.terminal.columns}x${options.terminal.rows}|${layout.bandRows}|${layout.leftSidebarColumns}|${layout.videoColumns}|${activeOverlay?.kind ?? ""}|${state.chatExpanded}`;
    if (key === layoutKey) return;
    layoutKey = key;
    tui.setLayoutRoot(buildRoot());
    options.onLayout?.();
  }

  function syncOverlay(): void {
    if (state.overlay === null) {
      if (activeOverlay) { activeOverlay = null; tui.setFocus(composer.editor); }
      return;
    }
    if (activeOverlay?.kind === state.overlay) return;
    const component = options.overlays?.(state.overlay, { bandRows, close: () => state.closeOverlay() }) ?? null;
    activeOverlay = component ? { kind: state.overlay, component } : null;
    tui.setFocus(component ?? composer.editor);
  }

  function sync(): void {
    transcript.sync(state.messages);
    composer.setBusy(state.busy);
    const restored = state.takeComposerRestore();
    if (restored) composer.restore(restored);
    syncOverlay();
    relayout();
    tui.requestRender();
  }

  function keyContext(): KeyContext {
    return {
      overlayOpen: state.overlay !== null, composerEmpty: composer.isEmpty(), agentRunning: state.agentRunning, busy: state.busy,
      videoMutationActive: state.videoMutationActive, chatExpanded: state.chatExpanded, hasMedia: state.media !== null,
    };
  }

  function apply(intent: Intent): void {
    switch (intent.type) {
      case "interrupt": hooks.onInterrupt(); break;
      case "abort-agent": hooks.onAbortAgent(); break;
      case "open-assets": hooks.onOpenAssets(); break;
      case "toggle-chat-focus": state.toggleChatExpanded(); break;
      case "collapse-chat": state.setChatExpanded(false); break;
      case "clear-composer": composer.clear(); tui.requestRender(); break;
      case "scroll-chat": transcript.scrollBy(intent.rows); tui.requestRender(); break;
      case "scroll-chat-page": transcript.scrollBy(intent.direction * transcript.pageRows()); tui.requestRender(); break;
      case "seek": state.setPlaying(false); state.movePlayhead(intent.seconds); break;
      case "toggle-play": state.togglePlaying(); break;
      case "volume": state.adjustVolume(intent.delta); break;
      case "mark-in": state.setIn(); break;
      case "mark-out": state.setOut(); break;
      case "ignore": break;
    }
  }

  tui.addInputListener((data) => {
    const intent = resolveKey(data, keyContext());
    if (!intent) return undefined;
    apply(intent);
    return { consume: true };
  });
  const unsubscribe = state.subscribe(sync);
  relayout();
  tui.setFocus(composer.editor);

  return {
    tui, preview, composer, transcript,
    layout: () => layout,
    videoRect,
    /** Re-read the state and redraw, for example after changes made outside the state object. */
    refresh: sync,
    start(): void { tui.start(); },
    stop(): void { unsubscribe(); tui.stop(); },
  };
}

export type ShellScreen = ReturnType<typeof createShellScreen>;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/shell-views.test.js .test-dist/tests/shell-screen.test.js
npm test
```

Expected: 8 passed in `shell-views` and 12 in `shell-screen`, then the whole suite: 155 tests, 154 passed, 1 skipped (the live OpenRouter test), 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/shell tests package.json
git commit -m "feat: add the shell screen, views and layout"
```

## Task 6: Panels: help, versions, projects, approval, choice and assets

**Files:**
- Create: `src/shell/overlays/{frame,help,history,projects,approval,choice,assets}.ts`, `tests/shell-overlays.test.ts`
- Modify: `package.json` (`test` script)

**Interfaces:**
- Consumes: `createShellScreen`'s `overlays` factory contract (Task 5), `boxed`, `assetIcon`, the text helpers, pi-tui `Input` and `matchesKey`, `ApprovalRequest`, `ChoicePrompt`, `ProjectSummary`, `AgentAsset`.
- Produces: `Panel` (base class: `focused`, `render(width)`, `handleInput(data)`), `PanelContext = { bandRows: () => number; requestRender: () => void }`, `box`, `fill`, `centered`, `listWindow`, `row`, `wrapIndex`, `isPrintable`, `setValueAtEnd`; `HelpPanel`, `HistoryPanel`, `ProjectsPanel`, `ApprovalPanel` (+ `approvalOptions`, `approvalDecision`), `ChoicePanel`, `AssetPanel`. A panel renders exactly `bandRows` rows of exactly the band's width, and calls `close`/`decide`/`answer`/`open` callbacks instead of touching the engine.

- [ ] **Step 1: Write the tests**

Create `tests/shell-overlays.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ApprovalDecision } from "../src/core/engine/events.js";
import type { ProjectSummary } from "../src/core/project.js";
import { AssetPanel } from "../src/shell/overlays/assets.js";
import { ApprovalPanel, approvalDecision, approvalOptions } from "../src/shell/overlays/approval.js";
import { ChoicePanel } from "../src/shell/overlays/choice.js";
import { HelpPanel } from "../src/shell/overlays/help.js";
import { HistoryPanel } from "../src/shell/overlays/history.js";
import { ProjectsPanel } from "../src/shell/overlays/projects.js";
import { ShellState, type ApprovalRequest } from "../src/shell/state/shell-state.js";
import { plain } from "../src/shell/views/style.js";

const ROWS = 16;
const WIDTH = 100;
let renders = 0;
const context = { bandRows: () => ROWS, requestRender: () => { renders += 1; } };
const KEY = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", esc: "\x1b", tab: "\t", ctrlO: "\x0f" };
const screen = (lines: string[]) => lines.map(plain).join("\n");
const assertFills = (lines: string[]) => {
  assert.equal(lines.length, ROWS, "as tall as the band");
  assert.ok(lines.every((line) => visibleWidth(line) === WIDTH), "every row exactly as wide as the band");
};

test("help lists the controls and the model, and Escape closes it", () => {
  let closed = 0;
  const panel = new HelpPanel(context, { model: () => "glm", close: () => { closed += 1; } });
  const lines = panel.render(WIDTH);
  assertFills(lines);
  assert.match(screen(lines), /DumbEditor controls[\s\S]*Ctrl\+P play\/pause[\s\S]*Ask glm normally/);
  panel.handleInput("x");
  panel.handleInput(KEY.esc);
  assert.equal(closed, 1);
});

test("history marks the current version and shows eight unless asked for all", () => {
  const state = new ShellState();
  state.setVersions(Array.from({ length: 12 }, (_, index) => ({ id: `v${String(11 - index).padStart(4, "0")}`, parentId: null, filePath: "f", action: `edit ${11 - index}`, request: "", createdAt: "", duration: 12 })) as never, "v0010");
  const some = screen(new HistoryPanel(context, { state, showAll: false, close: () => undefined }).render(WIDTH));
  assert.match(some, /○ v0011 {2}00:12\.0 {2}edit 11/);
  assert.match(some, /● v0010/);
  assert.ok(!some.includes("v0003"), "only eight rows");
  const all = screen(new HistoryPanel(context, { state, showAll: true, close: () => undefined }).render(WIDTH));
  assert.ok(all.includes("v0000"));
});

test("projects: opens on the active project, moves, opens the chosen one, and closes", () => {
  const project = (name: string, dir: string): ProjectSummary => ({ name, sourcePath: `C:/videos/${name}.mp4`, projectDir: dir, createdAt: "", updatedAt: "", currentVersionId: "v0003", versionCount: 3 });
  const projects = [project("alpha", "C:/p/a"), project("beta", "C:/p/b"), project("gamma", "C:/p/c")];
  const opened: string[] = [];
  let closed = 0;
  const panel = new ProjectsPanel(context, { projects, activeProjectDir: "c:/P/B", open: (item) => opened.push(item.name), close: () => { closed += 1; } });
  const lines = panel.render(WIDTH);
  assertFills(lines);
  assert.match(screen(lines), /○ alpha {2}alpha\.mp4 · 3 versions · v0003/);
  assert.match(screen(lines), /› ● beta/, "the active project is selected and marked");
  panel.handleInput(KEY.down);
  panel.handleInput(KEY.enter);
  panel.handleInput(KEY.down);
  panel.handleInput(KEY.right);
  assert.deepEqual(opened, ["gamma", "alpha"], "selection wraps");
  panel.handleInput(KEY.esc);
  assert.equal(closed, 1);
  assert.match(screen(new ProjectsPanel(context, { projects: [], activeProjectDir: undefined, open: () => undefined, close: () => undefined }).render(WIDTH)), /No saved projects found/);
});

const approval = (changes: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ type: "approval_request", id: "a1", kind: "action", name: "generate_asset", summary: "Generate an image: a cat", risk: "spend", args: { kind: "image" }, ...changes });

test("approval: asks with Deny preselected, and Enter, arrows and Escape decide", () => {
  const decisions: ApprovalDecision[] = [];
  const panel = new ApprovalPanel(context, { request: approval(), decide: (decision) => decisions.push(decision) });
  const lines = panel.render(WIDTH);
  assertFills(lines);
  assert.match(screen(lines), /Permission required[\s\S]*Generate an image: a cat[\s\S]*can spend money[\s\S]*Arguments: \{"kind":"image"\}[\s\S]*Allow once +Allow this session +Deny/);
  panel.handleInput(KEY.enter);
  panel.handleInput(KEY.right);
  panel.handleInput(KEY.enter);
  panel.handleInput(KEY.left);
  panel.handleInput(KEY.left);
  panel.handleInput(KEY.enter);
  panel.handleInput(KEY.esc);
  assert.deepEqual(decisions, ["deny", "once", "session", "deny"]);
});

test("approval at the spend limit offers Continue and Stop", () => {
  const request = approval({ kind: "budget", risk: "budget", summary: "This run has spent $5.01" });
  assert.deepEqual(approvalOptions(request), ["Continue", "Stop"]);
  assert.deepEqual([approvalDecision(request, 0), approvalDecision(request, 1)], ["once", "deny"]);
  assert.deepEqual(approvalOptions(approval()), ["Allow once", "Allow this session", "Deny"]);
  const decisions: ApprovalDecision[] = [];
  const panel = new ApprovalPanel(context, { request, decide: (decision) => decisions.push(decision) });
  assert.match(screen(panel.render(WIDTH)), /Spend limit reached/);
  panel.handleInput(KEY.tab);
  panel.handleInput(KEY.enter);
  assert.deepEqual(decisions, ["once"]);
});

test("choice: pick an option, type a custom answer, or cancel", () => {
  const answers: Array<string | null> = [];
  const request = { id: "q1", question: "Which style?", options: ["Calm", "Bold"], allowCustom: true };
  const panel = new ChoicePanel(context, { request, answer: (answer) => answers.push(answer) });
  assertFills(panel.render(WIDTH));
  assert.match(screen(panel.render(WIDTH)), /Which style\?[\s\S]*› Calm[\s\S]*Bold[\s\S]*Custom answer/);
  panel.handleInput(KEY.down);
  panel.handleInput(KEY.enter);
  for (const character of "retro") panel.handleInput(character);
  panel.handleInput(KEY.enter);
  const second = new ChoicePanel(context, { request, answer: (answer) => answers.push(answer) });
  second.handleInput(KEY.tab);
  for (const character of "fast") second.handleInput(character);
  second.handleInput(KEY.enter);
  second.handleInput(KEY.esc);
  assert.deepEqual(answers, ["Bold", "retro", "fast", null]);
});

test("choice without a custom answer ignores typing", () => {
  const answers: Array<string | null> = [];
  const panel = new ChoicePanel(context, { request: { id: "q", question: "Pick", options: ["A", "B"], allowCustom: false }, answer: (answer) => answers.push(answer) });
  panel.handleInput("z");
  panel.handleInput(KEY.tab);
  panel.handleInput(KEY.enter);
  assert.deepEqual(answers, ["A"]);
  assert.ok(!screen(panel.render(WIDTH)).includes("Custom answer"));
});

test("assets: lists newest selected, previews an image, plays sound, and hands typing back to the chat", async () => {
  const assets = [
    { id: "a1", kind: "image", description: "A blue title card", path: "C:/w/title.png", source: "generated", model: "flux", costUsd: 0.04, createdAt: "" },
    { id: "a2", kind: "music", description: "Calm piano", path: "C:/w/piano.mp3", source: "catalog", license: "CC BY 4.0", createdAt: "" },
  ] as const;
  const calls = { played: [] as string[], stopped: 0, typed: [] as string[], closed: 0 };
  let playing = false;
  const panel = new AssetPanel(context, {
    assets: () => assets as never, playing: () => playing, togglePlay: (asset) => { calls.played.push(asset.id); playing = !playing; },
    stopPlay: () => { calls.stopped += 1; playing = false; }, typeText: (text) => calls.typed.push(text), close: () => { calls.closed += 1; },
    loadFrame: async () => "▀▀▀▀\n▀▀▀▀",
  });
  let text = screen(panel.render(WIDTH));
  assertFills(panel.render(WIDTH));
  assert.match(text, /› ♪ Calm piano · cost unavailable/, "the newest asset is selected");
  assert.match(text, /License: CC BY 4\.0[\s\S]*Space plays this asset/);
  panel.handleInput(" ");
  assert.match(screen(panel.render(WIDTH)), /▶ playing preview/);
  panel.handleInput(KEY.up);
  assert.equal(calls.stopped, 1, "moving stops the sound");
  text = screen(panel.render(WIDTH));
  assert.match(text, /▧ A blue title card[\s\S]*Model: flux[\s\S]*Cost: \$0\.04/);
  assert.match(text, /Loading preview/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(screen(panel.render(WIDTH)), /▀▀▀▀/, "the picture appears when it has loaded");
  panel.handleInput(" ");
  assert.deepEqual(calls.played, ["a2"], "Space does nothing on an image");
  panel.handleInput("h");
  assert.deepEqual([calls.typed, calls.closed], [["h"], 1]);
  panel.handleInput(KEY.ctrlO);
  assert.equal(calls.closed, 2);
  assert.match(screen(new AssetPanel(context, { assets: () => [], playing: () => false, togglePlay: () => undefined, stopPlay: () => undefined, typeText: () => undefined, close: () => undefined }).render(WIDTH)), /No project assets yet/);
  assert.ok(renders > 0, "panels ask the screen to redraw after a key");
});
```

Add `shell-overlays` to the `test` script:

```diff
--- a/package.json
+++ b/package.json
@@ -17,7 +17,7 @@
     "build": "tsup",
     "check": "tsc --noEmit",
     "dev": "tsx src/cli.tsx",
-    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/shell-layout.test.js .test-dist/tests/shell-state.test.js .test-dist/tests/shell-keymap.test.js .test-dist/tests/shell-preview.test.js .test-dist/tests/shell-views.test.js .test-dist/tests/shell-screen.test.js .test-dist/tests/transcription.test.js",
+    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/shell-layout.test.js .test-dist/tests/shell-state.test.js .test-dist/tests/shell-keymap.test.js .test-dist/tests/shell-preview.test.js .test-dist/tests/shell-views.test.js .test-dist/tests/shell-screen.test.js .test-dist/tests/shell-overlays.test.js .test-dist/tests/transcription.test.js",
     "quality": "npm run check && npm test && npm run build",
     "release:check": "npm run quality && npm pack --dry-run",
     "prepublishOnly": "npm run quality"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL with `Cannot find module` for the files under `src/shell/overlays/`.

- [ ] **Step 3: Write the implementation**

Panels replace the video band while open (like the old UI) instead of floating over it, so the video is hidden by the screen's layout rule and no panel can ever be drawn under a Sixel picture. Esc denies an approval; typing in the asset browser closes it and hands the text to the composer.

Create `src/shell/overlays/frame.ts`:

```typescript
import { visibleWidth, type Component, type Focusable, type Input } from "@earendil-works/pi-tui";
import { fitLine, inverse } from "../views/style.js";

export type BorderStyle = "round" | "single" | "double";

const CHARS: Record<BorderStyle, { tl: string; tr: string; bl: string; br: string; h: string; v: string }> = {
  round: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  single: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
};

/** What every panel needs from the screen. */
export interface PanelContext {
  /** Height of the band the panel fills. */
  bandRows: () => number;
  requestRender: () => void;
}

/** A panel that replaces the video band and receives the keys while it is open. */
export abstract class Panel implements Component, Focusable {
  focused = false;
  constructor(protected readonly context: PanelContext) {}
  abstract render(width: number): string[];
  abstract handleInput(data: string): void;
  invalidate(): void { /* rebuilt every frame */ }
  protected get rows(): number { return this.context.bandRows(); }
}

/** A box around `lines`, exactly `width` columns wide and `lines.length + 2` rows tall. */
export function box(lines: readonly string[], width: number, options: { border: BorderStyle; color: (text: string) => string; paddingX?: number }): string[] {
  const chars = CHARS[options.border];
  const paddingX = options.paddingX ?? 1;
  const inner = Math.max(1, width - 2);
  const content = Math.max(1, inner - paddingX * 2);
  const gap = " ".repeat(paddingX);
  return [
    options.color(`${chars.tl}${chars.h.repeat(inner)}${chars.tr}`),
    ...lines.map((line) => `${options.color(chars.v)}${gap}${fitLine(line, content)}${gap}${options.color(chars.v)}`),
    options.color(`${chars.bl}${chars.h.repeat(inner)}${chars.br}`),
  ];
}

/** Make `lines` exactly `height` rows of exactly `width` columns, padding with blanks or cutting. */
export function fill(lines: readonly string[], width: number, height: number): string[] {
  return Array.from({ length: height }, (_, index) => fitLine(lines[index] ?? "", width));
}

/** Put a box in the middle of a `width` x `height` area. */
export function centered(boxLines: readonly string[], width: number, height: number): string[] {
  const boxWidth = boxLines.reduce((widest, line) => Math.max(widest, visibleWidth(line)), 0);
  const left = Math.max(0, Math.floor((width - boxWidth) / 2));
  const top = Math.max(0, Math.floor((height - boxLines.length) / 2));
  const rows = Array.from({ length: height }, (_, index) => {
    const line = boxLines[index - top];
    return line === undefined ? "" : `${" ".repeat(left)}${line}`;
  });
  return fill(rows, width, height);
}

/** The slice of a long list to show so that `selected` stays visible. */
export function listWindow(count: number, selected: number, capacity: number): { start: number; end: number } {
  const room = Math.max(1, capacity);
  const start = Math.min(Math.max(0, selected - room + 1), Math.max(0, count - room));
  return { start, end: Math.min(count, start + room) };
}

/** A list row, highlighted when selected. */
export function row(text: string, selected: boolean, color: (value: string) => string): string {
  return selected ? inverse(color(text)) : text;
}

export function wrapIndex(index: number, delta: number, count: number): number {
  return count === 0 ? 0 : (index + delta + count) % count;
}

/** True for typed text, false for control keys and escape sequences. */
export function isPrintable(data: string): boolean {
  return data.length > 0 && data.charCodeAt(0) !== 27 && ![...data].some((character) => character < " ");
}

/** Set a text field's value with the cursor at the end, where the user expects to keep typing. */
export function setValueAtEnd(input: Input, value: string): void {
  input.setValue(value);
  input.handleInput(String.fromCharCode(5));
}
```

Create `src/shell/overlays/help.ts`:

```typescript
import { matchesKey } from "@earendil-works/pi-tui";
import { bold, cyan, dim } from "../views/style.js";
import { box, fill, Panel, type PanelContext } from "./frame.js";

export class HelpPanel extends Panel {
  constructor(context: PanelContext, private readonly options: { model: () => string; close: () => void }) { super(context); }

  render(width: number): string[] {
    const lines = [
      bold(cyan("DumbEditor controls")),
      "Ctrl+P play/pause  ←/→ seek 5s  +/- volume  [ set in  ] set out",
      "/clip-remove FROM TO [FROM TO...]  /clip-keep FROM TO",
      "/speed FROM TO FACTOR  /mute FROM TO  /crop WIDTHxHEIGHT [X,Y]",
      "/open path  /projects  /version [all]  /revert id  /undo",
      "/export [path] popup  /version-limits [N]  /model model picker",
      "/bg-music music browser  /assets asset browser  (also Ctrl+O)",
      "/permissions [ask|auto]  /budget [USD]  /compact",
      dim("Type / for commands, use ↑/↓ to choose, and Tab to complete."),
      dim("↑/↓ scroll chat, PgUp/PgDn move a page, Ctrl+G expands chat."),
      dim("While the agent works: Enter sends a message that steers it, Esc stops it."),
      dim(`Ask ${this.options.model()} normally: “remove the first two seconds and the last ten”.`),
      dim("Esc closes this panel"),
    ];
    return fill(box(lines, width, { border: "round", color: cyan }), width, this.rows);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.options.close();
  }
}
```

Create `src/shell/overlays/history.ts`:

```typescript
import { matchesKey } from "@earendil-works/pi-tui";
import { formatTime } from "../../core/time.js";
import type { ShellState } from "../state/shell-state.js";
import { bold, dim, green, magenta } from "../views/style.js";
import { box, fill, Panel, type PanelContext } from "./frame.js";

/** The version list. Newest first; shows the latest eight unless asked for all. */
export class HistoryPanel extends Panel {
  constructor(context: PanelContext, private readonly options: { state: ShellState; showAll: boolean; close: () => void }) { super(context); }

  render(width: number): string[] {
    const { state, showAll } = this.options;
    const versions = showAll ? state.versions : state.versions.slice(0, 8);
    const lines = [
      bold(magenta("Version history")),
      ...versions.map((version) => {
        const current = version.id === state.versionId;
        const line = `${current ? "●" : "○"} ${version.id}  ${formatTime(version.duration)}  ${version.action}`;
        return current ? green(line) : line;
      }),
      dim("Use /revert v0001 · /version all · Esc to close"),
    ];
    return fill(box(lines, width, { border: "round", color: magenta }), width, this.rows);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.options.close();
  }
}
```

Create `src/shell/overlays/projects.ts`:

```typescript
import { basename } from "node:path";
import { matchesKey } from "@earendil-works/pi-tui";
import type { ProjectSummary } from "../../core/project.js";
import { bold, cyan, dim, spaceBetween } from "../views/style.js";
import { box, fill, listWindow, Panel, row, wrapIndex, type PanelContext } from "./frame.js";

export interface ProjectsPanelOptions {
  projects: readonly ProjectSummary[];
  /** The project folder that is open now, marked with a filled dot. */
  activeProjectDir: string | undefined;
  open(project: ProjectSummary): void;
  close(): void;
}

/** Saved editing projects, to reopen one. */
export class ProjectsPanel extends Panel {
  private selected = 0;

  constructor(context: PanelContext, private readonly options: ProjectsPanelOptions) {
    super(context);
    const active = options.projects.findIndex((item) => same(item.projectDir, options.activeProjectDir));
    this.selected = active >= 0 ? active : 0;
  }

  render(width: number): string[] {
    const { projects, activeProjectDir } = this.options;
    const capacity = Math.max(1, this.rows - 6);
    const { start, end } = listWindow(projects.length, this.selected, capacity);
    const lines = [
      spaceBetween(bold(cyan("Projects")), dim(`${projects.length} saved`), Math.max(10, width - 4)),
      ...(projects.length === 0 ? [dim("No saved projects found. Open a video to create one.")] : []),
      ...projects.slice(start, end).map((project, offset) => {
        const index = start + offset;
        const active = same(project.projectDir, activeProjectDir);
        const text = `${index === this.selected ? "›" : " "} ${active ? "●" : "○"} ${project.name}  ${basename(project.sourcePath)} · ${project.versionCount} versions · ${project.currentVersionId}`;
        return row(text, index === this.selected, cyan);
      }),
      dim("↑/↓ browse · Enter open · Esc close"),
    ];
    return fill(box(lines, width, { border: "round", color: cyan }), width, this.rows);
  }

  handleInput(data: string): void {
    const { projects } = this.options;
    if (matchesKey(data, "escape") || matchesKey(data, "left")) { this.options.close(); return; }
    if (matchesKey(data, "up")) this.selected = wrapIndex(this.selected, -1, projects.length);
    else if (matchesKey(data, "down") || matchesKey(data, "tab")) this.selected = wrapIndex(this.selected, 1, projects.length);
    else if (matchesKey(data, "enter") || matchesKey(data, "right")) {
      const project = projects[this.selected];
      if (project) this.options.open(project);
    }
    this.context.requestRender();
  }
}

function same(left: string, right: string | undefined): boolean {
  return right !== undefined && left.toLowerCase() === right.toLowerCase();
}
```

Create `src/shell/overlays/approval.ts`:

```typescript
import { matchesKey } from "@earendil-works/pi-tui";
import type { ApprovalDecision } from "../../core/engine/events.js";
import type { ApprovalRequest } from "../state/shell-state.js";
import { bold, green, inverse, red, yellow } from "../views/style.js";
import { box, centered, Panel, wrapIndex, type PanelContext } from "./frame.js";

/** Choices shown for a request, the last one being the safe default. */
export function approvalOptions(request: ApprovalRequest): string[] {
  return request.kind === "budget" ? ["Continue", "Stop"] : ["Allow once", "Allow this session", "Deny"];
}

export function approvalDecision(request: ApprovalRequest, index: number): ApprovalDecision {
  if (request.kind === "budget") return index === 0 ? "once" : "deny";
  return (["once", "session", "deny"] as const)[index] ?? "deny";
}

const RISK_NOTE: Record<string, string> = {
  spend: "This can spend money with a model provider.",
  code: "This runs custom FFmpeg or a script the agent wrote.",
};

/** Asks before the agent spends money or runs code, or when a run reaches its spend limit. Esc denies. */
export class ApprovalPanel extends Panel {
  private selected: number;

  constructor(context: PanelContext, private readonly options: { request: ApprovalRequest; decide(decision: ApprovalDecision): void }) {
    super(context);
    this.selected = approvalOptions(options.request).length - 1;
  }

  render(width: number): string[] {
    const { request } = this.options;
    const choices = approvalOptions(request);
    const args = request.args === undefined ? null : JSON.stringify(request.args);
    const lines = [
      bold(yellow(request.kind === "budget" ? "Spend limit reached" : "Permission required")),
      bold(request.summary),
      ...(RISK_NOTE[request.risk] ? [RISK_NOTE[request.risk] as string] : []),
      ...(args ? [`Arguments: ${args}`] : []),
      "",
      choices.map((choice, index) => {
        const label = ` ${choice} `;
        return index === this.selected ? inverse((index === choices.length - 1 ? red : green)(label)) : label;
      }).join("  "),
      "←/→ or Tab chooses · Enter confirms · Esc denies",
    ];
    return centered(box(lines, Math.min(86, width - 4), { border: "double", color: yellow, paddingX: 2 }), width, this.rows);
  }

  handleInput(data: string): void {
    const { request } = this.options;
    const count = approvalOptions(request).length;
    if (matchesKey(data, "escape")) { this.options.decide("deny"); return; }
    if (matchesKey(data, "left") || matchesKey(data, "up")) this.selected = wrapIndex(this.selected, -1, count);
    else if (matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "tab")) this.selected = wrapIndex(this.selected, 1, count);
    else if (matchesKey(data, "enter")) { this.options.decide(approvalDecision(request, this.selected)); return; }
    this.context.requestRender();
  }
}
```

Create `src/shell/overlays/choice.ts`:

```typescript
import { Input, matchesKey } from "@earendil-works/pi-tui";
import type { ChoicePrompt } from "../state/shell-state.js";
import { bold, cyan, dim, inverse } from "../views/style.js";
import { box, centered, isPrintable, Panel, wrapIndex, type PanelContext } from "./frame.js";

/** The agent asks the user to pick one option, optionally with a typed answer. Esc cancels. */
export class ChoicePanel extends Panel {
  private selected = 0;
  private customActive = false;
  private readonly custom = new Input({ prompt: "" });

  constructor(context: PanelContext, private readonly options: { request: ChoicePrompt; answer(answer: string | null): void }) { super(context); }

  render(width: number): string[] {
    const { request } = this.options;
    const panelWidth = Math.min(92, width - 4);
    this.custom.focused = this.focused && this.customActive;
    const lines = [
      bold(cyan("Choose a direction")),
      request.question,
      "",
      ...request.options.map((option, index) => {
        const active = !this.customActive && index === this.selected;
        return active ? inverse(`› ${option}`) : `  ${option}`;
      }),
      ...(request.allowCustom ? [
        "",
        this.customActive ? cyan("Custom answer") : "Custom answer",
        ...this.custom.render(Math.max(8, panelWidth - 6)),
      ] : []),
      dim("↑/↓ chooses · Tab custom answer · Enter sends · Esc cancels"),
    ];
    return centered(box(lines, panelWidth, { border: "double", color: cyan, paddingX: 2 }), width, this.rows);
  }

  handleInput(data: string): void {
    const { request } = this.options;
    if (matchesKey(data, "escape")) { this.options.answer(null); return; }
    if (matchesKey(data, "tab") && request.allowCustom) this.customActive = !this.customActive;
    else if (matchesKey(data, "enter")) {
      const answer = this.customActive ? this.custom.getValue().trim() : request.options[this.selected];
      if (answer) this.options.answer(answer);
      return;
    } else if (!this.customActive && (matchesKey(data, "up") || matchesKey(data, "down"))) {
      this.selected = wrapIndex(this.selected, matchesKey(data, "up") ? -1 : 1, request.options.length);
    } else if (this.customActive) {
      if (matchesKey(data, "up") || matchesKey(data, "down")) { this.customActive = false; this.selected = wrapIndex(this.selected, matchesKey(data, "up") ? -1 : 1, request.options.length); }
      else this.custom.handleInput(data);
    } else if (request.allowCustom && isPrintable(data)) {
      // Typing without choosing the custom box first starts a custom answer.
      this.customActive = true;
      this.custom.handleInput(data);
    }
    this.context.requestRender();
  }
}
```

Create `src/shell/overlays/assets.ts`:

```typescript
import { basename } from "node:path";
import { matchesKey } from "@earendil-works/pi-tui";
import type { AgentAsset } from "../../core/agent-workspace.js";
import { extractFrame, streamPreview, type PreviewSize, type PreviewStream } from "../../core/media.js";
import { formatUsd } from "../../core/usage.js";
import { assetIcon, boxed } from "../views/sidebars.js";
import { bold, cyan, dim, green, inverse, shorten, spaceBetween } from "../views/style.js";
import { box, fill, isPrintable, listWindow, Panel, wrapIndex, type PanelContext } from "./frame.js";

export interface AssetPanelOptions {
  assets: () => readonly AgentAsset[];
  /** True while the app is playing the selected asset's sound. */
  playing: () => boolean;
  togglePlay(asset: AgentAsset): void;
  stopPlay(): void;
  /** The user started typing: close the panel and put the text in the composer. */
  typeText(text: string): void;
  close(): void;
  /** Test seams; the real ones read the file with FFmpeg. */
  loadFrame?: (path: string, size: PreviewSize, signal: AbortSignal) => Promise<string>;
  streamFrames?: (path: string, size: PreviewSize, onFrame: (frame: string) => void, onEnd: () => void) => PreviewStream;
}

/** Browse the project's generated and imported assets, with a small preview of images and video. */
export class AssetPanel extends Panel {
  private selected: number;
  private preview = { key: "", lines: [] as string[], stop: () => undefined as void };

  constructor(context: PanelContext, private readonly options: AssetPanelOptions) {
    super(context);
    this.selected = Math.max(0, options.assets().length - 1);
  }

  render(width: number): string[] {
    const assets = this.options.assets();
    this.selected = Math.min(this.selected, Math.max(0, assets.length - 1));
    const selected = assets[this.selected];
    const inner = Math.max(20, width - 4);
    const listWidth = Math.max(26, Math.floor(width * 0.38));
    const detailWidth = Math.max(20, inner - listWidth - 2);
    const room = Math.max(1, this.rows - 5);
    const header = spaceBetween(bold(cyan("Assets")), dim("↑/↓ select · Space play · Ctrl+O/Esc close · type to chat"), inner);
    if (assets.length === 0) {
      return fill(box([header, dim("No project assets yet. Ask the editor agent to create an image, sound, video, or subtitles.")], width, { border: "single", color: cyan }), width, this.rows);
    }
    const { start, end } = listWindow(assets.length, this.selected, room - 2);
    const list = boxed(assets.slice(start, end).map((asset, offset) => {
      const index = start + offset;
      const cost = asset.costUsd === undefined ? "cost unavailable" : formatUsd(asset.costUsd, asset.costEstimated);
      const text = `${index === this.selected ? "›" : " "} ${assetIcon(asset.kind)} ${asset.description} · ${cost}`;
      return index === this.selected ? inverse(cyan(text)) : text;
    }), listWidth, Math.min(room, end - start + 2));
    const details = selected ? this.details(selected, detailWidth, room) : [];
    const rows = Array.from({ length: room }, (_, index) => `${list[index] ?? " ".repeat(listWidth)}  ${details[index] ?? ""}`);
    return fill(box([header, ...rows], width, { border: "single", color: cyan }), width, this.rows);
  }

  handleInput(data: string): void {
    const assets = this.options.assets();
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+o")) { this.stopPreview(); this.options.stopPlay(); this.options.close(); return; }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.options.stopPlay();
      this.selected = wrapIndex(this.selected, matchesKey(data, "up") ? -1 : 1, assets.length);
    } else if (data === " ") {
      const asset = assets[this.selected];
      if (asset && ["audio", "music", "video"].includes(asset.kind)) this.options.togglePlay(asset);
    } else if (isPrintable(data)) {
      this.stopPreview(); this.options.stopPlay(); this.options.close(); this.options.typeText(data);
      return;
    }
    this.context.requestRender();
  }

  /** Stop any preview work, for example when the panel is closed. */
  dispose(): void { this.stopPreview(); }

  private details(asset: AgentAsset, width: number, rows: number): string[] {
    const playable = asset.kind === "audio" || asset.kind === "music" || asset.kind === "video";
    const lines = [
      bold(`${assetIcon(asset.kind)} ${shorten(asset.description, width - 2)}`),
      dim(basename(asset.path)),
      `Type: ${asset.kind}`,
      `Source: ${asset.source}`,
      `Model: ${asset.model ?? "local"}`,
      `Cost: ${asset.costUsd === undefined ? "unavailable" : formatUsd(asset.costUsd, asset.costEstimated)}`,
      ...(asset.license ? [`License: ${shorten(asset.license, width - 9)}`] : []),
      ...(playable ? [this.options.playing() ? green("▶ playing preview") : cyan("Space plays this asset")] : []),
      ...(asset.kind === "image" ? [cyan("Image saved and ready for the editor agent to place in the video.")] : []),
      ...(asset.kind === "file" ? [cyan("Subtitle or workspace file saved as a reusable asset.")] : []),
    ];
    if (asset.kind === "image" || asset.kind === "video") {
      const previewRows = Math.max(2, rows - lines.length - 1);
      lines.push(...this.previewLines(asset, width, previewRows));
    }
    return lines.slice(0, rows);
  }

  private previewLines(asset: AgentAsset, width: number, rows: number): string[] {
    const size: PreviewSize = { width: Math.max(2, Math.floor((width - 2) / 2) * 2), height: Math.max(2, rows * 2) };
    const playing = asset.kind === "video" && this.options.playing();
    const key = `${asset.path}|${size.width}x${size.height}|${playing}`;
    if (key !== this.preview.key) {
      this.stopPreview();
      this.preview = { key, lines: ["Loading preview…"], stop: () => undefined };
      const controller = new AbortController();
      const show = (text: string) => { if (this.preview.key === key) { this.preview.lines = text.split("\n"); this.context.requestRender(); } };
      if (playing) {
        const stream = (this.options.streamFrames ?? defaultStream)(asset.path, size, show, () => undefined);
        this.preview.stop = () => stream.stop();
      } else {
        this.preview.stop = () => controller.abort();
        void (this.options.loadFrame ?? ((path, wanted, signal) => extractFrame(path, 0, wanted, signal)))(asset.path, size, controller.signal).then(show).catch(() => show("Preview unavailable"));
      }
    }
    return this.preview.lines.slice(0, rows);
  }

  private stopPreview(): void {
    this.preview.stop();
    this.preview = { key: "", lines: [], stop: () => undefined };
  }
}

function defaultStream(path: string, size: PreviewSize, onFrame: (frame: string) => void, onEnd: () => void): PreviewStream {
  return streamPreview({ filePath: path, start: 0, size, fps: 6, onFrame, onEnd, onError: () => onFrame("Preview unavailable") });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc -p tsconfig.test.json && node --test .test-dist/tests/shell-overlays.test.js
npm test
```

Expected: 8 passed in `shell-overlays`, then the whole suite: 163 tests, 162 passed, 1 skipped (the live OpenRouter test), 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/shell tests package.json
git commit -m "feat: add the help, version, project, approval, choice and asset panels"
```

## Task 7: Panels with text fields: model picker, music and export

**Files:**
- Create: `src/shell/overlays/{model-picker-state,model,music,export}.ts`, `tests/shell-panels.test.ts`
- Modify: `tests/model-picker.test.ts` (import path), `package.json` (`test` script)

**Interfaces:**
- Consumes: `Panel`, `box`, `centered`, `listWindow`, `wrapIndex`, `isPrintable`, `setValueAtEnd` (Task 6), pi-tui `Input`, `listProviderModels` shapes (`ProviderModel`), `MUSIC_CATALOG`/`listMusicTracks`/`searchMusicTracks`, `EXPORT_*`/`exportDestination`.
- Produces: the pure picker logic moved out of the old UI: `MODEL_CAPABILITIES`, `initialModelPicker`, `capabilityDefinition`, `filteredPickerModels`, `modelPricePresentation`, `configuredModel`, `configuredCapability`, `providerName` and the types (`model-picker-state.ts`); `ModelPanel(context, services: ModelPanelServices)`; `MusicPanel(context, services: MusicPanelServices, selectedId: string | null, query: string)`; `ExportPanel(context, options: ExportPanelOptions)`. Each takes services as plain callbacks (`listModels`, `save`, `play`, `select`, `perform`, `busy`, `close`), so tests need no network and no FFmpeg.

- [ ] **Step 1: Write the tests**

`tests/model-picker.test.ts` keeps testing the same pure functions from their new home:

Apply this change to `tests/model-picker.test.ts`:

```diff
--- a/tests/model-picker.test.ts
+++ b/tests/model-picker.test.ts
@@ -1,101 +1,101 @@
-import assert from "node:assert/strict";
-import test from "node:test";
-import { formatImagePriceFields, formatPerMillionPrice, formatVideoPriceFields, listProviderModels } from "../src/core/models.js";
-import { capabilityDefinition, filteredPickerModels, initialModelPicker, MODEL_CAPABILITIES, modelPricePresentation } from "../src/ui/ModelPanel.js";
-
-const models = [
-  { id: "gpt-6-luna", name: "GPT-6 Luna" },
-  { id: "gpt-6-sol", name: "GPT-6 Sol" },
-  { id: "openai/gpt-image", name: "OpenAI Image" },
-];
-
-test("opens the model picker at capability selection with an OpenRouter-only base agent", () => {
-  const picker = initialModelPicker();
-  assert.equal(picker.step, "capability");
-  assert.equal(picker.capability, "agent");
-  assert.equal(picker.selectedIndex, 0);
-  assert.equal(picker.query, "");
-  assert.equal(MODEL_CAPABILITIES[0]?.label, "Base agent");
-  assert.deepEqual(capabilityDefinition("agent").providers, ["openrouter"]);
-  assert.deepEqual(capabilityDefinition("video").providers, ["openrouter"]);
-});
-
-test("presents OpenAI transcription and speech pricing by their billing units", () => {
-  assert.deepEqual(modelPricePresentation("openai", "transcription"), {
-    first: "PRICE",
-    second: "BASIS",
-    note: "Transcription pricing is estimated from audio duration.",
-  });
-  assert.deepEqual(modelPricePresentation("openai", "speech"), {
-    first: "TEXT INPUT",
-    second: "AUDIO OUTPUT",
-    note: "Speech prices show the provider's text and audio token rates.",
-  });
-});
-
-test("filters provider models by display name or model ID", () => {
-  const picker = { ...initialModelPicker(), step: "models" as const, provider: "openai" as const, models, query: "luna" };
-  assert.deepEqual(filteredPickerModels(picker).map((model) => model.id), ["gpt-6-luna"]);
-  assert.deepEqual(filteredPickerModels({ ...picker, query: "OPENAI/" }).map((model) => model.id), ["openai/gpt-image"]);
-  assert.equal(filteredPickerModels({ ...picker, query: "missing" }).length, 0);
-});
-
-test("formats provider token prices per million tokens", () => {
-  assert.equal(formatPerMillionPrice("0.0000001"), "$0.10");
-  assert.equal(formatPerMillionPrice("0.00003"), "$30.00");
-  assert.equal(formatPerMillionPrice("0"), "$0");
-  assert.equal(formatPerMillionPrice("unknown"), undefined);
-});
-
-test("formats video SKU prices with their actual billing unit", () => {
-  assert.deepEqual(formatVideoPriceFields({
-    duration_seconds_720p: "0.10",
-    duration_seconds_1080p: "0.20",
-  }), { inputPrice: "$0.10/sec", outputPrice: "$0.20/sec" });
-  assert.deepEqual(formatVideoPriceFields({ cents_per_second_output: "3" }), { inputPrice: "$0.03/sec" });
-  assert.deepEqual(formatVideoPriceFields({ video_tokens: "0.0000035" }), { inputPrice: "$3.50/M tok" });
-});
-
-test("formats image endpoint price ranges and capability-specific headings", () => {
-  assert.deepEqual(formatImagePriceFields([
-    { billable: "input_image", unit: "image", cost_usd: 0.003 },
-    { billable: "output_image", unit: "image", cost_usd: 0.04, variant: "1k" },
-    { billable: "output_image", unit: "image", cost_usd: 0.075, variant: "2k" },
-  ]), { inputPrice: "$0.003/img", outputPrice: "$0.04–$0.075/img" });
-  assert.deepEqual(modelPricePresentation("openrouter", "video"), {
-    first: "FROM",
-    second: "UP TO",
-    note: "Video rates vary by resolution, audio, input type, and generation mode.",
-  });
-  assert.deepEqual(modelPricePresentation("openrouter", "audio"), {
-    first: "INPUT RATE",
-    second: "OUTPUT RATE",
-    note: "Audio rates show whether billing uses tokens or input characters.",
-  });
-});
-
-test("requests only visual tool-capable OpenRouter base-agent models", async () => {
-  const originalFetch = globalThis.fetch;
-  let requested = "";
-  globalThis.fetch = (async (input: string | URL | Request) => {
-    requested = String(input);
-    return Response.json({
-      data: [{
-        id: "vendor/visual-agent",
-        name: "Visual Agent",
-        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
-        pricing: { prompt: "0.000001", completion: "0.000002" },
-      }],
-    });
-  }) as typeof fetch;
-  try {
-    const listed = await listProviderModels("openrouter", "text");
-    const url = new URL(requested);
-    assert.equal(url.searchParams.get("supported_parameters"), "tools");
-    assert.equal(url.searchParams.get("input_modalities"), "text,image");
-    assert.equal(url.searchParams.get("output_modalities"), "text");
-    assert.deepEqual(listed.map((model) => model.id), ["vendor/visual-agent"]);
-  } finally {
-    globalThis.fetch = originalFetch;
-  }
-});
+import assert from "node:assert/strict";
+import test from "node:test";
+import { formatImagePriceFields, formatPerMillionPrice, formatVideoPriceFields, listProviderModels } from "../src/core/models.js";
+import { capabilityDefinition, filteredPickerModels, initialModelPicker, MODEL_CAPABILITIES, modelPricePresentation } from "../src/shell/overlays/model-picker-state.js";
+
+const models = [
+  { id: "gpt-6-luna", name: "GPT-6 Luna" },
+  { id: "gpt-6-sol", name: "GPT-6 Sol" },
+  { id: "openai/gpt-image", name: "OpenAI Image" },
+];
+
+test("opens the model picker at capability selection with an OpenRouter-only base agent", () => {
+  const picker = initialModelPicker();
+  assert.equal(picker.step, "capability");
+  assert.equal(picker.capability, "agent");
+  assert.equal(picker.selectedIndex, 0);
+  assert.equal(picker.query, "");
+  assert.equal(MODEL_CAPABILITIES[0]?.label, "Base agent");
+  assert.deepEqual(capabilityDefinition("agent").providers, ["openrouter"]);
+  assert.deepEqual(capabilityDefinition("video").providers, ["openrouter"]);
+});
+
+test("presents OpenAI transcription and speech pricing by their billing units", () => {
+  assert.deepEqual(modelPricePresentation("openai", "transcription"), {
+    first: "PRICE",
+    second: "BASIS",
+    note: "Transcription pricing is estimated from audio duration.",
+  });
+  assert.deepEqual(modelPricePresentation("openai", "speech"), {
+    first: "TEXT INPUT",
+    second: "AUDIO OUTPUT",
+    note: "Speech prices show the provider's text and audio token rates.",
+  });
+});
+
+test("filters provider models by display name or model ID", () => {
+  const picker = { ...initialModelPicker(), step: "models" as const, provider: "openai" as const, models, query: "luna" };
+  assert.deepEqual(filteredPickerModels(picker).map((model) => model.id), ["gpt-6-luna"]);
+  assert.deepEqual(filteredPickerModels({ ...picker, query: "OPENAI/" }).map((model) => model.id), ["openai/gpt-image"]);
+  assert.equal(filteredPickerModels({ ...picker, query: "missing" }).length, 0);
+});
+
+test("formats provider token prices per million tokens", () => {
+  assert.equal(formatPerMillionPrice("0.0000001"), "$0.10");
+  assert.equal(formatPerMillionPrice("0.00003"), "$30.00");
+  assert.equal(formatPerMillionPrice("0"), "$0");
+  assert.equal(formatPerMillionPrice("unknown"), undefined);
+});
+
+test("formats video SKU prices with their actual billing unit", () => {
+  assert.deepEqual(formatVideoPriceFields({
+    duration_seconds_720p: "0.10",
+    duration_seconds_1080p: "0.20",
+  }), { inputPrice: "$0.10/sec", outputPrice: "$0.20/sec" });
+  assert.deepEqual(formatVideoPriceFields({ cents_per_second_output: "3" }), { inputPrice: "$0.03/sec" });
+  assert.deepEqual(formatVideoPriceFields({ video_tokens: "0.0000035" }), { inputPrice: "$3.50/M tok" });
+});
+
+test("formats image endpoint price ranges and capability-specific headings", () => {
+  assert.deepEqual(formatImagePriceFields([
+    { billable: "input_image", unit: "image", cost_usd: 0.003 },
+    { billable: "output_image", unit: "image", cost_usd: 0.04, variant: "1k" },
+    { billable: "output_image", unit: "image", cost_usd: 0.075, variant: "2k" },
+  ]), { inputPrice: "$0.003/img", outputPrice: "$0.04–$0.075/img" });
+  assert.deepEqual(modelPricePresentation("openrouter", "video"), {
+    first: "FROM",
+    second: "UP TO",
+    note: "Video rates vary by resolution, audio, input type, and generation mode.",
+  });
+  assert.deepEqual(modelPricePresentation("openrouter", "audio"), {
+    first: "INPUT RATE",
+    second: "OUTPUT RATE",
+    note: "Audio rates show whether billing uses tokens or input characters.",
+  });
+});
+
+test("requests only visual tool-capable OpenRouter base-agent models", async () => {
+  const originalFetch = globalThis.fetch;
+  let requested = "";
+  globalThis.fetch = (async (input: string | URL | Request) => {
+    requested = String(input);
+    return Response.json({
+      data: [{
+        id: "vendor/visual-agent",
+        name: "Visual Agent",
+        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
+        pricing: { prompt: "0.000001", completion: "0.000002" },
+      }],
+    });
+  }) as typeof fetch;
+  try {
+    const listed = await listProviderModels("openrouter", "text");
+    const url = new URL(requested);
+    assert.equal(url.searchParams.get("supported_parameters"), "tools");
+    assert.equal(url.searchParams.get("input_modalities"), "text,image");
+    assert.equal(url.searchParams.get("output_modalities"), "text");
+    assert.deepEqual(listed.map((model) => model.id), ["vendor/visual-agent"]);
+  } finally {
+    globalThis.fetch = originalFetch;
+  }
+});
```

Create `tests/shell-panels.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ProviderModel } from "../src/core/models.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";
import { MUSIC_CATALOG } from "../src/core/music-catalog.js";
import { ExportPanel } from "../src/shell/overlays/export.js";
import { ModelPanel, type ModelPanelServices } from "../src/shell/overlays/model.js";
import { MusicPanel, type MusicPanelServices } from "../src/shell/overlays/music.js";
import { plain } from "../src/shell/views/style.js";

const ROWS = 30;
const WIDTH = 110;
const context = { bandRows: () => ROWS, requestRender: () => undefined };
const KEY = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", esc: "\x1b", tab: "\t", shiftTab: "\x1b[Z", backspace: "\x7f", ctrlK: "\x0b", ctrlU: "\x15" };
const screen = (lines: string[]) => lines.map(plain).join("\n");
const later = () => new Promise((resolve) => setTimeout(resolve, 10));
const type = (panel: { handleInput(data: string): void }, text: string) => { for (const character of text) panel.handleInput(character); };
const assertFills = (lines: string[]) => {
  assert.equal(lines.length, ROWS);
  assert.ok(lines.every((line) => visibleWidth(line) === WIDTH));
};

function modelServices(overrides: Partial<ModelPanelServices> = {}) {
  const log = { loaders: [] as Array<string | null>, saved: [] as unknown[], closed: 0, listed: [] as string[] };
  const services: ModelPanelServices = {
    settings: () => structuredClone(DEFAULT_SETTINGS),
    keys: () => ({ openai: false, openrouter: true }),
    listModels: async (provider, slot) => {
      log.listed.push(`${provider}/${slot}`);
      return [{ id: "openai/gpt-6-luna", name: "GPT-6 Luna", inputPrice: "$0.10", outputPrice: "$0.50" }, { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", inputPrice: "$0.15", outputPrice: "$0.50" }] as ProviderModel[];
    },
    save: async (choice) => { log.saved.push(choice); },
    setLoader: (loader) => { log.loaders.push(loader ? loader.stage : null); },
    close: () => { log.closed += 1; },
    ...overrides,
  };
  return { services, log };
}

test("model picker: capability, then provider, then a searchable list, then save and close", async () => {
  const { services, log } = modelServices();
  const panel = new ModelPanel(context, services);
  assertFills(panel.render(WIDTH));
  assert.match(screen(panel.render(WIDTH)), /Select default model +Capability[\s\S]*> Base agent +OpenRouter \| [\s\S]*Transcription[\s\S]*Esc close/);
  panel.handleInput(KEY.enter);
  assert.match(screen(panel.render(WIDTH)), /Base agent \/ provider[\s\S]*> OpenRouter +configured \|/);
  panel.handleInput(KEY.enter);
  assert.equal(panel.picker.loading, true);
  assert.match(screen(panel.render(WIDTH)), /Loading provider catalog/);
  await later();
  assert.equal(panel.picker.loading, false);
  assert.deepEqual(log.loaders, ["Loading openrouter text models", null]);
  let text = screen(panel.render(WIDTH));
  assert.match(text, /Base agent \/ OpenRouter[\s\S]*Search >[\s\S]*MODEL +INPUT \/ 1M +OUTPUT \/ 1M[\s\S]*GPT-6 Luna \| openai\/gpt-6-luna[\s\S]*GLM 5\.3 Flash/);
  type(panel, "glm");
  text = screen(panel.render(WIDTH));
  assert.ok(!text.includes("GPT-6 Luna"), "the search narrows the list");
  assert.equal(panel.picker.selectedIndex, 0);
  panel.handleInput(KEY.enter);
  await later();
  assert.deepEqual(log.saved, [{ capability: "agent", provider: "openrouter", slot: "text", model: { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", inputPrice: "$0.15", outputPrice: "$0.50" } }]);
  assert.equal(log.closed, 1);
  assert.deepEqual(log.loaders.slice(-2), ["Saving model default", null]);
});

test("model picker: a failed catalog or save shows the reason, Enter retries, and Escape steps back and out", async () => {
  let attempts = 0;
  const { services, log } = modelServices({
    listModels: async () => { attempts += 1; if (attempts === 1) throw new Error("OpenRouter is unreachable"); return [{ id: "a/b", name: "AB" }]; },
    save: async () => { throw new Error("Could not write settings"); },
  });
  const panel = new ModelPanel(context, services);
  panel.handleInput(KEY.enter); panel.handleInput(KEY.enter);
  await later();
  assert.match(screen(panel.render(WIDTH)), /OpenRouter is unreachable[\s\S]*Press Enter to retry/);
  panel.handleInput(KEY.enter);
  await later();
  assert.match(screen(panel.render(WIDTH)), /AB \| a\/b/);
  panel.handleInput(KEY.enter);
  await later();
  assert.match(screen(panel.render(WIDTH)), /Could not write settings/);
  assert.equal(log.closed, 0, "stays open after a failed save");
  panel.handleInput(KEY.esc);
  assert.equal(panel.picker.step, "provider");
  panel.handleInput(KEY.esc);
  assert.equal(panel.picker.step, "capability");
  panel.handleInput(KEY.esc);
  assert.equal(log.closed, 1);
});

test("model picker ignores a slow answer after the user went back", async () => {
  let release: (models: ProviderModel[]) => void = () => undefined;
  const { services } = modelServices({ listModels: () => new Promise<ProviderModel[]>((resolve) => { release = resolve; }) });
  const panel = new ModelPanel(context, services);
  panel.handleInput(KEY.enter); panel.handleInput(KEY.enter);
  panel.handleInput(KEY.esc);
  release([{ id: "late/model", name: "Late" }]);
  await later();
  assert.equal(panel.picker.step, "provider");
  assert.deepEqual(panel.picker.models, []);
});

function musicServices(overrides: Partial<MusicPanelServices> = {}) {
  const log = { played: [] as string[], stopped: 0, selected: [] as string[], cleared: 0, status: [] as string[], closed: 0, ended: () => undefined as void };
  const services: MusicPanelServices = {
    play: (id, callbacks) => { log.played.push(id); log.ended = callbacks.onEnd; },
    stop: () => { log.stopped += 1; },
    select: async (track) => { log.selected.push(track.id); },
    clearSelection: async () => { log.cleared += 1; },
    setStatus: (text) => { log.status.push(text); },
    close: () => { log.closed += 1; },
    ...overrides,
  };
  return { services, log };
}

test("music: lists the catalog, searches by typing, previews with Space, and selects with Enter", async () => {
  const { services, log } = musicServices();
  const panel = new MusicPanel(context, services, null, "");
  assertFills(panel.render(WIDTH));
  const first = MUSIC_CATALOG[0]!;
  assert.match(screen(panel.render(WIDTH)), new RegExp(`Background music[\\s\\S]*Search ›[\\s\\S]*TITLE +MOOD[\\s\\S]*› +${first.title.slice(0, 10)}`));
  panel.handleInput(" ");
  assert.deepEqual(log.played, [first.id], "Space previews instead of typing a space");
  assert.match(screen(panel.render(WIDTH)), /› ▶ /);
  panel.handleInput(" ");
  assert.equal(log.stopped, 1, "Space again stops it");
  log.ended();
  type(panel, "zzzzzz");
  assert.match(screen(panel.render(WIDTH)), /No tracks match this search/);
  panel.handleInput(KEY.ctrlU);
  assert.equal(panel.tracks.length, MUSIC_CATALOG.length);
  panel.handleInput(KEY.down);
  panel.handleInput(KEY.enter);
  await later();
  assert.deepEqual(log.selected, [MUSIC_CATALOG[1]!.id]);
  assert.equal(log.closed, 1);
  assert.match(screen(panel.render(WIDTH)), /✓/, "the chosen track is ticked");
});

test("music: Ctrl+K clears the saved choice, a failed save is reported, Escape stops the preview and closes", async () => {
  const { services, log } = musicServices({ select: async () => { throw new Error("Could not save"); } });
  const panel = new MusicPanel(context, services, MUSIC_CATALOG[2]!.id, "");
  assert.match(screen(panel.render(WIDTH)), /✓/);
  panel.handleInput(KEY.ctrlK);
  await later();
  assert.equal(log.cleared, 1);
  assert.ok(log.status.includes("Background music selection cleared"));
  assert.ok(!screen(panel.render(WIDTH)).includes("✓"));
  panel.handleInput(KEY.enter);
  await later();
  assert.ok(log.status.includes("Could not save"));
  assert.equal(log.closed, 0);
  panel.handleInput(KEY.esc);
  assert.deepEqual([log.closed, log.stopped > 0], [1, true]);
  const searched = new MusicPanel(context, musicServices().services, null, "calm");
  assert.ok(searched.tracks.length > 0 && searched.tracks.length < MUSIC_CATALOG.length, "an opening query filters the list");
});

function exportPanel(overrides: { busy?: () => boolean } = {}) {
  const log = { performed: [] as unknown[], closed: 0 };
  const panel = new ExportPanel(context, {
    sourcePath: "C:/videos/demo.mp4", destination: "C:/videos/demo-export.mp4", format: "mp4",
    busy: overrides.busy ?? (() => false), perform: (choice) => { log.performed.push(choice); }, close: () => { log.closed += 1; },
  });
  return { panel, log };
}

test("export: edit the destination, change format and compression, and start the export", () => {
  const { panel, log } = exportPanel();
  assertFills(panel.render(WIDTH));
  let text = screen(panel.render(WIDTH));
  assert.match(text, /Export video[\s\S]*Destination[\s\S]*C:\/videos\/demo-export\.mp4[\s\S]*› \[ MP4 \] +\[ MKV \][\s\S]*› Balanced/);
  type(panel, "x");
  assert.equal(panel.destination, "C:/videos/demo-export.mp4x");
  panel.handleInput(KEY.backspace);
  panel.handleInput(KEY.tab);
  assert.equal(panel.focus, "format");
  panel.handleInput(KEY.right);
  assert.equal(panel.format, "mkv");
  assert.match(panel.destination.replace(/\\/g, "/"), /demo-export\.mkv$/, "the extension follows the format");
  panel.handleInput(KEY.tab);
  assert.equal(panel.focus, "compression");
  panel.handleInput(KEY.up);
  assert.equal(panel.preset, "high");
  text = screen(panel.render(WIDTH));
  assert.match(text, /› High quality/);
  panel.handleInput(KEY.shiftTab);
  assert.equal(panel.focus, "format");
  panel.handleInput(KEY.enter);
  assert.equal(log.performed.length, 1);
  assert.deepEqual({ ...(log.performed[0] as object), destination: String((log.performed[0] as { destination: string }).destination).replace(/\\/g, "/") }, { destination: "C:/videos/demo-export.mkv", format: "mkv", preset: "high" });
  panel.handleInput(KEY.esc);
  assert.equal(log.closed, 1);
});

test("export: while an export runs the panel ignores every key, including Escape", () => {
  const { panel, log } = exportPanel({ busy: () => true });
  panel.handleInput(KEY.enter);
  panel.handleInput(KEY.esc);
  type(panel, "abc");
  assert.deepEqual([log.performed.length, log.closed, panel.destination], [0, 0, "C:/videos/demo-export.mp4"]);
});
```

Add `shell-panels` to the `test` script:

```diff
--- a/package.json
+++ b/package.json
@@ -17,7 +17,7 @@
     "build": "tsup",
     "check": "tsc --noEmit",
     "dev": "tsx src/cli.tsx",
-    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/shell-layout.test.js .test-dist/tests/shell-state.test.js .test-dist/tests/shell-keymap.test.js .test-dist/tests/shell-preview.test.js .test-dist/tests/shell-views.test.js .test-dist/tests/shell-screen.test.js .test-dist/tests/shell-overlays.test.js .test-dist/tests/transcription.test.js",
+    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/shell-layout.test.js .test-dist/tests/shell-state.test.js .test-dist/tests/shell-keymap.test.js .test-dist/tests/shell-preview.test.js .test-dist/tests/shell-views.test.js .test-dist/tests/shell-screen.test.js .test-dist/tests/shell-overlays.test.js .test-dist/tests/shell-panels.test.js .test-dist/tests/transcription.test.js",
     "quality": "npm run check && npm test && npm run build",
     "release:check": "npm run quality && npm pack --dry-run",
     "prepublishOnly": "npm run quality"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL with `Cannot find module` for `src/shell/overlays/model-picker-state.js`, `model.js`, `music.js` and `export.js`.

- [ ] **Step 3: Write the implementation**

Behaviour that differs from the old panels, on purpose: text fields are pi-tui `Input` (so Ctrl+A and Ctrl+E move the cursor; Ctrl+U clears the model search, as in the music search), a prefilled field starts with the cursor at the end (`setValueAtEnd`), and the model panel ignores a slow catalog answer that arrives after the user went back.

Create `src/shell/overlays/model-picker-state.ts`:

```typescript
import type { ProviderModel } from "../../core/models.js";
import type { DumbEditorSettings, ModelProvider, ModelSlot, OpenAISlot, OpenRouterSlot } from "../../core/settings.js";

export type ModelCapability = "agent" | "image" | "audio" | "music" | "video" | "transcription" | "speech";
export type ModelPickerStep = "capability" | "provider" | "models";

export interface CapabilityDefinition {
  id: ModelCapability;
  label: string;
  detail: string;
  slot: ModelSlot;
  providers: ModelProvider[];
}

export const MODEL_CAPABILITIES: CapabilityDefinition[] = [
  { id: "agent", label: "Base agent", detail: "plans edits and runs tools", slot: "text", providers: ["openrouter"] },
  { id: "image", label: "Image", detail: "generated overlays and artwork", slot: "image", providers: ["openrouter"] },
  { id: "audio", label: "Audio", detail: "generated sound and speech", slot: "audio", providers: ["openrouter"] },
  { id: "music", label: "Music", detail: "generated background music", slot: "music", providers: ["openrouter"] },
  { id: "video", label: "Video", detail: "generated clips", slot: "video", providers: ["openrouter"] },
  { id: "transcription", label: "Transcription", detail: "speech to subtitles", slot: "transcription", providers: ["openai"] },
  { id: "speech", label: "Speech", detail: "text to speech", slot: "speech", providers: ["openai"] },
];

export interface ModelPickerState {
  step: ModelPickerStep;
  capability: ModelCapability;
  provider: ModelProvider | null;
  slot: ModelSlot;
  models: ProviderModel[];
  query: string;
  selectedIndex: number;
  loading: boolean;
  error: string | null;
}

export function initialModelPicker(): ModelPickerState {
  return {
    step: "capability",
    capability: "agent",
    provider: null,
    slot: "text",
    models: [],
    query: "",
    selectedIndex: 0,
    loading: false,
    error: null,
  };
}

export function capabilityDefinition(capability: ModelCapability): CapabilityDefinition {
  return MODEL_CAPABILITIES.find((item) => item.id === capability) ?? MODEL_CAPABILITIES[0]!;
}

export function filteredPickerModels(picker: ModelPickerState): ProviderModel[] {
  const query = picker.query.trim().toLowerCase();
  if (!query) return picker.models;
  return picker.models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query));
}

export function modelPricePresentation(provider: ModelProvider | null, slot: ModelSlot): {
  first: string;
  second: string;
  note: string;
} {
  if (provider === "openai" && slot === "transcription") {
    return { first: "PRICE", second: "BASIS", note: "Transcription pricing is estimated from audio duration." };
  }
  if (provider === "openai" && slot === "speech") {
    return { first: "TEXT INPUT", second: "AUDIO OUTPUT", note: "Speech prices show the provider's text and audio token rates." };
  }
  if (provider === "openrouter" && slot === "image") {
    return { first: "INPUT RATE", second: "OUTPUT RATE", note: "Image rates show their billing unit; ranges cover provider variants." };
  }
  if (provider === "openrouter" && slot === "audio") {
    return { first: "INPUT RATE", second: "OUTPUT RATE", note: "Audio rates show whether billing uses tokens or input characters." };
  }
  if (provider === "openrouter" && slot === "music") {
    return { first: "PRICE", second: "BASIS", note: "Music prices are per generated song or clip." };
  }
  if (provider === "openrouter" && slot === "video") {
    return { first: "FROM", second: "UP TO", note: "Video rates vary by resolution, audio, input type, and generation mode." };
  }
  return { first: "INPUT / 1M", second: "OUTPUT / 1M", note: "Token prices are USD per 1M tokens." };
}

export function configuredModel(settings: DumbEditorSettings, provider: ModelProvider | null, slot: ModelSlot): string {
  if (provider === "openai") return settings.models.openai[slot as OpenAISlot] ?? "";
  if (provider === "openrouter") return settings.models.openrouter[slot as OpenRouterSlot] ?? "";
  return "";
}

export function providerName(provider: ModelProvider | null): string {
  return provider === "openrouter" ? "OpenRouter" : "OpenAI";
}

export function configuredCapability(settings: DumbEditorSettings, capability: CapabilityDefinition): string {
  if (capability.id === "agent") return `${providerName(settings.agent.provider)} | ${settings.models[settings.agent.provider].text}`;
  const provider = capability.providers[0]!;
  return `${providerName(provider)} | ${configuredModel(settings, provider, capability.slot)}`;
}
```

Create `src/shell/overlays/model.ts`:

```typescript
import { Input, matchesKey } from "@earendil-works/pi-tui";
import type { ProviderModel } from "../../core/models.js";
import type { DumbEditorSettings, ModelProvider, ModelSlot } from "../../core/settings.js";
import type { Loader } from "../state/shell-state.js";
import { bold, cyan, dim, inverse, yellow } from "../views/style.js";
import { box, centered, isPrintable, listWindow, Panel, wrapIndex, type PanelContext } from "./frame.js";
import {
  capabilityDefinition, configuredCapability, configuredModel, filteredPickerModels, initialModelPicker, MODEL_CAPABILITIES,
  modelPricePresentation, providerName, type ModelCapability, type ModelPickerState, type ModelPickerStep,
} from "./model-picker-state.js";

export interface ModelPanelServices {
  settings(): DumbEditorSettings;
  keys(): { openai: boolean; openrouter: boolean };
  listModels(provider: ModelProvider, slot: ModelSlot): Promise<ProviderModel[]>;
  /** Save the choice. Reject with an Error to show its message in the panel and stay open. */
  save(choice: { capability: ModelCapability; provider: ModelProvider; slot: ModelSlot; model: ProviderModel }): Promise<void>;
  setLoader(loader: Loader | null): void;
  close(): void;
}

/** Pick a default model: capability, then provider, then a searchable list of that provider's models. */
export class ModelPanel extends Panel {
  picker: ModelPickerState = initialModelPicker();
  private request = 0;
  private readonly search = new Input({ prompt: "Search > " });

  constructor(context: PanelContext, private readonly services: ModelPanelServices) { super(context); }

  render(width: number): string[] {
    const modalWidth = Math.max(20, Math.min(96, width - 4));
    const modalHeight = Math.max(8, Math.min(26, this.rows - 2));
    const inner = Math.max(1, modalHeight - 2);
    const body = this.body(modalWidth - 6, inner - 2);
    const lines = [this.header(), ...body.slice(0, inner - 2)];
    while (lines.length < inner - 1) lines.push("");
    lines.push(this.footer());
    return centered(box(lines, modalWidth, { border: "double", color: cyan, paddingX: 2 }), width, this.rows);
  }

  handleInput(data: string): void {
    const picker = this.picker;
    if (matchesKey(data, "escape") || matchesKey(data, "left")) { this.back(); return; }
    if (picker.loading) return;
    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "tab")) {
      const count = picker.step === "capability" ? MODEL_CAPABILITIES.length
        : picker.step === "provider" ? capabilityDefinition(picker.capability).providers.length
          : filteredPickerModels(picker).length;
      if (count > 0) this.picker = { ...picker, selectedIndex: wrapIndex(picker.selectedIndex, matchesKey(data, "up") ? -1 : 1, count) };
    } else if (matchesKey(data, "enter") || matchesKey(data, "right")) {
      void this.choose();
      return;
    } else if (picker.step === "models" && !picker.error && (isPrintable(data) || matchesKey(data, "backspace") || matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+a") || matchesKey(data, "ctrl+e") || matchesKey(data, "delete"))) {
      const before = this.search.getValue();
      this.search.handleInput(data);
      if (this.search.getValue() !== before) this.picker = { ...picker, query: this.search.getValue(), selectedIndex: 0 };
    }
    this.context.requestRender();
  }

  private async choose(): Promise<void> {
    const picker = this.picker;
    if (picker.step === "capability") {
      const capability = MODEL_CAPABILITIES[picker.selectedIndex] ?? MODEL_CAPABILITIES[0]!;
      this.picker = { ...initialModelPicker(), step: "provider", capability: capability.id, slot: capability.slot };
      this.context.requestRender();
      return;
    }
    if (picker.step === "provider") {
      const capability = capabilityDefinition(picker.capability);
      await this.load(capability.providers[picker.selectedIndex] ?? capability.providers[0]!, capability.slot);
      return;
    }
    if (!picker.provider) return;
    if (picker.error) { await this.load(picker.provider, picker.slot); return; }
    const selected = filteredPickerModels(picker)[picker.selectedIndex];
    if (!selected) return;
    this.services.setLoader({ source: "Editor", stage: "Saving model default" });
    try {
      await this.services.save({ capability: picker.capability, provider: picker.provider, slot: picker.slot, model: selected });
      this.services.close();
    } catch (error) {
      this.picker = { ...this.picker, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.services.setLoader(null);
      this.context.requestRender();
    }
  }

  private async load(provider: ModelProvider, slot: ModelSlot): Promise<void> {
    const request = ++this.request;
    this.search.setValue("");
    this.picker = { ...this.picker, step: "models", provider, slot, models: [], query: "", selectedIndex: 0, loading: true, error: null };
    this.services.setLoader({ source: "Editor", stage: `Loading ${provider} ${slot} models` });
    this.context.requestRender();
    try {
      const models = await this.services.listModels(provider, slot);
      if (request !== this.request) return;
      this.picker = { ...this.picker, models, loading: false, error: null };
    } catch (error) {
      if (request !== this.request) return;
      this.picker = { ...this.picker, models: [], loading: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (request === this.request) this.services.setLoader(null);
      this.context.requestRender();
    }
  }

  private back(): void {
    this.request += 1;
    this.services.setLoader(null);
    const picker = this.picker;
    if (picker.step === "capability") { this.services.close(); return; }
    if (picker.step === "provider") this.picker = initialModelPicker();
    else {
      const capability = capabilityDefinition(picker.capability);
      this.picker = {
        ...initialModelPicker(), step: "provider", capability: picker.capability, slot: picker.slot,
        selectedIndex: Math.max(0, capability.providers.indexOf(picker.provider ?? capability.providers[0]!)),
      };
    }
    this.context.requestRender();
  }

  private header(): string {
    const picker = this.picker;
    const capability = capabilityDefinition(picker.capability);
    const path = picker.step === "capability" ? "Capability"
      : picker.step === "provider" ? `${capability.label} / provider` : `${capability.label} / ${providerName(picker.provider)}`;
    return `${bold(cyan("Select default model"))}  ${dim(path)}`;
  }

  private footer(): string {
    const step: ModelPickerStep = this.picker.step;
    return dim(`Up/Down/Tab move | Enter ${step === "models" ? "select" : "open"}${step === "models" ? " | type to search | Ctrl+U clears" : ""} | Esc ${step === "capability" ? "close" : "back"}`);
  }

  private body(width: number, height: number): string[] {
    const picker = this.picker;
    const settings = this.services.settings();
    if (picker.step === "capability") {
      return ["", ...MODEL_CAPABILITIES.map((capability, index) => choice(index === picker.selectedIndex, capability.label, `${configuredCapability(settings, capability)} | ${capability.detail}`))];
    }
    if (picker.step === "provider") {
      const capability = capabilityDefinition(picker.capability);
      const keys = this.services.keys();
      return ["", ...capability.providers.map((provider, index) => {
        const active = picker.capability === "agent" && settings.agent.provider === provider;
        return choice(index === picker.selectedIndex, providerName(provider), `${keys[provider] ? "configured" : "key missing"} | ${configuredModel(settings, provider, capability.slot)}${active ? " | active" : ""}`);
      })];
    }
    return this.modelList(settings, width, height);
  }

  private modelList(settings: DumbEditorSettings, width: number, height: number): string[] {
    const picker = this.picker;
    this.search.focused = this.focused && !picker.loading;
    const models = filteredPickerModels(picker);
    const room = Math.max(3, height - 7);
    const { start, end } = listWindow(models.length, picker.selectedIndex, room);
    const current = configuredModel(settings, picker.provider, picker.slot);
    const price = modelPricePresentation(picker.provider, picker.slot);
    const columns = columnWidths(width);
    const lines = ["", ...box(this.search.render(Math.max(8, width - 4)), width, { border: "round", color: dim })];
    if (picker.loading) lines.push(yellow("Loading provider catalog..."));
    else if (picker.error) lines.push(yellow(picker.error), dim("Press Enter to retry."));
    else if (models.length === 0) lines.push(dim(`No models match "${picker.query}".`));
    else {
      lines.push(dim(`  ${cell("MODEL", columns.model)} ${cell(price.first, columns.price)} ${cell(price.second, columns.price)}`));
      for (const [offset, model] of models.slice(start, end).entries()) {
        const label = `${model.id === current ? "* " : ""}${model.name}${model.name === model.id ? "" : ` | ${model.id}`}`;
        const text = `${start + offset === picker.selectedIndex ? "> " : "  "}${cell(label, columns.model)} ${cell(model.inputPrice ?? "-", columns.price)} ${cell(model.outputPrice ?? "-", columns.price)}`;
        lines.push(start + offset === picker.selectedIndex ? inverse(cyan(text)) : text);
      }
      lines.push(dim(`${models.length} models${models.length > room ? ` | showing ${start + 1}-${end}` : ""}`), dim(price.note));
    }
    return lines;
  }
}

function choice(selected: boolean, primary: string, secondary: string): string {
  const text = `${selected ? "> " : "  "}${primary}  ${secondary}`;
  return selected ? inverse(cyan(text)) : text;
}

function columnWidths(width: number): { model: number; price: number } {
  const price = width >= 80 ? 18 : width >= 54 ? 12 : 8;
  return { model: Math.max(8, width - (price * 2) - 4), price };
}

function cell(value: string, width: number): string {
  if (value.length > width) return width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 3)}...`;
  return value.padEnd(width);
}
```

Create `src/shell/overlays/music.ts`:

```typescript
import { Input, matchesKey } from "@earendil-works/pi-tui";
import { listMusicTracks, searchMusicTracks, type MusicTrack } from "../../core/music-catalog.js";
import { bold, cyan, dim, inverse, yellow } from "../views/style.js";
import { box, fill, isPrintable, listWindow, Panel, setValueAtEnd, wrapIndex, type PanelContext } from "./frame.js";

export interface MusicPanelServices {
  /** Start previewing a track; `onEnd` and `onError` report back when it stops. Throws if it cannot start. */
  play(trackId: string, callbacks: { onEnd(): void; onError(error: Error): void }): void;
  stop(): void;
  /** Save the choice. Reject with an Error to report it in the status line. */
  select(track: MusicTrack): Promise<void>;
  clearSelection(): Promise<void>;
  setStatus(text: string): void;
  close(): void;
}

/** Search, preview and choose background music from the open-license catalog. */
export class MusicPanel extends Panel {
  private selected = 0;
  private previewId: string | null = null;
  private readonly search = new Input({ prompt: "Search › " });

  constructor(context: PanelContext, private readonly services: MusicPanelServices, private selectedId: string | null, query: string) {
    super(context);
    setValueAtEnd(this.search, query);
  }

  get tracks(): MusicTrack[] {
    const query = this.search.getValue();
    return query.trim() ? searchMusicTracks(query) : listMusicTracks();
  }

  render(width: number): string[] {
    this.search.focused = this.focused;
    const tracks = this.tracks;
    this.selected = Math.min(this.selected, Math.max(0, tracks.length - 1));
    const { start, end } = listWindow(tracks.length, this.selected, this.rows - 12);
    const highlighted = tracks[this.selected];
    const lines = [
      `${bold(cyan("Background music"))}  ${dim("open license catalog")}`,
      ...this.search.render(Math.max(10, width - 8)),
      dim("  TITLE                    MOOD                 LENGTH   LICENSE"),
      ...(tracks.length === 0 ? [yellow("No tracks match this search.")] : tracks.slice(start, end).map((track, offset) => {
        const index = start + offset;
        const marker = this.previewId === track.id ? "▶" : this.selectedId === track.id ? "✓" : " ";
        const text = `${index === this.selected ? "›" : " "} ${marker} ${fit(track.title, 24)} ${fit(track.moods.slice(0, 2).join(", "), 20)} ${fit(formatDuration(track.durationSeconds), 8)} CC BY 4.0`;
        return index === this.selected ? inverse(cyan(text)) : text;
      })),
      "",
      ...(highlighted
        ? [bold(`${highlighted.title} · ${highlighted.artist}`), highlighted.description, dim(highlighted.license.attribution)]
        : [dim("Try a mood such as bright, calm, reflective, or uplifting.")]),
      dim("↑/↓ choose · Space preview/stop · Enter select · type to search · Ctrl+U clear · Ctrl+K unselect · Esc close"),
    ];
    return fill(box(lines, width, { border: "round", color: cyan, paddingX: 2 }), width, this.rows);
  }

  handleInput(data: string): void {
    const tracks = this.tracks;
    if (matchesKey(data, "escape") || matchesKey(data, "left")) { this.stopPreview(); this.services.close(); return; }
    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "tab")) {
      this.selected = wrapIndex(this.selected, matchesKey(data, "up") ? -1 : 1, tracks.length);
    } else if (data === " ") {
      this.togglePreview(tracks[this.selected]);
    } else if (matchesKey(data, "enter") || matchesKey(data, "right")) {
      const track = tracks[this.selected];
      if (track) void this.choose(track);
      return;
    } else if (matchesKey(data, "ctrl+k")) {
      void this.services.clearSelection().then(() => { this.selectedId = null; this.services.setStatus("Background music selection cleared"); this.context.requestRender(); })
        .catch((error: unknown) => this.services.setStatus(message(error)));
      return;
    } else if (matchesKey(data, "ctrl+u")) {
      this.search.setValue(""); this.selected = 0;
    } else if (isPrintable(data) || matchesKey(data, "backspace") || matchesKey(data, "delete")) {
      const before = this.search.getValue();
      this.search.handleInput(data);
      if (this.search.getValue() !== before) this.selected = 0;
    }
    this.context.requestRender();
  }

  dispose(): void { this.stopPreview(); }

  private togglePreview(track: MusicTrack | undefined): void {
    if (!track) return;
    if (this.previewId === track.id) { this.stopPreview(); return; }
    try {
      this.services.play(track.id, {
        onEnd: () => { this.previewId = null; this.context.requestRender(); },
        onError: (error) => { this.previewId = null; this.services.setStatus(error.message); this.context.requestRender(); },
      });
      this.previewId = track.id;
    } catch (error) {
      this.services.setStatus(message(error));
    }
  }

  private stopPreview(): void {
    this.services.stop();
    this.previewId = null;
  }

  private async choose(track: MusicTrack): Promise<void> {
    try {
      await this.services.select(track);
      this.stopPreview();
      this.selectedId = track.id;
      this.services.close();
    } catch (error) {
      this.services.setStatus(message(error));
    }
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function fit(value: string, width: number): string {
  const clipped = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
  return clipped.padEnd(width);
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
```

Create `src/shell/overlays/export.ts`:

```typescript
import { Input, matchesKey } from "@earendil-works/pi-tui";
import { EXPORT_FORMATS, EXPORT_PRESET_DETAILS, EXPORT_PRESETS, exportDestination, type ExportFormat, type ExportPreset } from "../../core/export.js";
import { bold, cyan, dim, gray, inverse } from "../views/style.js";
import { box, centered, Panel, setValueAtEnd, type PanelContext } from "./frame.js";

export type ExportFocus = "path" | "format" | "compression";
const FOCUS_ORDER: readonly ExportFocus[] = ["path", "format", "compression"];

export interface ExportPanelOptions {
  sourcePath: string;
  destination: string;
  format: ExportFormat;
  /** True while an export runs; the panel then ignores keys. */
  busy(): boolean;
  perform(choice: { destination: string; format: ExportFormat; preset: ExportPreset }): void;
  close(): void;
}

/** Choose where to save, MP4 or MKV, and how much to compress. */
export class ExportPanel extends Panel {
  format: ExportFormat;
  preset: ExportPreset = "balanced";
  focus: ExportFocus = "path";
  private readonly path = new Input({ prompt: "" });

  constructor(context: PanelContext, private readonly options: ExportPanelOptions) {
    super(context);
    this.format = options.format;
    setValueAtEnd(this.path, options.destination);
  }

  get destination(): string { return this.path.getValue(); }

  render(width: number): string[] {
    this.path.focused = this.focused && this.focus === "path";
    const modalWidth = Math.max(36, Math.min(96, width - 4));
    const preset = EXPORT_PRESET_DETAILS.find((item) => item.id === this.preset) ?? EXPORT_PRESET_DETAILS[2]!;
    const lines = [
      bold(cyan("Export video")),
      dim("Destination"),
      ...box(this.path.render(Math.max(8, modalWidth - 10)), modalWidth - 6, { border: "round", color: this.focus === "path" ? cyan : gray }),
      "",
      dim("Format"),
      (this.focus === "format" ? cyan : (text: string) => text)(`${this.format === "mp4" ? "› " : "  "}[ MP4 ]    ${this.format === "mkv" ? "› " : "  "}[ MKV ]`),
      "",
      dim("Compression"),
      ...EXPORT_PRESET_DETAILS.map((item) => {
        const text = `${item.id === this.preset ? "›" : " "} ${item.label.padEnd(18)} ${item.video} · ${item.audio}`;
        return item.id === this.preset && this.focus === "compression" ? inverse(cyan(text)) : item.id === this.preset ? text : dim(text);
      }),
      "",
      preset.description,
      dim("MP4 is broadly compatible. MKV is flexible for local playback and archiving."),
      dim("Tab section · arrows edit/select · type destination · Enter export · Esc close"),
    ];
    return centered(box(lines, modalWidth, { border: "double", color: cyan, paddingX: 2 }), width, this.rows);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) { if (!this.options.busy()) this.options.close(); return; }
    if (this.options.busy()) return;
    if (matchesKey(data, "enter")) { this.options.perform({ destination: this.destination, format: this.format, preset: this.preset }); return; }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.focus = cycle(FOCUS_ORDER, this.focus, matchesKey(data, "shift+tab") ? -1 : 1);
    } else if (this.focus === "format" || this.focus === "compression") {
      const direction = matchesKey(data, "left") || matchesKey(data, "up") ? -1 : matchesKey(data, "right") || matchesKey(data, "down") ? 1 : 0;
      if (direction !== 0 && this.focus === "format") {
        this.format = cycle(EXPORT_FORMATS, this.format, direction);
        setValueAtEnd(this.path, exportDestination(this.options.sourcePath, this.destination, this.format));
      } else if (direction !== 0) {
        this.preset = cycle(EXPORT_PRESETS, this.preset, direction);
      }
    } else {
      this.path.handleInput(data);
    }
    this.context.requestRender();
  }
}

function cycle<T extends string>(choices: readonly T[], current: T, direction: number): T {
  const index = Math.max(0, choices.indexOf(current));
  return choices[(index + direction + choices.length) % choices.length] ?? current;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc -p tsconfig.test.json && node --test .test-dist/tests/shell-panels.test.js .test-dist/tests/model-picker.test.js
npm test
```

Expected: 7 passed in `shell-panels` and 7 in `model-picker`, then the whole suite: 170 tests, 169 passed, 1 skipped (the live OpenRouter test), 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/shell tests package.json
git commit -m "feat: add the model, music and export panels"
```

## Task 8: Wire it all together, switch the CLI over and remove the Ink UI

**Files:**
- Create: `src/shell/commands.ts`, `src/shell/engine-factory.ts`, `src/shell/app.ts`, `tests/shell-app.test.ts`
- Modify: `src/cli.tsx` (renamed to `src/cli.ts`), `tsup.config.ts`, `tsconfig.json`, `package.json`, `package-lock.json` (by npm), `README.md`, `tests/keys.test.ts`
- Delete: `src/ui/*` (all of it), `tests/layout.test.ts`, `tests/text-layout.test.ts`, `tests/terminal-layers.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 7, plus the step 2 core: `Engine`, `createEditorRegistry`, `directEditCall`, `EditorState`, `ProjectStore`, `exportVideo`, `selectMusicTrack`, settings functions, `MusicPreviewController`.
- Produces: `ShellApp` (`new ShellApp({ terminal, initialPath?, cwd?, backend?, onExit?, createEngine?, audio? })`, `start()`, `submit(text)`, `openVideo(path, projectDir?)`, `dispose()`, `quit()`, and the `CommandApp` surface used by commands); `runCommand(app, line)`; `createAgentEngine(args)`; the CLI `src/cli.ts` (same arguments and help text as before, plus a clear message when there is no interactive terminal).

- [ ] **Step 1: Write the end-to-end tests**

These start the whole application against the emulated terminal with a real FFmpeg-made video, the real engine and pi's fake model provider: opening a video, a slash command that edits it, panels, playback, a streamed answer that is saved to the project's chat history, an approval that defaults to Deny, stopping a waiting run, a missing API key, `/export`, quitting, and disposing while the video plays.

Create `tests/shell-app.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createEditorRegistry } from "../src/core/actions/index.js";
import { Engine } from "../src/core/engine/engine.js";
import { createStreamFn } from "../src/core/pi/models.js";
import { SessionStore } from "../src/core/session/session-store.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";
import { ShellApp } from "../src/shell/app.js";
import { FakeTerminal, sixelPlacements } from "./helpers/fake-terminal.js";
import { call, makeFaux, say, toolUse } from "./helpers/faux.js";
import { makeProject } from "./helpers/project.js";

const KEY = { enter: "\r", esc: "\x1b", ctrlP: "\x10", ctrlC: "\x03", right: "\x1b[C" };

async function until(condition: () => boolean, timeoutMs = 20_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const typeLine = async (fake: FakeTerminal, text: string) => {
  for (const character of text) { fake.send(character); await new Promise((resolve) => setTimeout(resolve, 5)); }
  await fake.settle(40);
  fake.send(KEY.enter);
};
const texts = (app: ShellApp) => app.state.messages.map((message) => `${message.label ?? message.role}:${message.text}`);

async function boot(options: { engine?: boolean; permission?: "ask" | "auto" } = {}) {
  const project = await makeProject();
  const fake = new FakeTerminal(120, 40);
  const faux = makeFaux();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.agent.permissionMode = options.permission ?? "ask";
  let exits = 0;
  const app = new ShellApp({
    terminal: fake, initialPath: project.store.snapshot.sourcePath, backend: "sixel", onExit: () => { exits += 1; },
    audio: { spawn: () => null },
    createEngine: options.engine === false ? async () => null : async (editor, seed) => Engine.create({
      state: editor, registry: createEditorRegistry(), session: new SessionStore(join(editor.store.snapshot.projectDir, "agent", "session.jsonl")),
      models: faux.models, modelId: "faux", model: faux.model, streamFn: createStreamFn(faux.models), getSettings: () => settings, chatSeed: seed,
    }),
  });
  await app.start();
  await until(() => app.state.media !== null && !app.state.loader, 30_000, "the video to open");
  await fake.settle();
  return { project, fake, faux, app, exits: () => exits, cleanup: async () => { app.dispose(); await project.cleanup(); } };
}

test("opens a video: header, play bar, status and the first picture appear", { timeout: 90_000 }, async () => {
  const t = await boot();
  try {
    const rows = t.fake.screen();
    assert.match(rows[0] ?? "", /^DumbEditor +source · .+ · v0000$/);
    assert.match(t.app.state.messages.at(-1)?.text ?? "", /^Opened source · .+ · 320x180 · 00:04\.0$/);
    await until(() => sixelPlacements(t.fake.writes.join("")).length > 0, 20_000, "the first picture");
    assert.deepEqual(t.app.state.versions.map((version) => version.id), ["v0000"]);
    assert.equal(t.app.engine !== null, true);
  } finally { await t.cleanup(); }
});

test("a slash command edits the video, adds a version and shows the result", { timeout: 120_000 }, async () => {
  const t = await boot({ engine: false });
  try {
    await typeLine(t.fake, "/clip-remove 1 2");
    await until(() => t.app.state.versionId === "v0001", 60_000, "the edit");
    await until(() => !t.app.state.loader, 30_000, "the edit to finish");
    assert.equal(t.app.state.media?.duration !== undefined && t.app.state.media.duration < 3.3, true, "the video got shorter");
    assert.ok(t.app.state.versions.some((version) => version.id === "v0001"));
    assert.match(texts(t.app).join("\n"), /user:\/clip-remove 1 2/);
    await t.fake.settle(150);
    assert.ok(t.fake.screen().some((line) => line.includes("● v0001") || line.includes("v0001")), "the header shows the new version");
  } finally { await t.cleanup(); }
});

test("simple commands: /status, /help (a panel that Escape closes), /clear", { timeout: 90_000 }, async () => {
  const t = await boot({ engine: false });
  try {
    await typeLine(t.fake, "/status");
    await until(() => texts(t.app).some((line) => line.includes("v0000 · 320x180")), 10_000, "/status");
    await typeLine(t.fake, "/help");
    await until(() => t.app.state.overlay === "help", 10_000, "the help panel");
    await t.fake.settle(150);
    assert.ok(t.fake.screen().some((line) => line.includes("DumbEditor controls")));
    t.fake.send(KEY.esc);
    await until(() => t.app.state.overlay === null, 10_000, "the panel to close");
    await typeLine(t.fake, "/clear");
    await until(() => t.app.state.messages.length === 0, 10_000, "/clear");
  } finally { await t.cleanup(); }
});

test("Ctrl+P plays the preview and moves the playhead; Ctrl+P again pauses it", { timeout: 90_000 }, async () => {
  const t = await boot({ engine: false });
  try {
    t.fake.send(KEY.ctrlP);
    await until(() => t.app.state.playing, 5_000, "playing");
    await until(() => t.app.state.playhead > 0.3, 30_000, "the playhead to move");
    t.fake.send(KEY.ctrlP);
    await until(() => !t.app.state.playing, 5_000, "paused");
    const stopped = t.app.state.playhead;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(t.app.state.playhead, stopped, "the playhead stays put once paused");
  } finally { await t.cleanup(); }
});

test("a request streams the agent's answer into the chat and saves it in the project's history", { timeout: 90_000 }, async () => {
  const t = await boot();
  try {
    t.faux.faux.setResponses([say("Hello from the agent")]);
    await typeLine(t.fake, "describe the video");
    await until(() => texts(t.app).some((line) => line.endsWith(":Hello from the agent")), 30_000, "the answer");
    await until(() => !t.app.state.agentRunning, 10_000, "the run to end");
    assert.deepEqual(texts(t.app).slice(-2).map((line) => line.replace(/^[^:]+:/, "")), ["describe the video", "Hello from the agent"]);
    for (let attempt = 0; attempt < 100 && (await t.app.project!.chatHistory()).length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    const history = await t.app.project!.chatHistory();
    assert.deepEqual(history.slice(-2).map((message) => message.content), ["describe the video", "Hello from the agent"]);
  } finally { await t.cleanup(); }
});

test("a paid action asks first; Enter picks the safe default (Deny) and the run ends", { timeout: 90_000 }, async () => {
  const t = await boot({ permission: "ask" });
  try {
    t.faux.faux.setResponses([
      toolUse(call("generate_asset", { kind: "image", prompt: "a cat", duration: null, voice: null, provider: null, model: null, provider_options_json: null }, "g1")),
      say("Understood, I will not generate it."),
    ]);
    await typeLine(t.fake, "make me a cat picture");
    await until(() => t.app.state.overlay === "approval", 30_000, "the approval panel");
    await t.fake.settle(150);
    assert.ok(t.fake.screen().some((line) => line.includes("Permission required")));
    t.fake.send(KEY.enter);
    await until(() => !t.app.state.agentRunning && t.app.state.overlay === null, 30_000, "the run to end");
    assert.ok(texts(t.app).some((line) => line.includes("Understood, I will not generate it.")));
    assert.equal(t.app.state.assets.length, 0, "nothing was generated");
  } finally { await t.cleanup(); }
});

test("Escape stops a run that is waiting and says so", { timeout: 90_000 }, async () => {
  const t = await boot();
  try {
    t.faux.faux.setResponses([toolUse(call("present_choices", { question: "Which?", options: ["A", "B"], allow_custom: false }, "c1"))]);
    await typeLine(t.fake, "ask me something");
    await until(() => t.app.state.overlay === "choice", 30_000, "the choice panel");
    t.fake.send(KEY.ctrlC);
    await until(() => !t.app.state.agentRunning, 30_000, "the run to stop");
    assert.ok(texts(t.app).some((line) => line === "editor:Stopped."));
    assert.equal(t.exits(), 0, "Ctrl+C stops the agent first and does not quit");
  } finally { await t.cleanup(); }
});

test("without an agent a request explains what to do, and slash commands still work", { timeout: 90_000 }, async () => {
  const t = await boot({ engine: false });
  try {
    await typeLine(t.fake, "trim the intro");
    await until(() => texts(t.app).some((line) => line.includes("Add an OpenRouter API key")), 10_000, "the explanation");
  } finally { await t.cleanup(); }
});

test("/export opens its panel and Escape closes it; Ctrl+C at rest quits and releases the terminal", { timeout: 90_000 }, async () => {
  const t = await boot({ engine: false });
  try {
    await typeLine(t.fake, "/export");
    await until(() => t.app.state.overlay === "export", 10_000, "the export panel");
    await t.fake.settle(150);
    assert.ok(t.fake.screen().some((line) => line.includes("Export video")));
    t.fake.send(KEY.esc);
    await until(() => t.app.state.overlay === null, 10_000, "the panel to close");
    t.fake.send(KEY.ctrlC);
    await until(() => t.exits() === 1, 10_000, "quit");
  } finally { await t.cleanup(); }
});

test("disposing the app while the video plays stops the picture, the sound and every key", { timeout: 90_000 }, async () => {
  const started: number[] = [];
  let stopped = 0;
  const project = await makeProject();
  const fake = new FakeTerminal(120, 40);
  const app = new ShellApp({
    terminal: fake, initialPath: project.store.snapshot.sourcePath, backend: "sixel", createEngine: async () => null,
    audio: { spawn: () => { started.push(1); return {} as never; }, terminate: (child) => { if (child) stopped += 1; } },
  });
  try {
    await app.start();
    await until(() => app.state.media !== null && !app.state.loader, 30_000, "the video to open");
    fake.send(KEY.ctrlP);
    await until(() => app.state.playhead > 0.3, 30_000, "the playhead to move");
    assert.equal(started.length, 1, "the sound started with the picture");
    app.dispose();
    assert.equal(stopped, 1, "the sound was stopped");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const writes = fake.writes.length;
    fake.send(KEY.right);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(fake.writes.length, writes, "nothing more is drawn after dispose");
  } finally {
    app.dispose();
    await project.cleanup();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL with `Cannot find module '../src/shell/app.js'`.

- [ ] **Step 3: Write the application**

`app.ts` is the old `App.tsx` flows (open, commands, edits, versions, export, music, model switch, agent events) rebuilt on `ShellState` and the panels. Behaviour kept: slash commands other than the safe list wait while the agent runs; text sent during a run steers it; Esc and Ctrl+C stop the agent before they quit; the playhead and marks are copied to the shared `EditorState` when paused or when a message is sent. One fix on the way: switching the base-agent model now keeps the project's chat history (the old code started the new agent with none).

Create `src/shell/commands.ts`:

```typescript
import { parseEditCommand } from "../core/commands.js";
import type { Engine } from "../core/engine/engine.js";
import type { ProjectStore } from "../core/project.js";
import type { DumbEditorSettings } from "../core/settings.js";
import type { EditorState } from "../core/state/editor-state.js";
import { formatTime } from "../core/time.js";
import { formatUsd } from "../core/usage.js";
import type { DirectEdit } from "../types.js";
import type { ShellState } from "./state/shell-state.js";

/** What a slash command needs from the application. */
export interface CommandApp {
  readonly state: ShellState;
  readonly project: ProjectStore | null;
  readonly editor: EditorState | null;
  readonly engine: Engine | null;
  readonly settings: DumbEditorSettings;
  answer(text: string): Promise<void>;
  quit(): void;
  openVideo(path: string): Promise<void>;
  openProjects(): Promise<void>;
  openModelPicker(): void;
  openMusic(query: string): Promise<void>;
  openAssets(): void;
  openExport(requested: string): void;
  openHistory(showAll: boolean): void;
  applyEdit(edit: DirectEdit, request: string): Promise<void>;
  changeVersion(reference: string): Promise<void>;
  setPermissionMode(mode: "ask" | "auto"): Promise<void>;
  setSpendCeiling(usd: number): Promise<void>;
  setVersionLimit(limit: number): Promise<void>;
  compact(): Promise<void>;
}

/** Commands that cannot disturb a running agent; everything else waits until it finishes or is stopped. */
const SAFE_DURING_RUN = new Set(["/help", "/chat", "/status", "/clear", "/play", "/pause", "/quit", "/exit", "/permissions", "/budget", "/version", "/versions", "/assets"]);

export async function runCommand(app: CommandApp, line: string): Promise<void> {
  const { state } = app;
  const space = line.indexOf(" ");
  const command = (space === -1 ? line : line.slice(0, space)).toLowerCase();
  const argument = unquote(space === -1 ? "" : line.slice(space + 1).trim());
  if (state.agentRunning && !SAFE_DURING_RUN.has(command)) { await app.answer("The agent is working. Wait for it to finish, or press Esc to stop it."); return; }

  if (command === "/quit" || command === "/exit") { app.quit(); return; }
  if (command === "/help") { state.openOverlay("help"); return; }
  if (command === "/clear") { state.clearMessages(); state.closeOverlay(); return; }
  if (command === "/chat") { state.toggleChatExpanded(); return; }
  if (command === "/play") { if (state.media) state.setPlaying(true); return; }
  if (command === "/pause") { state.setPlaying(false); return; }
  if (command === "/open") { if (!argument) { await app.answer("Usage: /open <VIDEO PATH>"); return; } await app.openVideo(argument); return; }
  if (command === "/projects") { await app.openProjects(); return; }
  if (command === "/model") { app.openModelPicker(); return; }
  if (command === "/bg-music") { await app.openMusic(argument); return; }
  if (command === "/permissions") {
    if (!argument) { await app.answer(`Agent permission mode: ${app.settings.agent.permissionMode}. Use /permissions ask or /permissions auto.`); return; }
    if (argument !== "ask" && argument !== "auto") { await app.answer("Usage: /permissions [ask|auto]"); return; }
    await app.setPermissionMode(argument);
    await app.answer(`Agent permission mode set to ${argument}.`);
    return;
  }
  if (command === "/budget") {
    if (!argument) {
      const limit = app.settings.agent.spendCeilingUsd;
      await app.answer(limit > 0
        ? `Each agent run pauses to ask at ${formatUsd(limit)}. Use /budget <USD> to change it, or /budget 0 to turn it off.`
        : "There is no per-run spend limit. Use /budget <USD> to set one.");
      return;
    }
    await app.setSpendCeiling(Number(argument));
    const limit = app.settings.agent.spendCeilingUsd;
    await app.answer(limit > 0 ? `Per-run spend limit set to ${formatUsd(limit)}.` : "Per-run spend limit turned off.");
    return;
  }
  if (command === "/compact") { await app.compact(); return; }

  const { project, state: shell } = app;
  const media = shell.media;
  if (!project || !media) { await app.answer("Open a video first with /open <path>."); return; }
  if (command === "/assets") {
    if (argument) { await app.answer("Usage: /assets"); return; }
    app.openAssets();
    return;
  }

  const direct = parseEditCommand(line, { duration: media.duration, currentTime: shell.playhead, selection: shell.selection });
  if (direct) {
    shell.setPlaying(false);
    try { await app.applyEdit(direct, line); }
    catch (error) { await app.answer(message(error)); shell.setStatus("Edit failed"); }
    finally { shell.setLoader(null); }
    return;
  }
  if (command === "/version" || command === "/versions") {
    if (argument && argument.toLowerCase() !== "all") { await app.answer("Usage: /version [all]"); return; }
    app.openHistory(argument.toLowerCase() === "all");
    return;
  }
  if (command === "/version-limits") {
    if (!argument) { await app.answer(`Keeping up to ${project.versionLimit} rendered edit versions, plus the original source.`); return; }
    const limit = Number(argument);
    await app.setVersionLimit(limit);
    await app.answer(`Version limit set to ${limit}. Older rendered versions were pruned.`);
    return;
  }
  if (command === "/status") { await app.answer(`${project.name} · ${project.current.id} · ${media.width}x${media.height} · ${formatTime(media.duration)} · ${project.snapshot.versions.length} versions · limit ${project.versionLimit}`); return; }
  if (command === "/undo") {
    const parent = project.current.parentId;
    if (!parent) { await app.answer("Already at the original version."); return; }
    await app.changeVersion(parent);
    return;
  }
  if (command === "/revert") { if (!argument) { await app.answer("Usage: /revert <VERSION>"); return; } await app.changeVersion(argument); return; }
  if (command === "/export") { app.openExport(argument); return; }
  await app.answer(`Unknown command ${command}. Type / to see commands.`);
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function unquote(value: string): string {
  const first = value[0];
  return value.length >= 2 && (first === "'" || first === "\"") && value.at(-1) === first ? value.slice(1, -1) : value;
}
```

Create `src/shell/engine-factory.ts`:

```typescript
import { join } from "node:path";
import type { ActionRegistry } from "../core/actions/index.js";
import { loadAgentSkills } from "../core/agent-skills.js";
import { Engine } from "../core/engine/engine.js";
import { createEditorModels, fetchOpenRouterModelInfo, isCatalogModel } from "../core/pi/models.js";
import { SessionStore } from "../core/session/session-store.js";
import type { DumbEditorSettings } from "../core/settings.js";
import type { EditorState } from "../core/state/editor-state.js";
import type { ChatMessage } from "../types.js";

export type EditorModels = ReturnType<typeof createEditorModels>;

/** Build the agent for an open project, or null (with a reason in `report`) when it cannot start. */
export async function createAgentEngine(args: {
  state: EditorState;
  registry: ActionRegistry;
  getSettings: () => DumbEditorSettings;
  models: { current: EditorModels | null };
  chatSeed: readonly ChatMessage[];
  report: (message: string) => void;
}): Promise<Engine | null> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  args.models.current ??= createEditorModels({ apiKey });
  const modelId = args.getSettings().models.openrouter.text;
  // Models pi's catalog does not know yet still work: take their real limits and prices from OpenRouter.
  const modelInfo = isCatalogModel(args.models.current, modelId) ? undefined : await fetchOpenRouterModelInfo(modelId);
  try {
    const created = await Engine.tryCreate({
      state: args.state, registry: args.registry, models: args.models.current, modelId, ...(modelInfo ? { modelInfo } : {}),
      session: new SessionStore(join(args.state.store.snapshot.projectDir, "agent", "session.jsonl")),
      getSettings: args.getSettings, skills: await loadAgentSkills(), chatSeed: args.chatSeed,
    });
    if (created.error !== undefined) args.report(`The agent could not start for this project: ${created.error}. Slash commands still work.`);
    return created.engine;
  } catch (error) {
    args.report(`The agent could not start for this project: ${error instanceof Error ? error.message : String(error)}. Slash commands still work.`);
    return null;
  }
}
```

Create `src/shell/app.ts`:

```typescript
import type { ChildProcess } from "node:child_process";
import { extname, resolve } from "node:path";
import type { Component, Terminal } from "@earendil-works/pi-tui";
import { createEditorRegistry, directEditCall, type ActionContext } from "../core/actions/index.js";
import type { AgentAsset } from "../core/agent-workspace.js";
import { COMMANDS } from "../core/commands.js";
import { providerKeyStatus } from "../core/config.js";
import type { Engine } from "../core/engine/engine.js";
import type { ApprovalDecision } from "../core/engine/events.js";
import { exportDestination, exportVideo, type ExportFormat } from "../core/export.js";
import { detectPreviewBackend, playAudio, type PreviewBackend } from "../core/media.js";
import { listProviderModels } from "../core/models.js";
import { MusicPreviewController, clearMusicSelection, readMusicSelection, selectMusicTrack } from "../core/music.js";
import { ProjectStore, type ProjectSummary } from "../core/project.js";
import { terminateProcess, terminateRunningProcesses } from "../core/process.js";
import { DEFAULT_SETTINGS, readSettings, setAgentPermissionMode, setBaseAgentModel, setDefaultModel, setSpendCeiling, type DumbEditorSettings } from "../core/settings.js";
import { EditorState } from "../core/state/editor-state.js";
import { formatTime } from "../core/time.js";
import type { ChatMessage, DirectEdit } from "../types.js";
import { runCommand, type CommandApp } from "./commands.js";
import { createAgentEngine, type EditorModels } from "./engine-factory.js";
import { playbackStart } from "./input/keys.js";
import { ApprovalPanel } from "./overlays/approval.js";
import { AssetPanel } from "./overlays/assets.js";
import { ChoicePanel } from "./overlays/choice.js";
import { ExportPanel } from "./overlays/export.js";
import type { PanelContext } from "./overlays/frame.js";
import { HelpPanel } from "./overlays/help.js";
import { HistoryPanel } from "./overlays/history.js";
import { ModelPanel } from "./overlays/model.js";
import { MusicPanel } from "./overlays/music.js";
import { ProjectsPanel } from "./overlays/projects.js";
import { AudioController, type AudioDeps } from "./preview/audio.js";
import { PlaybackController, type PlaybackFrame } from "./preview/playback.js";
import { createShellScreen, type OverlayContext, type ShellScreen } from "./screen.js";
import { bindEngineEvents } from "./state/engine-bridge.js";
import { ShellState, type OverlayKind } from "./state/shell-state.js";

export interface ShellAppOptions {
  terminal: Terminal;
  /** A video to open at start. */
  initialPath?: string;
  cwd?: string;
  backend?: PreviewBackend;
  /** Called when the app wants to quit, after it has released everything it holds. */
  onExit?: (code: number) => void;
  /** Test seam: build the agent for a project instead of reading the OpenRouter key. */
  createEngine?: (state: EditorState, chatSeed: readonly ChatMessage[]) => Promise<Engine | null>;
  audio?: AudioDeps;
}

/** The editor: opens projects, runs commands and the agent, and keeps the screen in step with what happens. */
export class ShellApp implements CommandApp {
  readonly state = new ShellState();
  readonly registry = createEditorRegistry();
  readonly screen: ShellScreen;
  project: ProjectStore | null = null;
  editor: EditorState | null = null;
  engine: Engine | null = null;
  settings: DumbEditorSettings = structuredClone(DEFAULT_SETTINGS);

  private readonly backend: PreviewBackend;
  private readonly playback: PlaybackController;
  private readonly audio: AudioController;
  private readonly models: { current: EditorModels | null } = { current: null };
  private readonly musicPreview = new MusicPreviewController();
  private unbindEngine: (() => void) | null = null;
  private unbindEditor: (() => void) | null = null;
  private openPanel: { kind: OverlayKind; dispose?: () => void } | null = null;
  private projectList: ProjectSummary[] = [];
  private showAllHistory = false;
  private musicQuery = "";
  private selectedMusicId: string | null = null;
  private exportInitial: { destination: string; format: ExportFormat } = { destination: "", format: "mp4" };
  private assetProcess: ChildProcess | null = null;
  private assetPlaying = false;
  private disposed = false;

  constructor(private readonly options: ShellAppOptions) {
    this.backend = options.backend ?? detectPreviewBackend();
    this.screen = createShellScreen({
      terminal: options.terminal, state: this.state, backend: this.backend, commands: COMMANDS, cwd: options.cwd ?? process.cwd(),
      hooks: {
        onSubmit: (text) => { void this.submit(text); },
        onInterrupt: () => this.interrupt(),
        onAbortAgent: () => this.engine?.abort(),
        onOpenAssets: () => this.openAssets(),
      },
      overlays: (kind, context) => this.buildOverlay(kind, context),
      onLayout: () => this.onStateChange(),
    });
    this.playback = new PlaybackController({
      onFrame: (frame) => this.onFrame(frame),
      onEnd: () => { this.state.setPlaying(false); if (this.state.media) this.state.setPlayhead(this.state.media.duration); },
      onError: (error) => { this.state.setStatus(`Preview unavailable: ${error.message}`); this.state.setPlaying(false); },
    });
    this.audio = new AudioController((message) => this.state.setStatus(message), options.audio);
    this.state.subscribe(() => this.onStateChange());
  }

  /** Start drawing, load settings, and open the video named at launch. */
  async start(): Promise<void> {
    this.screen.start();
    try {
      this.applySettings(await readSettings());
    } catch (error) {
      this.state.setStatus(message(error));
    }
    if (this.options.initialPath) await this.openVideo(this.options.initialPath);
    else this.state.addMessage("assistant", "Open a video with /open <path>, or relaunch as: dumbeditor video.mp4", "editor");
  }

  /** Release everything: stop the agent, the preview, the sound, and give the terminal back. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.abort();
    this.unbindEngine?.();
    this.unbindEditor?.();
    this.playback.dispose();
    this.audio.dispose();
    this.musicPreview.dispose();
    this.openPanel?.dispose?.();
    terminateProcess(this.assetProcess);
    terminateRunningProcesses();
    this.screen.stop();
  }

  quit(): void {
    this.dispose();
    this.options.onExit?.(0);
  }

  // Keys and text --------------------------------------------------------------------------------

  private interrupt(): void {
    if (this.engine?.running) this.engine.abort();
    else this.quit();
  }

  /** A line from the composer: a slash command, or a request for the agent. */
  async submit(request: string): Promise<void> {
    const { state } = this;
    if (state.busy) return;
    state.addMessage("user", request);
    this.screen.transcript.scrollToEnd();
    if (request.startsWith("/")) {
      try { await runCommand(this, request); } catch (error) { await this.answer(message(error)); }
      return;
    }
    const { project, editor, engine } = this;
    if (!project || !state.media || !editor) { await this.answer("Open a video first with /open <path>."); return; }
    if (!engine) { await this.answer("Add an OpenRouter API key with dumbeditor setup to talk to the agent."); return; }
    // Text sent while the agent is running steers it; otherwise it starts a run.
    editor.setPlayhead(state.playhead);
    editor.setSelection(state.selection);
    try {
      if (!engine.running) {
        await project.nameFromFirstRequest(request);
        await project.register();
      }
      await project.addChat("user", request);
      engine.submit(request);
    } catch (error) {
      await this.answer(message(error));
      state.setStatus(`${state.agentModel} request failed`);
    }
  }

  async answer(text: string, label = this.state.agentModel): Promise<void> {
    this.state.addMessage("assistant", text, label);
    if (this.project) await this.project.addChat("assistant", text, label);
  }

  // Projects -------------------------------------------------------------------------------------

  async openVideo(path: string, projectDirectory?: string): Promise<void> {
    const { state } = this;
    if (this.engine?.running) {
      state.addMessage("assistant", "The agent is working. Wait for it to finish, or press Esc to stop it, before opening another video.");
      return;
    }
    state.setLoader({ source: "Editor", stage: "Opening video" });
    state.setPlaying(false);
    try {
      const store = projectDirectory ? await ProjectStore.openProject(projectDirectory) : await ProjectStore.open(resolve(path));
      state.setLoader({ source: "Editor", stage: "Reading media details" });
      const editor = await EditorState.open(store);
      const history = await store.chatHistory();
      await store.register();
      const engine = await this.createEngine(editor, history);

      this.unbindEditor?.();
      this.project = store;
      this.editor = editor;
      this.setEngine(engine);
      this.screen.preview.clear();
      this.unbindEditor = this.followEditor(editor, store);
      state.setProject(store.name, store.current.id, store.versionLimit);
      state.setMedia(editor.media);
      state.setVersions(store.history(Number.POSITIVE_INFINITY), store.current.id);
      state.setAssets([...editor.assets]);
      state.setUsage(editor.usage);
      state.setMessages(history);
      state.setSelection({ in: null, out: null });
      state.setPlayhead(0);
      state.setStatus(`Opened ${store.name}`);
      state.addMessage("assistant", `Opened ${store.name} · ${editor.media.width}x${editor.media.height} · ${formatTime(editor.media.duration)}`, "editor");
      if (!engine) state.addMessage("assistant", "Add an OpenRouter API key with dumbeditor setup to talk to the agent. Slash commands still work.", "editor");
    } catch (error) {
      state.addMessage("assistant", message(error));
      state.setStatus("Open failed");
    } finally {
      state.setLoader(null);
    }
  }

  async openProjects(): Promise<void> {
    const { state } = this;
    state.setPlaying(false);
    state.setLoader({ source: "Editor", stage: "Loading saved projects" });
    try {
      this.projectList = await ProjectStore.listProjects(this.project?.snapshot.sourcePath);
      state.openOverlay("projects");
      state.setStatus(`${this.projectList.length} saved project${this.projectList.length === 1 ? "" : "s"}`);
    } catch (error) {
      await this.answer(message(error));
      state.setStatus("Could not load projects");
    } finally {
      state.setLoader(null);
    }
  }

  /** Keep the screen in step with the editor's own state: media, cost, assets, versions. */
  private followEditor(editor: EditorState, store: ProjectStore): () => void {
    let active = editor.store.current.id;
    return editor.subscribe(() => {
      const { state } = this;
      state.setMedia(editor.media);
      state.setUsage(editor.usage);
      state.setAssets([...editor.assets]);
      state.setVersions(store.history(Number.POSITIVE_INFINITY), store.current.id);
      if (editor.store.current.id !== active) {
        active = editor.store.current.id;
        state.setPlayhead(editor.playhead);
        state.setSelection(editor.selection);
      }
    });
  }

  // Engine ---------------------------------------------------------------------------------------

  private async createEngine(editor: EditorState, chatSeed: readonly ChatMessage[]): Promise<Engine | null> {
    if (this.options.createEngine) return this.options.createEngine(editor, chatSeed);
    return createAgentEngine({
      state: editor, registry: this.registry, getSettings: () => this.settings, models: this.models, chatSeed,
      report: (text) => this.state.addMessage("assistant", text, "error"),
    });
  }

  private setEngine(engine: Engine | null): void {
    this.unbindEngine?.();
    this.engine = engine;
    this.unbindEngine = engine
      ? bindEngineEvents(this.state, engine, {
        label: () => this.state.agentModel,
        persistAnswer: (text) => { void this.project?.addChat("assistant", text, this.state.agentModel); },
      })
      : null;
  }

  private resolveApproval(decision: ApprovalDecision): void {
    const { approval } = this.state;
    if (approval) this.engine?.resolveApproval(approval.id, decision);
    this.state.clearPrompts();
  }

  private resolveChoice(answer: string | null): void {
    const { choice } = this.state;
    if (choice) this.engine?.resolveChoice(choice.id, answer);
    this.state.clearPrompts();
  }

  async compact(): Promise<void> {
    const { engine, state } = this;
    if (!engine) { await this.answer("Open a video, with an OpenRouter key configured, first."); return; }
    state.setLoader({ source: "Editor", stage: "Compacting conversation" });
    try { await this.answer(await engine.compact() ? "Compacted the earlier conversation." : "There is nothing to compact yet."); }
    finally { state.setLoader(null); }
  }

  // Editing --------------------------------------------------------------------------------------

  private actionContext(editor: EditorState, request: string, onStage: (stage: string) => void): ActionContext {
    return {
      state: editor, settings: this.settings, signal: new AbortController().signal, request,
      progress: (update) => onStage(update.stage), requestChoice: async () => null,
    };
  }

  async applyEdit(edit: DirectEdit, request: string): Promise<void> {
    const { editor, state } = this;
    if (!editor) throw new Error("Open a video first with /open <path>.");
    state.setLoader({ source: "Command", stage: "Preparing edit" });
    const { name, args } = directEditCall(edit);
    const result = await this.registry.run(name, args, this.actionContext(editor, request, (stage) => state.setLoader({ source: "Command", stage })));
    await this.answer(result.text);
    state.setStatus("Command · complete");
  }

  async changeVersion(reference: string): Promise<void> {
    const { editor, state } = this;
    if (!editor) return;
    state.setLoader({ source: "Editor", stage: "Loading saved version" });
    state.setPlaying(false);
    try {
      const version = await editor.revertTo(reference);
      await this.answer(`Now on ${version.id}: ${version.action}`);
      state.setStatus(`Current ${version.id}`);
    } catch (error) {
      await this.answer(message(error));
      state.setStatus("Revert failed");
    } finally {
      state.setLoader(null);
    }
  }

  async setVersionLimit(limit: number): Promise<void> {
    const { project, state } = this;
    if (!project) return;
    await project.setVersionLimit(limit);
    state.setProject(project.name, project.current.id, project.versionLimit);
    state.setVersions(project.history(Number.POSITIVE_INFINITY), project.current.id);
  }

  async setPermissionMode(mode: "ask" | "auto"): Promise<void> {
    this.applySettings(await setAgentPermissionMode(mode));
  }

  async setSpendCeiling(usd: number): Promise<void> {
    this.applySettings(await setSpendCeiling(usd));
  }

  private applySettings(settings: DumbEditorSettings): void {
    this.settings = settings;
    this.state.setAgentModel(settings.models.openrouter.text);
    this.state.setPermissionMode(settings.agent.permissionMode);
  }

  // Panels ---------------------------------------------------------------------------------------

  openModelPicker(): void { this.state.openOverlay("model"); }

  openHistory(showAll: boolean): void { this.showAllHistory = showAll; this.state.openOverlay("history"); }

  openAssets(): void {
    this.stopAssetPlayback();
    this.state.openOverlay("assets");
  }

  async openMusic(query: string): Promise<void> {
    this.musicPreview.stop();
    this.musicQuery = query;
    this.selectedMusicId = (await readMusicSelection()).trackId;
    this.state.openOverlay("music");
  }

  openExport(requested: string): void {
    const { project } = this;
    if (!project) return;
    const format: ExportFormat = extname(requested).toLowerCase() === ".mkv" ? "mkv" : "mp4";
    this.exportInitial = { destination: exportDestination(project.snapshot.sourcePath, requested || undefined, format), format };
    this.state.openOverlay("export");
  }

  private async performExport(choice: { destination: string; format: ExportFormat; preset: "copy" | "high" | "balanced" | "compact" }): Promise<void> {
    const { project, state } = this;
    if (!project) return;
    state.setLoader({ source: "Editor", stage: "Preparing export" });
    try {
      const result = await exportVideo({
        input: project.current.filePath, destination: choice.destination, format: choice.format, preset: choice.preset,
        onStage: (stage) => state.setLoader({ source: "Editor", stage }),
      });
      state.closeOverlay();
      await this.answer(`Exported ${result.path} · ${result.format.toUpperCase()} · ${formatBytes(result.bytes)}`);
      state.setStatus("Export complete");
    } catch (error) {
      await this.answer(message(error));
      state.setStatus("Export failed");
    } finally {
      state.setLoader(null);
    }
  }

  private stopAssetPlayback(): void {
    terminateProcess(this.assetProcess);
    this.assetProcess = null;
    this.assetPlaying = false;
  }

  private toggleAssetPlayback(asset: AgentAsset): void {
    if (this.assetPlaying) { this.stopAssetPlayback(); return; }
    const onError = asset.kind === "video" ? () => undefined : (error: Error) => { this.state.setStatus(error.message); this.assetPlaying = false; };
    this.assetProcess = playAudio(asset.path, 0, this.state.volume, onError);
    this.assetPlaying = this.assetProcess !== null;
    this.assetProcess?.once("close", () => { this.assetPlaying = false; this.screen.tui.requestRender(); });
  }

  private buildOverlay(kind: OverlayKind, context: OverlayContext): Component | null {
    const { state } = this;
    const panel: PanelContext = { bandRows: context.bandRows, requestRender: () => this.screen.tui.requestRender() };
    const close = context.close;
    this.openPanel = { kind };
    switch (kind) {
      case "help": return new HelpPanel(panel, { model: () => state.agentModel, close });
      case "history": return new HistoryPanel(panel, { state, showAll: this.showAllHistory, close });
      case "projects":
        return new ProjectsPanel(panel, {
          projects: this.projectList, activeProjectDir: this.project?.snapshot.projectDir,
          open: (summary) => { close(); void this.openVideo(summary.sourcePath, summary.projectDir); }, close,
        });
      case "approval":
        return state.approval ? new ApprovalPanel(panel, { request: state.approval, decide: (decision) => this.resolveApproval(decision) }) : null;
      case "choice":
        return state.choice ? new ChoicePanel(panel, { request: state.choice, answer: (answer) => this.resolveChoice(answer) }) : null;
      case "assets": {
        const assets = new AssetPanel(panel, {
          assets: () => state.assets, playing: () => this.assetPlaying, togglePlay: (asset) => this.toggleAssetPlayback(asset),
          stopPlay: () => this.stopAssetPlayback(), typeText: (text) => this.screen.composer.restore(text), close,
        });
        this.openPanel = { kind, dispose: () => { assets.dispose(); this.stopAssetPlayback(); } };
        return assets;
      }
      case "model":
        return new ModelPanel(panel, {
          settings: () => this.settings, keys: () => providerKeyStatus(), listModels: (provider, slot) => listProviderModels(provider, slot),
          setLoader: (loader) => state.setLoader(loader), close,
          save: async ({ capability, provider, slot, model }) => {
            const next = capability === "agent" ? await setBaseAgentModel(provider, model.id) : await setDefaultModel(provider, slot, model.id);
            this.applySettings(next);
            if (capability === "agent" && this.editor && !this.engine?.running) this.setEngine(await this.createEngine(this.editor, await this.project?.chatHistory() ?? []));
            state.setStatus(`${model.id} selected`);
            await this.answer(capability === "agent" ? `Base agent set to ${model.id} through ${provider}.` : `Default ${provider} ${slot} model set to ${model.id}.`);
          },
        });
      case "music": {
        const music = new MusicPanel(panel, {
          play: (id, callbacks) => { this.musicPreview.play(id, { volume: state.volume, onEnd: callbacks.onEnd, onError: callbacks.onError }); },
          stop: () => this.musicPreview.stop(),
          select: async (track) => {
            await selectMusicTrack(track.id);
            state.setStatus(`${track.title} selected`);
            await this.answer(`${track.title} selected. Ask ${state.agentModel} to add the selected background music.`);
          },
          clearSelection: async () => { await clearMusicSelection(); }, setStatus: (text) => state.setStatus(text), close,
        }, this.selectedMusicId, this.musicQuery);
        this.openPanel = { kind, dispose: () => music.dispose() };
        return music;
      }
      case "export":
        return new ExportPanel(panel, {
          sourcePath: this.project?.snapshot.sourcePath ?? "", destination: this.exportInitial.destination, format: this.exportInitial.format,
          busy: () => state.busy, perform: (choice) => { void this.performExport(choice); }, close,
        });
      default:
        return null;
    }
  }

  // Preview --------------------------------------------------------------------------------------

  private onFrame(frame: PlaybackFrame): void {
    this.screen.preview.setFrame(frame);
    if (this.state.playing && Math.abs(frame.time - this.state.playhead) >= 0.1) this.state.setPlayhead(frame.time);
  }

  /** Called on every change: keeps playback, sound and the shared editor state in step with what is on screen. */
  private onStateChange(): void {
    if (this.disposed || !this.playback) return;
    const { state } = this;
    if (this.openPanel && state.overlay !== this.openPanel.kind) { this.openPanel.dispose?.(); this.openPanel = null; }
    const layout = this.screen.layout();
    const visible = state.overlay === null && !state.chatExpanded;
    const filePath = this.project?.current.filePath;
    this.playback.update({
      filePath: visible ? filePath : undefined, media: state.media, columns: layout.videoColumns, rows: layout.bandRows,
      backend: this.backend, playing: state.playing, time: state.playhead,
    });
    this.audio.update({
      filePath, hasAudio: state.media?.hasAudio ?? false, playing: state.playing,
      start: playbackStart(state.playhead, state.media?.duration ?? 0), volume: state.volume,
    });
    // The agent reads the playhead and marks, so keep them current; the playhead only while paused, to stay cheap.
    if (this.editor) {
      if (!state.playing) this.editor.setPlayhead(state.playhead);
      this.editor.setSelection(state.selection);
    }
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

- [ ] **Step 4: Switch the CLI over**

```bash
git mv src/cli.tsx src/cli.ts
```

Apply this change to `src/cli.ts` (the arguments, help text and exit codes are unchanged; only the part that started Ink is replaced):

```diff
--- a/src/cli.tsx
+++ b/src/cli.ts
@@ -1,13 +1,11 @@
-import { render } from "ink";
+import { ProcessTerminal } from "@earendil-works/pi-tui";
 import { readFile } from "node:fs/promises";
 import { dirname, resolve } from "node:path";
 import { fileURLToPath } from "node:url";
 import { loadEnvironment, runSetup } from "./core/config.js";
-import { terminateRunningProcesses } from "./core/process.js";
 import { ProjectStore } from "./core/project.js";
 import { markWelcomeShown } from "./core/settings.js";
-import { App } from "./ui/App.js";
-import { createLayeredStdout } from "./ui/terminal-layers.js";
+import { ShellApp } from "./shell/app.js";
 
 const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
 loadEnvironment(packageRoot);
@@ -74,37 +72,30 @@
   process.exit(0);
 }
 
-const initialPath = launchArgs[0]!;
-process.title = "DumbEditor";
-const useAlternateScreen = Boolean(process.stdin.isTTY && process.stdout.isTTY);
-let screenRestored = false;
-const restoreScreen = () => {
-  if (!useAlternateScreen || screenRestored) return;
-  screenRestored = true;
-  process.stdout.write("\u001B[?1004l\u001B[0m\u001B[?25h\u001B[?1049l");
-};
-
-if (useAlternateScreen) process.stdout.write("\u001B[?1049h\u001B[2J\u001B[H\u001B[?25l");
-const app = render(<App initialPath={initialPath} />, {
-  exitOnCtrlC: false,
-  stdout: createLayeredStdout(process.stdout),
-});
-process.once("exit", restoreScreen);
-// Closing the terminal tab sends SIGHUP and `kill` sends SIGTERM; neither runs "exit"
-// handlers, so stop child processes and restore the screen before leaving.
-for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
-  process.once(signal, () => {
-    terminateRunningProcesses();
-    restoreScreen();
-    process.exit(code);
-  });
-}
-try {
-  await app.waitUntilExit();
-} finally {
-  app.unmount();
-}
-
+const initialPath = launchArgs[0]!;
+if (!process.stdin.isTTY || !process.stdout.isTTY) {
+  console.error("DumbEditor needs an interactive terminal. Run it from a terminal window.");
+  process.exit(1);
+}
+process.title = "DumbEditor";
+const terminal = new ProcessTerminal();
+const exitCode = await new Promise<number>((done) => {
+  const app = new ShellApp({ terminal, initialPath, onExit: done });
+  process.once("exit", () => app.dispose());
+  // Closing the terminal tab sends SIGHUP and `kill` sends SIGTERM; neither runs "exit" handlers,
+  // so stop child processes and give the terminal back before leaving.
+  for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
+    process.once(signal, () => { app.dispose(); done(code); });
+  }
+  app.start().catch((error: unknown) => {
+    app.dispose();
+    console.error(error instanceof Error ? error.message : String(error));
+    done(1);
+  });
+});
+await terminal.drainInput(200, 30);
+process.exit(exitCode);
+
 function overviewMessage(installedVersion: string): string {
   return `DumbEditor ${installedVersion}
 The video editor in the DUMB tools family.
```

Apply this change to `tsup.config.ts`:

```diff
--- a/tsup.config.ts
+++ b/tsup.config.ts
@@ -1,7 +1,7 @@
 import { defineConfig } from "tsup";
 
 export default defineConfig({
-  entry: ["src/cli.tsx"],
+  entry: ["src/cli.ts"],
   format: ["esm"],
   platform: "node",
   target: "node22",
```

Apply this change to `tsconfig.json`:

```diff
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -3,7 +3,6 @@
     "target": "ES2022",
     "module": "NodeNext",
     "moduleResolution": "NodeNext",
-    "jsx": "react-jsx",
     "strict": true,
     "noUnusedLocals": true,
     "noUnusedParameters": true,
@@ -15,5 +14,9 @@
     "declaration": true,
     "outDir": "dist"
   },
-  "include": ["src", "tests", "tsup.config.ts"]
+  "include": [
+    "src",
+    "tests",
+    "tsup.config.ts"
+  ]
 }
```

- [ ] **Step 5: Remove the Ink UI and its dependencies**

```bash
git rm -r src/ui tests/layout.test.ts tests/text-layout.test.ts tests/terminal-layers.test.ts
npm uninstall ink react @types/react
```

`tests/keys.test.ts` loses the Backspace test (that was Ink-specific; pi-tui tells Backspace and Delete apart itself) and imports from the new home:

Apply this change to `tests/keys.test.ts`:

```diff
--- a/tests/keys.test.ts
+++ b/tests/keys.test.ts
@@ -1,14 +1,8 @@
 import assert from "node:assert/strict";
 import test from "node:test";
-import { isBackspace, isFocusReport, playbackStart } from "../src/ui/keys.js";
+import { isFocusReport, playbackStart } from "../src/shell/input/keys.js";
 
-test("treats the macOS and Linux Backspace byte, which Ink reports as delete, as Backspace", () => {
-  assert.equal(isBackspace({ backspace: true, delete: false }), true);
-  assert.equal(isBackspace({ backspace: false, delete: true }), true);
-  assert.equal(isBackspace({ backspace: false, delete: false }), false);
-});
-
-test("recognises focus reports with and without the escape Ink strips", () => {
+test("recognises focus reports with and without the leading escape", () => {
   for (const input of ["[I", "[O", "\u001B[I", "\u001B[O"]) assert.equal(isFocusReport(input), true);
   for (const input of ["I", "O", "[", "[Ix", "hello"]) assert.equal(isFocusReport(input), false);
 });
```

After `npm uninstall`, apply the remaining changes to `package.json` (the `dev` script, and the `test` script: the three deleted test files out, `shell-app` in):

```diff
--- a/package.json
+++ b/package.json
@@ -16,8 +16,8 @@
   "scripts": {
     "build": "tsup",
     "check": "tsc --noEmit",
-    "dev": "tsx src/cli.tsx",
-    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/shell-layout.test.js .test-dist/tests/shell-state.test.js .test-dist/tests/shell-keymap.test.js .test-dist/tests/shell-preview.test.js .test-dist/tests/shell-views.test.js .test-dist/tests/shell-screen.test.js .test-dist/tests/shell-overlays.test.js .test-dist/tests/shell-panels.test.js .test-dist/tests/transcription.test.js",
+    "dev": "tsx src/cli.ts",
+    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/shell-layout.test.js .test-dist/tests/shell-state.test.js .test-dist/tests/shell-keymap.test.js .test-dist/tests/shell-preview.test.js .test-dist/tests/shell-views.test.js .test-dist/tests/shell-screen.test.js .test-dist/tests/shell-overlays.test.js .test-dist/tests/shell-panels.test.js .test-dist/tests/shell-app.test.js .test-dist/tests/transcription.test.js",
     "quality": "npm run check && npm test && npm run build",
     "release:check": "npm run quality && npm pack --dry-run",
     "prepublishOnly": "npm run quality"
```

Update the README's preview section to describe the new behaviour:

Apply this change to `README.md`:

````diff
--- a/README.md
+++ b/README.md
@@ -261,7 +261,7 @@
 
 ## Preview backend
 
-DumbEditor chooses Sixel in Windows Terminal and terminals that advertise Sixel support. Frames are scaled with Lanczos and painted only inside the reserved player surface. The preview is retained and composited with text updates through synchronized terminal output, so typing, chat scrolling, and transport changes do not blank or flash the image.
+DumbEditor chooses Sixel in Windows Terminal and terminals that advertise Sixel support. Frames are scaled with Lanczos and painted only inside the reserved player rectangle. The screen is a fixed-size full-screen view that redraws only the rows that changed, and the picture is a separate layer sent with the text in one synchronized update, only when something could have erased it. A long or multi-line message, a window resize, a streaming answer, or an open panel never moves the panels or the video. Panels such as help, music, export, and the model picker replace the video area while they are open and bring the picture back when they close.
 
 ```powershell
 $env:DUMBEDITOR_PREVIEW = "blocks"
@@ -328,7 +328,7 @@
 npm run release:check
 ```
 
-`npm run release:check` runs the full quality gate and shows the exact npm package contents without publishing. The test suite renders synthetic media with FFmpeg and checks pixels, PCM audio, version commits, input validation, catalog selection, preview lifecycle, terminal text layout, and the editor agent's function-call loop. It does not spend provider credits.
+`npm run release:check` runs the full quality gate and shows the exact npm package contents without publishing. The test suite renders synthetic media with FFmpeg and checks pixels, PCM audio, version commits, input validation, catalog selection, preview lifecycle, the full-screen layout driven through an emulated terminal (long input, resize, streaming, and panels), and the editor agent's function-call loop. It does not spend provider credits.
 
 ## License
 
````

- [ ] **Step 6: Run the tests and the quality gate**

```bash
npx tsc --noEmit
npm run quality
```

Expected: `tsc` prints nothing; `npm run quality` runs 172 tests, 171 passed, 1 skipped (the live OpenRouter test), 0 failed and finishes with `Build success`. Then:

```bash
node dist/cli.js --version
node dist/cli.js --help
node dist/cli.js nothing.mp4 < /dev/null
```

Expected: the version, the full help (unchanged), and `DumbEditor needs an interactive terminal. Run it from a terminal window.` with exit code 1.

- [ ] **Step 7: Manual check in Windows Terminal (a person at a real terminal)**

There is no automated test for how it looks, so the author runs this once:

```bash
npm link
dumbeditor path\to\any-video.mp4
```

| # | Do this | Expected |
| --- | --- | --- |
| 1 | Start it | Header, a sharp video, play bar, hints, chat area, input box and status row; nothing flickers |
| 2 | Paste a very long line, then a multi-line paste | The input box grows, then scrolls inside itself; the side panels, video and cursor do not move |
| 3 | Resize the window narrow, wide and tall | Layout follows; the video re-fits; no leftover picture fragments |
| 4 | `/help`, `/projects`, `/version`, `/export`, `/model`, `/bg-music`, `/assets` | Each opens in the video area and Esc closes it; the video comes back |
| 5 | Ctrl+P, Left/Right, `[` and `]`, `+` and `-` | Play, seek 5 s, marks on the play bar, volume; sound plays |
| 6 | Ask the agent something | The answer streams; `▸` and `✓` tool lines appear; the cost on the status row rises |
| 7 | Type while it works, then Esc with an empty input | `Queued` appears; Esc stops it with `Stopped.` |
| 8 | `/permissions ask`, then ask for a generated image | An approval panel with Deny preselected; Esc denies |
| 9 | Click to another window and back during playback | The picture is still there (it is drawn again on regaining focus) |
| 10 | Mouse wheel over the chat; drag to select text | The chat scrolls; selected text is copied (note it if this gets in the way) |
| 11 | `/quit`, then Ctrl+C from a fresh start | The terminal is restored cleanly; no `ffmpeg` or `ffplay` left running |

- [ ] **Step 8: Commit and review**

```bash
git add -A src tests README.md package.json package-lock.json tsup.config.ts tsconfig.json
git commit -m "feat: replace the Ink UI with the pi-tui shell"
git log --oneline master..HEAD
```

Expected: eight feature commits (Tasks 1 to 8), after the commits already on this branch for the command-list fix and the spec. Do not push or publish: review the branch first.

## Self-review notes

- **Spec coverage:** sections 4 and 5 (architecture, modules) map to Tasks 1 to 8; section 6 to Task 2; section 7 to Task 3; section 8 to Tasks 1 and 5; section 9 to Task 4; section 10 to Tasks 5 to 7; section 11 to Tasks 2 and 8; section 12 to Task 8; section 13 to every task; section 14 (migration) is this task list.
- **Known gaps by design:** how it looks and feels (flicker, mouse selection, Sixel on other terminals) is verified by the Task 8 checklist, not by automated tests; macOS and Linux are covered only by CI until the later research round; the browser and native macOS preview clients are not built (the `PreviewHost` boundary leaves room for them).
