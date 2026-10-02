# pi-tui spike (throwaway)

Date: 2026-10-03. Question: can a Sixel video layer live inside `@earendil-works/pi-tui` 1.0.0's fixed-size alternate screen without the layout problems the Ink UI has?

The files here are throwaway code that answered the question. They are not part of the product and are kept as evidence only.

| File | What it is |
| --- | --- |
| `app.mjs` | A small shell: left and right panels, a video rectangle, timeline, scrolling chat, `Editor`, status line; plus the layered terminal wrapper that composites the Sixel layer into each frame. |
| `spike.test.mjs` | Seven checks run against an emulated terminal (`@xterm/headless`). |
| `run.mts` | Interactive demo that plays a real video through the layer (run in a real terminal). |

## Result

Emulated terminal, 7 of 7 pass:

1. First frame: panels in place, status on the last row, the video layer at the video rectangle.
2. A pasted line of about 700 characters grows the editor; the panel and video band is unchanged, there is no full-screen clear, and no video repaint.
3. Typing 40 keystrokes causes no video repaint and small frames.
4. Resizing 80x24, 160x50, 100x30 and 120x40: status stays on the last row, the right panel moves to the right column, and the video is placed at the new rectangle.
5. 200 streamed chat lines leave the band untouched, and the chat follows the end.
6. A new video frame repaints the video exactly once.
7. An approval popup over the video hides the video; closing it brings the video back exactly once.

Windows Terminal (author's run, 2026-10-03, playing a 1280x720 clip): "quite smooth"; panels, the Sixel video and the writing area stayed put with a long wrapped input.

## What it means for the design

- The mechanism works: hold pi-tui's frame for one microtask, then write frame plus layer as one CSI 2026 update, re-sending the layer only when the video frame, the rectangle, or the text inside the video band changed.
- pi-tui has no Sixel support (Kitty and iTerm2 only), so the layer is our code.
- Not covered: mouse selection and copy, Editor key conflicts, real cell pixel size, macOS and Linux terminals.
