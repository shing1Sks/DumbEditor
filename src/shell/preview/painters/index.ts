import { blocksPainter } from "./blocks.js";
import { sixelPainter } from "./sixel.js";
import type { Painter, PainterId } from "./types.js";

export type { CellRect, EncodedFrame, Painter, PainterId } from "./types.js";
export { cellSize } from "./cell-size.js";

const PAINTERS: Record<PainterId, Painter> = { sixel: sixelPainter, blocks: blocksPainter };

export function painterFor(id: PainterId): Painter {
  return PAINTERS[id];
}

/** Why `detectPreviewBackend` chose what it chose, in words a user can act on (used by `dumbeditor doctor`). */
export function explainBackend(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.DUMBEDITOR_PREVIEW?.trim().toLowerCase();
  if (override === "blocks" || override === "sixel") return `set by DUMBEDITOR_PREVIEW=${override}`;
  if (environment.WT_SESSION) return "Windows Terminal (Sixel)";
  if (/sixel/i.test(environment.TERM ?? "")) return "TERM advertises Sixel";
  return "no Sixel support detected in this terminal";
}
