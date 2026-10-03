import type { MediaInfo } from "../../src/types.js";

// Frozen copies of the picture code as it was on master 8220c02, before the painter slot. The contract test
// compares the live code with these. If a result differs, the live code changed behaviour.

export type LegacyBackend = "sixel" | "blocks";
export interface LegacySize { width: number; height: number }
export interface LegacyFrame { encoded: string; size: LegacySize; backend: LegacyBackend }
export interface LegacyRect { x: number; y: number; w: number; h: number }

export const LEGACY_FPS = { sixel: 12, blocks: 10 } as const;

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const even = (value: number): number => {
  const rounded = Math.floor(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
};
const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));

export function legacyDetect(environment: NodeJS.ProcessEnv): LegacyBackend {
  const override = environment.DUMBEDITOR_PREVIEW?.trim().toLowerCase();
  if (override === "blocks" || override === "sixel") return override;
  if (environment.WT_SESSION) return "sixel";
  if (/sixel/i.test(environment.TERM ?? "")) return "sixel";
  return "blocks";
}

function legacyPreviewSize(info: MediaInfo, maxColumns: number, maxRows: number): LegacySize {
  const columnLimit = even(Math.max(0, Math.floor(maxColumns)));
  const pixelHeightLimit = even(Math.max(0, Math.floor(maxRows) * 2));
  if (columnLimit < 2 || pixelHeightLimit < 2) return { width: 0, height: 0 };
  const scale = Math.min(1, columnLimit / info.width, pixelHeightLimit / info.height);
  const width = even(Math.max(2, Math.floor(info.width * scale)));
  const height = even(Math.max(2, Math.floor(info.height * scale)));
  return { width, height };
}

export function legacyPreviewRenderSize(info: MediaInfo, maxColumns: number, maxRows: number, backend: LegacyBackend): LegacySize {
  if (backend === "blocks") return legacyPreviewSize(info, maxColumns, maxRows);
  const cellWidth = positiveInteger(process.env.DUMBEDITOR_CELL_WIDTH, 10);
  const cellHeight = positiveInteger(process.env.DUMBEDITOR_CELL_HEIGHT, 20);
  const widthLimit = even(Math.max(0, Math.floor(maxColumns - 2) * cellWidth));
  const heightLimit = even(Math.max(0, Math.floor(maxRows) * cellHeight));
  if (widthLimit < 2 || heightLimit < 2) return { width: 0, height: 0 };
  const scale = Math.min(widthLimit / info.width, heightLimit / info.height);
  return {
    width: even(Math.max(2, Math.floor(info.width * scale))),
    height: even(Math.max(2, Math.floor(info.height * scale))),
  };
}

export function legacyFrameFits(frame: LegacyFrame, rect: LegacyRect): boolean {
  const cellWidth = positiveInteger(process.env.DUMBEDITOR_CELL_WIDTH, 10);
  const cellHeight = positiveInteger(process.env.DUMBEDITOR_CELL_HEIGHT, 20);
  const columns = frame.backend === "sixel" ? Math.ceil(frame.size.width / cellWidth) : frame.size.width;
  const rows = frame.backend === "sixel" ? Math.ceil(frame.size.height / cellHeight) : Math.ceil(frame.size.height / 2);
  return columns <= rect.w && rows <= rect.h;
}

export function legacyBuildVideoLayer(frame: LegacyFrame, rect: LegacyRect): string {
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

export interface LegacyLayout {
  bandRows: number;
  leftSidebarColumns: number;
  videoColumns: number;
  rightSidebarColumns: number;
  gap: number;
}

export function legacyShellLayout(terminal: { columns: number; rows: number }, media: MediaInfo | null, backend: LegacyBackend): LegacyLayout {
  const FIXED_ROWS = 9;
  const MAX_VIDEO_SHARE = 0.6;
  const available = Math.max(8, terminal.rows - FIXED_ROWS);
  const minimumChat = terminal.rows < 24 ? 2 : terminal.rows < 32 ? 4 : 7;
  const maximumBand = Math.max(6, Math.min(available - minimumChat, Math.floor(terminal.rows * MAX_VIDEO_SHARE)));
  const sidebarColumns = terminal.columns >= 130 ? clamp(Math.floor((terminal.columns - 82) / 2), 18, 26) : 0;
  const gap = sidebarColumns > 0 ? 1 : 0;
  const videoColumns = Math.max(20, terminal.columns - sidebarColumns * 2 - gap * 2);
  const columns = { leftSidebarColumns: sidebarColumns, videoColumns, rightSidebarColumns: sidebarColumns, gap };
  if (!media) return { bandRows: maximumBand, ...columns };
  const aspect = media.width / media.height;
  const cellWidth = positiveInteger(process.env.DUMBEDITOR_CELL_WIDTH, 10);
  const cellHeight = positiveInteger(process.env.DUMBEDITOR_CELL_HEIGHT, 20);
  const ideal = backend === "sixel"
    ? Math.ceil(((videoColumns - 2) * cellWidth) / aspect / cellHeight)
    : Math.ceil((videoColumns - 2) / aspect / 2);
  return { bandRows: clamp(ideal, 6, maximumBand), ...columns };
}
