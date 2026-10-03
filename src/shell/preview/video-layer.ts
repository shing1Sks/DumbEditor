import { painterFor } from "./painters/index.js";
import type { CellRect, EncodedFrame } from "./painters/types.js";

export type { CellRect, EncodedFrame } from "./painters/types.js";

/** Whether the picture, drawn at its own size, fits inside the rectangle. After a resize the old picture is bigger than the new rectangle until a new one is made. */
export function frameFits(frame: EncodedFrame, rect: CellRect): boolean {
  const { columns, rows } = painterFor(frame.backend).cells(frame.size);
  return columns <= rect.w && rows <= rect.h;
}

/**
 * The escape sequences that paint one picture inside the video rectangle: save the cursor, move, draw, restore.
 * The cursor is never hidden, because the composer's cursor must stay visible.
 */
export function buildVideoLayer(frame: EncodedFrame, rect: CellRect): string {
  if (!frame.encoded) return "";
  return painterFor(frame.backend).place(frame, rect);
}
