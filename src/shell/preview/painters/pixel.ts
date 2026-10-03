import { cellSize } from "./cell-size.js";
import type { CellRect } from "./types.js";

// Shared by the painters that draw a real picture (Sixel, Kitty): its size is in pixels, so its size in cells
// follows from the size of one cell.

export function pixelCells(size: { width: number; height: number }): { columns: number; rows: number } {
  const cell = cellSize();
  return { columns: Math.ceil(size.width / cell.width), rows: Math.ceil(size.height / cell.height) };
}

export function pixelIdealRows(columns: number, aspect: number): number {
  const cell = cellSize();
  return Math.ceil(((columns - 2) * cell.width) / aspect / cell.height);
}

/** The picture is centred in the rectangle; terminal coordinates start at 1. */
export function pixelPlace(encoded: string, size: { width: number; height: number }, rect: CellRect): string {
  const column = rect.x + Math.max(0, Math.floor((rect.w - pixelCells(size).columns) / 2)) + 1;
  const row = rect.y + 1;
  return `\u001B7\u001B[${row};${column}H${encoded}\u001B8`;
}
