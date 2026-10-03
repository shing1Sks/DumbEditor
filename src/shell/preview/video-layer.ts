import type { PreviewBackend, PreviewSize } from "../../core/media.js";

/** A rectangle in terminal cells, 0-based from the top-left of the screen. */
export interface CellRect { x: number; y: number; w: number; h: number }

export interface EncodedFrame {
  /** A Sixel image, or for the block backend, text rows separated by newlines. */
  encoded: string;
  size: PreviewSize;
  backend: PreviewBackend;
}

/** Whether the picture, drawn at its own size, fits inside the rectangle. After a resize the old picture is bigger than the new rectangle until a new one is made. */
export function frameFits(frame: EncodedFrame, rect: CellRect): boolean {
  const cellWidth = positiveInteger(process.env.DUMBEDITOR_CELL_WIDTH, 10);
  const cellHeight = positiveInteger(process.env.DUMBEDITOR_CELL_HEIGHT, 20);
  const columns = frame.backend === "sixel" ? Math.ceil(frame.size.width / cellWidth) : frame.size.width;
  const rows = frame.backend === "sixel" ? Math.ceil(frame.size.height / cellHeight) : Math.ceil(frame.size.height / 2);
  return columns <= rect.w && rows <= rect.h;
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
