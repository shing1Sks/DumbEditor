# Mac and Linux foundation: picture painters, setup check, portable text

Date: 2026-10-03
Status: draft for review
Scope: the first two pieces of the Mac/Linux round. PR #1 (agent engine) and PR #2 (pi-tui shell) are merged. This spec covers (1) a swappable picture painter with the Windows output left byte-identical, and (2) a `dumbeditor doctor` setup check plus text and captions that work on an FFmpeg without libass. Kitty, iTerm2 and better block art are step 3 and get their own spec.

## 1. Intent

DumbEditor works well on Windows Terminal, which is the only place it is verified. On macOS and Linux the same code runs, but three things fail or degrade (study of 2026-10-03):

1. **Picture.** The app picks Sixel only when `WT_SESSION` is set or `TERM` mentions sixel; everywhere else it falls back to half-block art. Most Mac terminals have no Sixel (Ghostty, kitty and Warp use the Kitty image protocol, Terminal.app and Alacritty have nothing).
2. **Text and captions.** Homebrew's `ffmpeg` dropped libass and FreeType in January 2026, so the `ass` filter used for text overlays and burned-in subtitles does not exist ("No such filter: 'ass'"). The macOS CI run showed it.
3. **No guidance.** Nothing tells a user what their FFmpeg or terminal lacks or how to fix it.

The owner's constraint: **do not regress Windows while this is figured out.** Hence a separation in code, not a fork or a long-lived branch.

**Success** means:

1. On Windows the picture bytes, layout and behaviour are exactly what they are today. A test written against the current code before any change proves it.
2. A new painter can be added without touching the engine, the layered terminal logic or the screen (step 3 adds Kitty and iTerm2 that way).
3. `dumbeditor doctor` tells a user, in plain words and with the exact install command for their OS, what is missing and what each missing piece costs.
4. Adding text and importing SRT/VTT captions work on an FFmpeg without libass, with the same look settings (position, size, colour, time range) as today.
5. The full suite passes on Windows, Ubuntu and macOS CI, with no skipped text checks.

## 2. Decisions

| Decision | Choice | Basis |
| --- | --- | --- |
| Separation | Same repo, short branches off `master`, no fork, no long-lived platform branch | About 95% of the app is shared (engine, actions, editor, panels). A fork or branch would copy it and make every shared fix a two-way merge. |
| Seams | Two: a **painter** chosen by terminal capability, and small **per-OS service files** | The picture depends on the terminal, not the OS: a Windows user in WezTerm could use Kitty, a Mac user in iTerm2 can use Sixel. Only install hints and (later) the terminal launcher depend on the OS. |
| Windows safety | Pure refactor first, goldens recorded from the current code, Windows takes the old path, new code in new files, Windows CI required | See section 7. |
| Text without libass | Render text to a transparent PNG and use FFmpeg's `overlay`, which every build has. Keep libass as the path whenever it exists. | Windows (Gyan build) has libass, so its path does not change. |
| Image renderer | `@napi-rs/canvas` (Skia, no system libraries, prebuilt for macOS, Linux and Windows), as an optional dependency imported on first use | Alternatives: `drawtext` needs FreeType (the same gap), `sharp` text depends on system fonts. |
| npm release | Stay one package; use dist-tags (`latest` stays the Windows-verified build, `next` for Mac/Linux previews). Not published by this work. | A per-OS split (launcher plus optional per-OS packages) only pays off if binaries diverge; revisit then. |

## 3. Non-goals

- Kitty, iTerm2 or improved block output, terminal capability probes (step 3).
- A launcher that re-opens the editor in another terminal, a Mac app, a browser preview.
- Changes to the engine, the actions registry, the sandbox, or the agent's tools.
- Bundling FFmpeg.
- Publishing to npm or changing the version.

## 4. Step 1: the painter slot

### 4.1 Interface

A painter turns RGB frames into something the layer can place, and says how the picture covers the screen. New file `src/shell/preview/painters/types.ts`:

```ts
export type PainterId = "sixel" | "blocks";            // step 3 adds "kitty" and "iterm2"
export interface CellSize { width: number; height: number }

export interface Painter {
  readonly id: PainterId;
  /** Frames per second asked of FFmpeg while playing. */
  readonly fps: number;
  /** Pixel size of the picture for a rectangle of columns x rows cells. */
  renderSize(media: MediaInfo, columns: number, rows: number, cell: CellSize): PreviewSize;
  /** One RGB frame to the string the layer carries. */
  encode(rgb: Buffer, size: PreviewSize): string;
  /** Terminal cells the encoded picture covers. */
  cells(size: PreviewSize, cell: CellSize): { columns: number; rows: number };
  /** Escape sequences that draw the picture centred in the rectangle. */
  place(frame: EncodedFrame, rect: CellRect, cell: CellSize): string;
  /** Escape sequences that take the picture off the screen. Sixel and blocks return "" because text overwrites them. */
  remove(): string;
}
```

`EncodedFrame` keeps `{ encoded, size }` and its `backend` field becomes `painter: PainterId`.

### 4.2 What moves where

| Today | After |
| --- | --- |
| `media.ts`: `rgbToSixel`, `rgbToAnsi`, `previewRenderSize` (sixel branch), `previewSize` (blocks branch), `encodePreviewFrame`, `detectPreviewBackend`, `PreviewBackend` | The functions stay where they are (the `core/media` tests and `streamPreview` still use them). `painters/sixel.ts` and `painters/blocks.ts` are thin objects that call them. `detectPreviewBackend` becomes `choosePainter` in `painters/choose.ts` with the same rule. |
| `video-layer.ts`: `buildVideoLayer`, `frameFits`, the `10x20` cell constants | `buildVideoLayer` and `frameFits` call `painter.place` and `painter.cells`. One `cellSize()` (same rule as today: env override, else 10x20) replaces the four copies in `media.ts`, `layout.ts` and `video-layer.ts`. |
| `playback.ts`: `fps: backend === "sixel" ? 12 : 10`, `previewRenderSize`, `encodePreviewFrame` | Uses `painter.fps`, `painter.renderSize`, `painter.encode`. |
| `layered-terminal.ts` | Gains one hook `remove(): string`, written when the layer goes away (a panel opens, resize, exit). For Sixel and blocks it returns `""`, so nothing extra is written. |
| `layout.ts`: `backend === "sixel"` | Asks `painter.cells` for the ideal width instead of comparing a string. |
| `app.ts`, `screen.ts`, `controls.ts` | Hold a `Painter` instead of a `PreviewBackend`; the status row shows `painter.id`. |

### 4.3 Visible changes: none

Only names change (`backend` fields become `painter`). The controls row prints the backend name today ("sixel" or "blocks") and keeps printing the same strings for the same terminals.

### 4.4 What this step does not do

It changes no behaviour. There is no new painter, no probing and no new detection rule. If a result differs from before, the refactor is wrong.

## 5. Step 2a: `dumbeditor doctor`

A new subcommand next to `setup`, `--help` and `--version` in `src/cli.ts`. It prints a short report and exits 0 when everything the editor needs is present, 1 when something required is missing. Optional gaps only warn.

| Check | Required | What it reads | If missing |
| --- | --- | --- | --- |
| Node | yes | `process.version` against `engines` | Says to install Node 22.19 or newer. |
| FFmpeg and ffprobe | yes | `ffmpeg -version`, `ffprobe -version` | Install command for this OS. |
| Encoders `libx264`, `aac` | yes | `ffmpeg -encoders` | Same. |
| Filters the editor uses (`scale`, `fps`, `crop`, `overlay`, `hstack`, `colorchannelmixer`, `hue`, `boxblur`, `volume`) | yes | `ffmpeg -filters` | Same. |
| Text and captions | no | `ass` and `subtitles` present: "through libass". Otherwise "through images (needs the optional image library)". Neither: unavailable. | Explains the cost and the fix. |
| `ffplay` | no | `ffplay -version` | "No sound in the preview." Install hint. |
| Terminal picture | no | Which painter is chosen and why (`WT_SESSION`, `TERM`, override) | One line: what a better terminal would give. |
| Agent sandbox | no | `localSandboxStatus()` (already exists) | Its own message (`dumbeditor setup` on Windows). |
| Provider key | no | Whether `OPENROUTER_API_KEY` is set (never its value) | "The agent is off until you run `dumbeditor setup`." |

Per-OS install hints live in `src/platform/hints.ts`, one small block per OS:
- macOS: `brew install ffmpeg-full` (keg-only, so it prints the PATH line too) or the `homebrew-ffmpeg/ffmpeg` tap.
- Ubuntu/Debian: `sudo apt install ffmpeg`.
- Windows: `winget install Gyan.FFmpeg`.
- Other Linux: the distro package, plus a pointer to static builds.

`FFMPEG_PATH` is not added here (see open decisions).

The probing and the report are separate so tests need no FFmpeg: `parseFilters(text)`, `parseEncoders(text)` and `buildReport(inputs)` are pure, and a `Probe` interface (run a command, return its output) is injected. Tests feed real-looking outputs for three builds (Homebrew slim, Gyan full, Ubuntu).

## 6. Step 2b: text and captions without libass

### 6.1 Capability, cached

`core/ffmpeg-capabilities.ts` runs `ffmpeg -hide_banner -filters` once per process and exposes `hasFilter(name)`. A test hook, `DUMBEDITOR_TEXT_RENDERER=image|libass`, forces a path so every CI platform can exercise both.

### 6.2 Text overlay

`prepareText` keeps its code. At the top it asks `textPath()`: libass when the `ass` filter exists (and the hook does not force images), otherwise images.
- **libass:** unchanged.
- **images:** `core/text-image.ts` draws the text on a transparent canvas of the video's size with the same inputs (font size, colour, one of the nine positions, outline and shadow like the ASS style), saves a PNG in the workspace, and returns it as the extra input `-loop 1 -i text.png` with the graph `[0:v:0][1:v]overlay=enable='between(t,A,B)'[vout]`. The render plan already carries raw extra input arguments (the image-overlay edit uses `-loop 1 -i image`).

### 6.3 Captions

`prepareSubtitles` keeps its code for the libass path.
- **images:** SRT and VTT are parsed into cues (`core/captions.ts`), each cue is drawn as a PNG, and overlays are chained, one per cue, each with its own time window. The cue count is capped (200). More cues: the error says what to install and points to `dumbeditor doctor`.
- `.ass` and `.ssa` files need libass for their styling. Without it the error says so. They are not approximated.

### 6.4 Fonts and the dependency

- One bold sans font file under `assets/fonts/`, licensed under the SIL Open Font License, added to `package.json` `files`. The libass path used "Arial"; the image path must not depend on system fonts. Other scripts (CJK, emoji) fall back to system fonts through the canvas library's system-font loading, which is a best effort and documented as such.
- `@napi-rs/canvas` goes in `optionalDependencies` and is imported on first use. If it is missing and libass is missing, the error points to `dumbeditor doctor`. A failed optional install must never fail `npm install`.

## 7. Windows safety

| Layer | What it guarantees |
| --- | --- |
| **Goldens from the current code** | Before step 1 changes anything, a test file records what the current code produces and is committed first: a hash of the Sixel bytes for fixed RGB frames at three sizes, the exact `buildVideoLayer` output for a table of frame/rectangle pairs (centred, edge, blocks), `frameFits` and `previewRenderSize` results, and the detector's answer for a table of environments (`WT_SESSION` set, `TERM=xterm-256color`, `TERM=xterm-sixel`, the override). After the refactor these tests must pass unchanged. |
| **Existing emulated-terminal tests** | `shell-app`, `shell-preview`, `shell-screen`, `stream-preview` already drive the whole screen with a real FFmpeg video and check Sixel placement and repaint rules. They stay as they are. |
| **Windows takes the old path** | `choosePainter` returns Sixel for `WT_SESSION` exactly as today; nothing is added before it. Step 3's new painters are only reachable where today's rule would return blocks. |
| **Text path** | Windows FFmpeg has libass, so it keeps the libass code path byte for byte; the image path is only reached by the test hook or an FFmpeg without libass. |
| **New code in new files** | `painters/*`, `platform/hints.ts`, `core/doctor.ts`, `core/ffmpeg-capabilities.ts`, `core/text-image.ts`, `core/captions.ts`. Shared files only gain a slot. |
| **CI** | Windows, Ubuntu and macOS jobs on every push. The Windows job is the gate for merging. |
| **Manual** | The PR carries a short Windows Terminal checklist (the one from PR #2 is the base). The author runs it before `latest` moves. |

## 8. Testing

- **Step 1:** the goldens above; a new unit test per painter (`encode`, `cells`, `place`, `remove`); `choose` table test; LayeredTerminal test that `remove()` is written once when a layer goes away and nothing is written when it returns `""`.
- **Step 2a:** `parseFilters`/`parseEncoders` against three recorded outputs; `buildReport` for a complete setup, the Homebrew-slim setup, and a missing FFmpeg; the CLI subcommand's exit code and a no-secrets check (the report contains no key values).
- **Step 2b:** a pixel test that the PNG text sits in the right place and colour for each of the nine positions; an FFmpeg end-to-end that renders text and captions with the image path (forced by the hook) and checks the frames inside and outside the time range; the SRT/VTT cue parser; the cue cap. The macOS `advanced-editor` skip and its version-count branch are removed, because both paths run everywhere.
- Everything runs in the existing suite (`npm run quality`).

## 9. Delivery

Branch `platform/foundation` off `master` (this commit). Commits: goldens first, then the refactor, then doctor, then text. One PR into `master`. No version bump and no publish. The first Mac/Linux preview release, when the owner wants one, goes out under the `next` dist-tag.

## 10. Risks and open decisions

1. **Optional native dependency on Windows.** npm installs `@napi-rs/canvas` for Windows too (it chooses the platform build itself). Size and install time are not measured yet; the plan measures them first. The fallback, if unacceptable, is to ship the image path as an opt-in that `doctor` tells the user to enable.
2. **Font choice** is not made. Recommended: one Noto Sans Bold file (OFL). The owner may prefer another.
3. **The 200-cue cap** is a guess. The plan measures the render time of 50, 100 and 200 chained overlays.
4. **`FFMPEG_PATH`** (point to a specific FFmpeg, useful for the keg-only `ffmpeg-full`) is left out to keep this step small. It touches every `spawn("ffmpeg")` call and belongs with step 3 or its own change.
5. **Warp and Konsole** image support is unverified; it only matters in step 3.
6. **macOS CI** installs the slim Homebrew FFmpeg on purpose. It is the hardest case for the text path and must pass.
