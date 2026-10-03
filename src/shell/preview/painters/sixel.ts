import { previewRenderSize, rgbToSixel } from "../../../core/media.js";
import { pixelCells, pixelIdealRows, pixelPlace } from "./pixel.js";
import type { Painter } from "./types.js";

/** A Sixel image painted at an absolute position (Windows Terminal, and terminals that advertise Sixel). */
export const sixelPainter: Painter = {
  id: "sixel",
  fps: 12,
  persistent: false,
  renderSize: (media, columns, rows) => previewRenderSize(media, columns, rows, "sixel"),
  encode: (rgb, size) => rgbToSixel(rgb, size.width, size.height),
  cells: pixelCells,
  idealRows: pixelIdealRows,
  place: (frame, rect) => pixelPlace(frame.encoded, frame.size, rect),
  remove: () => "",
};
