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
