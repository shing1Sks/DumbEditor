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
