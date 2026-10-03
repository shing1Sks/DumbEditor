# The Mac/Linux picture: Kitty painter, terminal probe, better block art, and the leftovers

Date: 2026-10-03
Status: built (the owner asked to "finish the mac picture and the rest" and delegated the details; the choices below are mine and each says why; section 8 lists what changed after the independent review)
Scope: step 3 of the Mac/Linux round. PR #3 (painter slot, `doctor`, text without libass) is merged. This step makes the picture sharp on the terminals that can show one, makes block art look right in the ones that cannot, adds `DUMBEDITOR_FFMPEG_DIR`, and fixes the leftovers from PR #2.

## 1. Intent

After PR #3 a Mac or Linux user still gets block art unless their terminal advertises Sixel in `TERM`, which almost none do. The research of 2026-10-03 says what to do:

- **Ghostty, kitty, WezTerm, Konsole, iTerm2** speak the Kitty graphics protocol. Ghostty and kitty (and Warp) have no Sixel, so Sixel alone leaves them out.
- **foot, xterm (`-ti vt340`), Konsole, WezTerm, iTerm2, VS Code (with images enabled)** speak Sixel but do not put it in `TERM`.
- **Terminal.app, GNOME Terminal, Alacritty** have no image support. They need good block art. Terminal.app only shows 256 colours on older macOS and does not say so.

**Success** means:

1. On Windows nothing changes: same detection, same picture, no probe, no new bytes. The contract tests from PR #3 pass untouched.
2. On Ghostty, kitty, WezTerm and iTerm2 the preview is a sharp picture played at about 15 frames per second, over the same layout and keys as Sixel.
3. The terminal is asked what it supports (not guessed from environment variables); a terminal that never answers, or one known to misbehave, still gets block art without garbage on screen.
4. Block art in Terminal.app is not banded garbage: it uses the 256-colour palette with dithering when 24-bit colour is not available.
5. `DUMBEDITOR_FFMPEG_DIR` (and automatic use of Homebrew's keg-only `ffmpeg-full`) lets a Mac use the FFmpeg that has libass.
6. The known leftovers from PR #2 that are cheap to fix are fixed.

## 2. Decisions

| Decision | Choice | Basis |
| --- | --- | --- |
| New painters | **One: `kitty`.** No iTerm2 inline-image painter. | iTerm2 speaks both the Kitty protocol and Sixel, so it gets one of those. An iTerm2-only painter would need a JPEG or PNG encoder per frame (no JPEG in Node's standard library) for a terminal already covered. YAGNI. The earlier chat plan listed iTerm2; this narrows it, and says so. |
| Order | Override, then Kitty, then Sixel, then block art. | Kitty has no palette limit and no dithering, and the terminal keeps one image per id. |
| How to know | Ask the terminal once, before the screen starts: a Kitty graphics query, the cell-size query (`CSI 16t`), the terminal-name query (`CSI > 0 q`), then the device-attributes query (`CSI c`) last as a sentinel. DA1 attribute 4 means Sixel. | The DA1 reply always comes, and comes after the earlier replies, so one read ends the probe. No fixed guess of a terminal's name. |
| Where not to ask | Windows (all of it), tmux, screen and Zellij, `TERM_PROGRAM=Apple_Terminal`, and anything that is not a TTY. | Windows must not change. Terminal.app prints the last character of sequences it does not know. tmux filters image sequences (and Kitty needs a passthrough wrapper, out of scope). |
| Timeout | 300 ms, 1000 ms over SSH. After a timeout, known environment hints (`KITTY_WINDOW_ID`, `TERM=xterm-kitty` / `xterm-ghostty`, `TERM_PROGRAM=ghostty` / `WezTerm`) still choose Kitty. | A slow link must not silently downgrade the picture. |
| Overrides | `DUMBEDITOR_PREVIEW=blocks\|sixel\|kitty\|auto` (today: blocks, sixel). A picture setting outside Windows still asks the terminal once, for the cell size only. | Needed for testing (WezTerm on Windows can show Kitty with `DUMBEDITOR_PREVIEW=kitty`) and for odd setups. |
| Cell size | The probe's `CSI 16t` answer is used for the picture size, in place of the 10x20 guess, on non-Windows. Precedence: `DUMBEDITOR_CELL_*` env, then measured, then 10x20. | The guess is why a picture can look small or stretched on a Retina display. Windows keeps the guess. |
| Kitty transfer | Raw RGB (`f=24`), direct (`t=d`), 4096-byte base64 chunks, `q=2`, one image id and placement id reused every frame, `C=1`, and both `c` and `r` (the picture is made a whole number of cells wide and tall, so it fills them exactly); zlib (`o=z`) only over SSH or when `DUMBEDITOR_KITTY_COMPRESS=1`. | The smallest subset every Kitty-speaking terminal accepts. Shared memory and temp files do not work over SSH and Node has no `shm_open`. Compression costs CPU, so it is for slow links. |
| Frame rate | Kitty 15 fps (Sixel stays 12, blocks 10). | Kitty has no quantisation step, so a frame is cheaper to make; the terminal decodes at its own speed. Not measured on real terminals, so it is a starting point (see risks). |
| Persistence | A painter can say its picture survives text drawn over it (`persistent`). Sixel and blocks do not. The Kitty painter says so only when the terminal is kitty itself (its name or `KITTY_WINDOW_ID`); in every other terminal it is sent again when the text around it changes. | A Sixel image is erased by text, so it is re-sent when the band's text changes. A Kitty image is kept in kitty, but pi-tui's own code notes that WezTerm erases image cells when a line is cleared over them, and nothing says the others do not. Wrong persistence leaves a hole in the picture; resending only costs bandwidth. |
| Removal | Kitty's `remove()` deletes the image and frees its data. It is written when a panel covers the video, on resize to nothing, and when the app stops. | Unlike Sixel, a Kitty image stays on screen until deleted. The `remove` hook added in PR #3 was built for this. |
| Block colours | 24-bit colour (as today) except in Terminal.app without `COLORTERM`, or when `DUMBEDITOR_COLOR=256`: then the 6x6x6 cube plus grey ramp, ordered dithering. `DUMBEDITOR_COLOR=truecolor` forces 24-bit. | Terminal.app is the one common terminal that is 256-colour and cannot be told apart by `TERM`. Everything else stays as it is. |
| FFmpeg location | `DUMBEDITOR_FFMPEG_DIR` names the folder with `ffmpeg`, `ffprobe`, `ffplay`. On macOS, if it is unset and Homebrew's `ffmpeg-full` keg exists, that folder is used. Applied in `runProcess` and the few direct `spawn` calls. | `ffmpeg-full` is keg-only, so installing it does nothing until PATH is edited; using it when present removes that step. On Windows and Linux only the env var counts. |

## 3. Non-goals

- An iTerm2 inline-image painter, Kitty inside tmux (passthrough or unicode placeholders), Kitty shared-memory or temp-file transfer, sextant or quadrant block art.
- A launcher that opens another terminal, or a Mac app.
- Publishing or a version bump.
- The Help/History "swallow typing" behaviour and the double picture send on panel close from the PR #2 list (low value, noted as left).

## 4. Architecture

### 4.1 Terminal probe (`src/shell/preview/painters/probe.ts`)

```ts
export interface ProbeResult { kitty: boolean; sixel: boolean; cell: { width: number; height: number } | null; name: string | null }
export interface ProbeTransport { write(data: string): void; onData(listener: (data: string) => void): () => void }
export function parseProbeReply(buffer: string): ProbeResult | null   // null until the DA1 reply is in the buffer
export function probeTerminal(transport: ProbeTransport, timeoutMs: number): Promise<ProbeResult | null>  // null on timeout
export function stdioTransport(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): ProbeTransport      // raw mode on, restored after
```

`parseProbeReply` is pure and tested against recorded replies. `stdioTransport` puts stdin in raw mode for the probe only and restores its previous mode and pause state, so pi-tui starts from a clean stdin.

### 4.2 Detection (`painters/detect.ts`)

`async detectPainter(options: { env; platform; stdin; stdout; probe? }): Promise<{ id: PainterId; reason: string; probed: ProbeResult | null }>` applies section 2. `detectPreviewBackend` (sync, env only) stays exactly as it is for tests and for Windows. `cli.ts` calls `detectPainter` before creating `ShellApp` and passes the id as the existing `backend` option; the probe's cell size goes to `setMeasuredCell`.

### 4.3 Kitty painter (`painters/kitty.ts`)

`PainterId` gains `"kitty"` (`PreviewBackend` in `media.ts` gets the same member). `encode(rgb, size)` returns the whole chunked APC sequence for one transmit-and-display with the image's id; `place` wraps it with cursor save, move to the rectangle's centred top-left, and restore; `cells`/`idealRows`/`renderSize` use the same pixel formulas as Sixel (shared in `painters/pixel.ts`); `remove()` is `ESC _ G a=d,d=I,i=<id>,q=2 ESC \`. `Painter` gains `persistent: boolean` (Kitty true, others false) and `LayeredTerminal` leaves the band text out of its change key for a persistent layer.

### 4.4 Block art colours (`painters/blocks.ts`, `painters/color.ts`)

`colorMode(env)` returns `"truecolor"` or `"256"` by the rule above; the blocks painter encodes with `rgbToAnsi` (today's function, untouched) or the new `rgbToAnsi256`.

### 4.5 FFmpeg location (`src/core/binaries.ts`)

`resolveBinary(name: "ffmpeg" | "ffprobe" | "ffplay"): string` returns a path inside the chosen directory or the bare name. `runProcess` maps its command through it, and the direct `spawn` calls in `media.ts` and `music.ts` do the same. `doctor` shows which FFmpeg is used.

### 4.6 Leftovers

Model picker saves once on a double Enter; pasted text reaches panel search fields; an asset panel replaced by another panel stops its playback; the "agent could not start" notice survives the history load; Help and Export fit 80x24; `italic` and `cyan` (unused) and the stale Ink comment go; the test that says "Escape" but sends Ctrl+C is renamed truthfully.

## 5. Windows safety

| Layer | Guarantee |
| --- | --- |
| Contract tests | `tests/windows-contract.test.ts` (PR #3) runs unchanged. It pins detection, sizes, layers, layout and encoder hashes. |
| No probe on Windows | `detectPainter` returns the sync rule for `win32` before touching stdin. A test pins this with a transport that fails if used. |
| Cell size | Measured only from a probe; Windows never probes, so 10x20 stays. |
| Colour | Windows is always truecolor, as today. |
| Persistent flag | False for Sixel and blocks, so their change key is byte for byte the old one (a test pins it). |
| FFmpeg dir | Unset means the bare names, as today. The macOS keg rule is gated on `darwin`. |

## 6. Testing

- **Probe:** recorded reply bytes for kitty, Ghostty, WezTerm, iTerm2, foot, xterm, Konsole, Terminal.app (no Kitty answer, DA1 without 4), VS Code; a transport that never answers; garbage before the reply; stdin mode restored.
- **Detection table:** every row of section 2, including Windows (never probes), tmux, Terminal.app, a slow link, hints after a timeout, overrides.
- **Kitty encoding:** a small decoder in the tests parses the APC stream the way a terminal does (keys, chunk continuation, base64, optional zlib), and asserts the pixels equal the input frame, the keys and ids are right, chunks are at most 4096 bytes, and `remove` deletes the same id. This pins the format; real rendering is checked by the owner (below).
- **Layer behaviour:** persistent layers are not resent on a text change, are removed when a panel covers them and on stop; non-persistent layers behave as before.
- **Blocks 256:** palette mapping, dithering bounds, escape format; mode selection table.
- **Binaries:** directory override, keg rule only on darwin, `runProcess` and `spawn` use it, bare names otherwise.
- **Leftovers:** a test each that failed before.
- **By hand (cannot be tested from here):** run `DUMBEDITOR_PREVIEW=kitty` or plain auto-detect in Ghostty, kitty, WezTerm and iTerm2 and in Terminal.app (block art, 256 colours); play, pause, resize, open a panel over the playing video, quit and check no picture is left behind.

## 7. Risks and open points

1. **Real-terminal behaviour is untested from this machine.** The Kitty protocol is checked by decoding our own output against the spec; how Ghostty, kitty, WezTerm and iTerm2 draw it, and the real frame rate, are not measured. If WezTerm is installed here the owner can run `DUMBEDITOR_PREVIEW=kitty` on Windows to see it.
2. **15 fps is a starting point.** If a terminal cannot keep up, frames are dropped by the existing "keep only the newest" queue, not queued up.
3. **Warp** (reported with and without Kitty support in different sources) is treated like any other terminal: the probe decides.
4. **Konsole** implements a subset of the Kitty protocol; the chosen subset (direct raw RGB) is the minimal one.
5. **iTerm2** answers the Kitty query on current versions; on an older one it falls to Sixel.
6. **Probe on a terminal that echoes unknown queries** would print garbage; Terminal.app, tmux and screen are excluded for that reason, and the probe is skipped when stdout is not a TTY.

## 8. What changed after the independent review

- **Persistence default.** The first version assumed every Kitty-speaking terminal keeps the picture when a line is cleared over it. pi-tui's source says WezTerm does not. It is now off everywhere except kitty itself (section 2).
- **Exact cells.** A picture sent with only `c` could come out one row taller than the band. The size is now snapped to whole cells and both `c` and `r` are sent; a test checks that the covered rows never exceed the band for several cell sizes.
- **Dithering.** The 256-colour dither added noise to flat black and greys. A colour within 6 units of a palette entry is now used as it is.
- **`.env` safety.** `DUMBEDITOR_FFMPEG_DIR` is read from the real environment and the user's config file only, never from a `.env` in the current folder, because it chooses which program runs. The folder is made absolute.
- **Probe.** It keeps listening for 30 ms after the answer and for 150 ms after a timeout and uses what arrived; any failure to switch the terminal's input mode is an unanswered probe, not a crash. Zellij is not asked.
- **Tests.** One that passed without the code it covers (late replies) and one that only tested a fallback (the FFmpeg folder) now pin their behaviour; every spawn site is proven to use the chosen folder with a stand-in program.
