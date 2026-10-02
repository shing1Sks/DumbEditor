# DumbEditor UI shell on pi-tui: design

Date: 2026-10-03
Status: draft for review
Scope: step 3 of the DumbEditor practical-version plan. Step 1 (macOS input hotfix) and step 2 (agent engine, PR #1) are merged. This step replaces the Ink UI with a new shell.

## 1. Intent

The terminal UI feels shaky: panels move, the cursor gets lost, the video area breaks when the layout changes, and a long input is enough to trigger it (observed on 2026-10-03: a 3-line input pushed the frame up, the side panels drifted, and the preview reported "Preview frame is incomplete"). The agent engine from step 2 works, and the screen on top of it needs to be as steady as Claude Code or Codex.

There are two causes, and the design addresses both:

1. **The renderer.** Ink 5 erases and repaints the whole frame in the terminal's main buffer, so any change in height scrolls the frame. The Sixel video is painted outside Ink's control at absolute coordinates, which go stale as soon as the frame moves (`src/ui/terminal-layers.ts`).
2. **The structure.** `src/ui/App.tsx` is one 1,100-line component with 54 pieces of state, 9 overlays and the playback loop inside it. Any change can disturb the rest.

**Success** means:

1. A long or multi-line input, a window resize, a streaming answer or an opened popup never moves a panel, the video or the cursor (headless layout tests prove it; the manual checklist confirms how it looks).
2. Every screen and key the current UI has still works.
3. The video stays as sharp as today on terminals with Sixel, and degrades to half-block frames elsewhere.
4. State and key handling can be tested without a terminal.

## 2. Decisions already made

| Decision | Choice | Basis |
| --- | --- | --- |
| Renderer | `@earendil-works/pi-tui` 1.0.0, pinned exactly | Compared with OpenTUI and with staying on Ink. pi-tui is Node-only (same 22.19 floor as step 2), MIT, 2 dependencies, differential rendering with synchronized output, a fixed-size alternate screen with real layout (`VStack`, `HStack`, `ScrollView`), overlays, an `Editor` with autocomplete, and Windows/macOS/Linux prebuilds. OpenTUI would add Bun or Node 26.4 and a binary distribution. Staying on Ink keeps the root cause. |
| Evidence | The spike in `docs/superpowers/spikes/pi-tui/` | Seven emulated-terminal checks pass (long paste, typing, resize, 200-line streaming, new video frame, popup over video). The author ran it in Windows Terminal on 2026-10-03 and reported it "quite smooth", with panels, video and the writing area stable. |
| Platforms | Windows verified now; macOS and Linux get the same code, checked only by CI, and are researched properly in a later round | The user's instruction on 2026-10-03: "forget mac/linux for now but ... we will research and build around that side properly". |
| Preview | A swappable preview client. Now: inline Sixel (Windows Terminal), half-block fallback. Later: browser tab, native macOS window | Terminal.app has no inline image protocol, so the later round decides the macOS route. |
| Engine | Unchanged | The event stream and the actions registry stay exactly as step 2 left them. |

## 3. Non-goals

- A browser preview, a native macOS window, or Kitty/iTerm2 image output (the preview-client boundary leaves room for them).
- New editing features, new slash commands, or changes to the agent's tools.
- Changes to `src/core/engine`, `src/core/actions` or the project and session stores.
- A visual redesign beyond what the layout needs. Looks stay close to today's.

## 4. Architecture

```
Engine events ──┐                              ┌── views (pi-tui components)
EditorState ────┼──> ShellState (pure) ──notify┤
Playback ctrl ──┘        ^                      └── preview host (Sixel layer)
                         │ intents
Keys ──> keymap (pure) ──┘──> registry actions / engine.submit
```

- `ShellState` holds everything the screen shows and has no pi-tui import. It is the only thing views read.
- The keymap turns raw key data into intents (pure functions). Intents are the only way input changes state or reaches the engine and registry.
- Views are small pi-tui components that read `ShellState` and render lines. They never call the engine.
- The preview host owns the video rectangle and the Sixel layer. Playback decoding lives in a playback controller, not in a view.
- A single `requestRender` is coalesced per tick, so bursts of events cost one frame.

## 5. Module map

New code goes in `src/shell/` and the old `src/ui/` is deleted at the end (section 14).

| Path | Responsibility |
| --- | --- |
| `src/shell/state/shell-state.ts` | The store: playback, marks, volume, transcript (including the live streaming message), overlay stack, run status, notices, usage line. Subscribes to `EditorState` and engine events. |
| `src/shell/state/intents.ts` | The intent union and the reducer-style handlers that apply them. |
| `src/shell/input/keymap.ts` | Key data to intent, per context (composer focused, overlay open, approval pending). Reuses `src/ui/keys.ts` (`isBackspace`, `isFocusReport`) and `src/core/commands.ts`. |
| `src/shell/views/` | `transcript.ts` (ScrollView of messages with Markdown and tool lines), `composer.ts` (`Editor` plus slash and `@file` autocomplete), `timeline.ts`, `sidebars.ts`, `status.ts`, `header.ts`. |
| `src/shell/overlays/` | One small component each: `help`, `projects`, `model` (picker), `music`, `assets`, `export`, `history`, `approval`, `choice`. They are pi-tui overlays driven by the overlay stack in `ShellState`. |
| `src/shell/layout.ts` | Pure function: terminal size and state to fixed band sizes and the video rectangle. |
| `src/shell/preview/preview-host.ts` | The layered terminal wrapper, the video rectangle, repaint rules, and hiding under overlays. |
| `src/shell/preview/playback.ts` | ffmpeg frame decoding and ffplay audio (moved out of the view), play/pause/seek, time events. |
| `src/shell/preview/backends.ts` | Backend choice (`sixel` or `blocks`) and the encoders, reusing `src/core/media.ts` (`rgbToSixel`, `rgbToAnsi`). |
| `src/shell/app.ts` | Wires state, keymap, views, preview host and engine; owns start and stop. |
| `src/cli.ts` | Replaces `src/cli.tsx`: argument handling is unchanged, and it starts the shell instead of Ink. |

## 6. State and intents

`ShellState` fields: `project` (name, source path), `media`, `playhead`, `playing`, `volume`, `marks {in,out}`, `transcript` (messages; each has role, label, text, kind: chat | tool | editor | error, and a `live` flag for the streaming message), `chatExpanded`, `overlays` (stack; each entry has a kind and its own data), `run {status, queuedCount, spend}`, `assets`, `usage`, `notice` (one-line status), `suggestions` (slash command matches).

Intents (examples): `play/pause`, `seek(±seconds)`, `setVolume`, `setIn/setOut`, `submit(text)`, `steer(text)`, `abortRun`, `openOverlay(kind)`, `closeOverlay`, `resolveApproval(decision)`, `resolveChoice(answer)`, `scrollChat(delta)`, `toggleChatExpanded`, `runSlashCommand(text)`.

Slash commands keep their current behaviour: deterministic edits go through `parseEditCommand` and the actions registry (`directEditCall`), and the rest are handled by the intent handlers. The offered list in `src/core/commands.ts` already matches (fixed on this branch in commit `6e9d29d`).

## 7. Keys

Same as today (see `src/ui/Help.tsx`), plus the hotfix keys: Ctrl+P play/pause, Left/Right seek 5 s, +/- volume, `[` and `]` marks, Ctrl+O asset browser, Ctrl+K clear music selection, Ctrl+G expand chat, Up/Down and PgUp/PgDn chat scroll or suggestion choice, Tab completes, Esc stops the agent (empty input), closes an overlay, or denies an approval, Ctrl+C stops the run and then quits. Backspace handling and focus-report filtering move into the keymap unchanged. Mouse wheel scrolls the chat.

Keys that conflict with `Editor` shortcuts are decided in the plan after checking pi-tui's keybindings (`matchesKey`, `Key`); the keymap, not the view, resolves every conflict.

## 8. Layout

The screen is pi-tui's alternate screen, so the frame is always exactly the terminal size and nothing scrolls off.

```
HStack band (fixed height H)   [ left sidebar | video rectangle | right sidebar ]
timeline                        1 row
chat (ScrollView)               takes all remaining rows
composer (Editor)               grows 1 to 4 rows, then scrolls inside
status                          1 row
```

- `H` is derived from the video's aspect ratio and the terminal size by `layout.ts` (the logic today in `src/ui/layout.ts`), clamped so the chat keeps at least 2 to 4 rows.
- Sidebars appear at 130 or more columns, with the same widths as today.
- A resize rebuilds the layout root and moves the video rectangle. The composer growing takes rows from the chat only.
- The layout is a pure function and is unit-tested for the same sizes the spike used (80x24, 100x30, 120x40, 160x50).

## 9. Preview host

pi-tui renders text and has no Sixel support, so the video is a separate layer that the host composites into each frame (this is the mechanism proven in the spike):

1. The host wraps the terminal. It holds each frame written by pi-tui for one microtask, so pi-tui has updated its screen copy, then writes the frame and the video layer as one synchronized update (CSI 2026).
2. The layer is `ESC 7`, a cursor move to the video rectangle's top-left, the Sixel image, and `ESC 8`.
3. The layer is only re-sent when something could have erased it: the video frame changed, the rectangle moved (resize), the text rows inside the rectangle's band changed, or the screen was cleared. Typing, editor growth and chat streaming never repaint it.
4. When an overlay overlaps the rectangle, the layer is not drawn, and it is drawn again once when the overlay closes.
5. `blocks` backend: half-block frames are plain text lines inside the video rectangle, drawn by a normal component, so the layer is not needed.
6. Backend choice and the cell-pixel size follow today's logic in `src/core/media.ts` and the `DUMBEDITOR_*` overrides.
7. A `PreviewClient` interface (`start(rect)`, `frame(...)`, `stop()`) hides the above so a browser or native client can replace it later without touching the views.

## 10. Views and overlays (parity)

Every screen in the current UI is ported, not redesigned: chat, timeline, left (project) and right (assets and usage) sidebars, help, projects browser, model picker (capability, provider, model, with search), music browser, asset browser, export popup, version history, approval popup (Allow once, Allow this session, Deny, or Continue and Stop at the spend limit), and the agent's choice popup. Overlays open and close through the overlay stack, never through scattered flags.

## 11. Integration

- `ShellState` subscribes to engine events (`text_delta`, `tool_*`, `approval_request`, `choice_request`, `steer_queued`, `steer_dropped`, `usage`, `compaction`, `error`, `run_end`) and to `EditorState.subscribe`. The adapter code in today's `App.tsx` (`handleEngineEvent`, `createEngine`, the steer-dropped handling, the model-info fetch) moves into `src/shell/app.ts` and the state handlers, with its behaviour kept.
- Opening a project, switching model and quitting follow the current flows. An engine that cannot start still leaves the shell usable with a notice.

## 12. Errors and shutdown

- Stopping restores the terminal through pi-tui (`tui.stop()`), turns off mouse and focus reporting, and prints nothing extra.
- ffmpeg and ffplay children are stopped on `/quit`, Ctrl+C, SIGTERM and SIGHUP (the hotfix behaviour is kept, with `terminateRunningProcesses`).
- An exception inside a view is caught at the render boundary: the frame shows a one-line error and the session keeps running. An uncaught exception stops the terminal modes before printing the error.
- Mouse capture is on for wheel scrolling. The plan verifies text selection and copy in Windows Terminal and decides whether to keep capture on by default (see risks).

## 13. Testing

- **Unit (no terminal):** `ShellState` event handling (streaming, steer, dropped steer, approvals, run end), the intent handlers, the keymap per context, and `layout.ts`.
- **Headless layout tests:** pi-tui driven against an emulated terminal (`@xterm/headless`, a dev dependency), reproducing the failures seen so far: long and multi-line input, resize cycle, 200-line streaming, popup over the video, a new video frame. Assertions: panels do not move, the video is re-sent only when it should be, no full-screen clears, the status stays on the last row, no row is wider than the screen. These run in CI on Windows and macOS.
- **Manual checklist (Windows Terminal):** how it looks, flicker, cursor, mouse wheel and selection, popup over the video, window resize, `/quit` leaving the terminal clean.
- Existing engine and action tests are untouched. `npm run quality` stays the gate.

## 14. Migration and order of work

Branch `ui/pi-tui-shell` (from merged `master`). The new shell is built beside the old UI and takes over at the end:

1. Add the pinned dependencies (pi-tui, xterm headless) and the layout function with tests.
2. `ShellState`, intents and keymap with unit tests.
3. Preview host and playback controller, with the headless layout tests.
4. Views: transcript, composer, timeline, sidebars, status.
5. Overlays, one at a time.
6. Wire `app.ts` and `cli.ts`; run the whole suite; manual checklist with the user.
7. Delete `src/ui/*.tsx` and the Ink and React dependencies; update README and CI.

Each step leaves the project building and the suite green. The old UI keeps working until step 6.

## 15. Risks and open items

- **pi-tui is a new 1.0 library.** It is pinned exactly. If a blocking gap appears, the fallback is OpenTUI, decided before step 3 (the preview host) of the order in section 14.
- **Key conflicts with `Editor`.** Settled in the plan by reading pi-tui's keybinding table; the keymap resolves them.
- **Mouse capture versus text selection.** pi-tui's alternate screen captures the mouse for scrolling and does its own selection and copy. The plan checks it in Windows Terminal and may make capture opt-in.
- **Cell pixel size.** Sixel sizing needs it. Today it is an environment default (10x20); the plan checks whether pi-tui exposes the real value.
- **macOS and Linux** are not verified here and are covered by CI plus the later research round. The code paths do not assume Windows.
- **Windows Terminal Sixel support** is required for the inline video (it is available in current releases); other terminals use half-blocks.

## 16. Success criteria

1. The headless layout tests pass and include the 2026-10-03 failure case.
2. Every slash command, overlay and key listed above works in the new shell.
3. `npm run quality` passes, and the package contains no Ink or React.
4. The author's manual run in Windows Terminal shows no moving panels, no lost cursor and no stray video fragments across long input, resize, streaming and popups.
