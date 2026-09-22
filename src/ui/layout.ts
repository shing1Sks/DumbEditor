import type { MediaInfo } from "../types.js";
import type { PreviewBackend } from "../core/media.js";

export interface EditorLayout {
  playerRows: number;
  chatRows: number;
}

export function editorLayout(
  terminal: { columns: number; rows: number },
  media: MediaInfo | null,
  backend: PreviewBackend,
): EditorLayout {
  const fixedRows = 7; // header, timeline, controls, input border (3), footer
  const available = Math.max(8, terminal.rows - fixedRows);
  const minimumChat = terminal.rows < 24 ? 2 : 4;
  const maximumPlayer = Math.max(6, available - minimumChat);
  if (!media) return { playerRows: maximumPlayer, chatRows: minimumChat };

  const videoAspect = media.width / media.height;
  const cellWidth = positiveInteger(process.env.DUMBEDITOR_CELL_WIDTH, 10);
  const cellHeight = positiveInteger(process.env.DUMBEDITOR_CELL_HEIGHT, 20);
  const ideal = backend === "sixel"
    ? Math.ceil(((terminal.columns - 4) * cellWidth) / videoAspect / cellHeight)
    : Math.ceil((terminal.columns - 4) / videoAspect / 2);
  const playerRows = clamp(ideal, 6, maximumPlayer);
  return { playerRows, chatRows: Math.max(minimumChat, available - playerRows) };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
