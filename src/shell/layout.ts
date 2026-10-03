import type { PreviewBackend } from "../core/media.js";
import type { MediaInfo } from "../types.js";
import { painterFor } from "./preview/painters/index.js";

export interface ShellLayout {
  /** Height of the band that holds the sidebars and the video. It never depends on what is typed. */
  bandRows: number;
  leftSidebarColumns: number;
  videoColumns: number;
  rightSidebarColumns: number;
  /** Columns of empty space between a sidebar and the video; 0 when there are no sidebars. */
  gap: number;
}

/**
 * Rows outside the band and the chat: header, a spacer under it, the play bar, the controls row, a spacer above the
 * prompt box, the prompt box with one line of text (3 rows), and the status row.
 */
const FIXED_ROWS = 9;
/** The video never takes more than this share of the screen, so the conversation keeps room. */
const MAX_VIDEO_SHARE = 0.6;

export function shellLayout(
  terminal: { columns: number; rows: number },
  media: MediaInfo | null,
  backend: PreviewBackend,
): ShellLayout {
  const available = Math.max(8, terminal.rows - FIXED_ROWS);
  const minimumChat = terminal.rows < 24 ? 2 : terminal.rows < 32 ? 4 : 7;
  const maximumBand = Math.max(6, Math.min(available - minimumChat, Math.floor(terminal.rows * MAX_VIDEO_SHARE)));
  const sidebarColumns = terminal.columns >= 130 ? clamp(Math.floor((terminal.columns - 82) / 2), 18, 26) : 0;
  const gap = sidebarColumns > 0 ? 1 : 0;
  const videoColumns = Math.max(20, terminal.columns - sidebarColumns * 2 - gap * 2);
  const columns = { leftSidebarColumns: sidebarColumns, videoColumns, rightSidebarColumns: sidebarColumns, gap };
  if (!media) return { bandRows: maximumBand, ...columns };

  const ideal = painterFor(backend).idealRows(videoColumns, media.width / media.height);
  return { bandRows: clamp(ideal, 6, maximumBand), ...columns };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
