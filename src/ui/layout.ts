import type { MediaInfo } from "../types.js";
import type { PreviewBackend } from "../core/media.js";

export interface EditorLayout {
  playerRows: number;
  chatRows: number;
  leftSidebarColumns: number;
  videoColumns: number;
  rightSidebarColumns: number;
}

export function editorLayout(
  terminal: { columns: number; rows: number },
  media: MediaInfo | null,
  backend: PreviewBackend,
  inputRows = 1,
): EditorLayout {
  const reservedInputRows = 4;
  const fixedRows = 6 + reservedInputRows; // header, timeline, controls, input content + border, footer
  const available = Math.max(8, terminal.rows - fixedRows);
  const minimumChat = terminal.rows < 24 ? 2 : 4;
  const maximumPlayer = Math.max(6, available - minimumChat);
  const contentColumns = Math.max(20, terminal.columns - 2);
  const sidebarColumns = terminal.columns >= 130 ? clamp(Math.floor((contentColumns - 82) / 2), 18, 26) : 0;
  const videoColumns = Math.max(20, contentColumns - sidebarColumns * 2);
  const columns = { leftSidebarColumns: sidebarColumns, videoColumns, rightSidebarColumns: sidebarColumns };
  if (!media) return { playerRows: maximumPlayer, chatRows: chatHeight(terminal.rows, maximumPlayer, inputRows, minimumChat), ...columns };

  const videoAspect = media.width / media.height;
  const cellWidth = positiveInteger(process.env.DUMBEDITOR_CELL_WIDTH, 10);
  const cellHeight = positiveInteger(process.env.DUMBEDITOR_CELL_HEIGHT, 20);
  const ideal = backend === "sixel"
    ? Math.ceil(((videoColumns - 2) * cellWidth) / videoAspect / cellHeight)
    : Math.ceil((videoColumns - 2) / videoAspect / 2);
  const playerRows = clamp(ideal, 6, maximumPlayer);
  return { playerRows, chatRows: chatHeight(terminal.rows, playerRows, inputRows, minimumChat), ...columns };
}

function chatHeight(terminalRows: number, playerRows: number, inputRows: number, minimum: number): number {
  return Math.max(minimum, terminalRows - playerRows - 6 - clamp(inputRows, 1, 4));
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
