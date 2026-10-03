export interface CellSize { width: number; height: number }

let measured: CellSize | null = null;

/** The pixel size of a cell as the terminal reported it, or null to forget it. Only a probe sets this, and Windows never probes. */
export function setMeasuredCell(size: CellSize | null): void {
  measured = size && size.width > 0 && size.height > 0 ? { width: size.width, height: size.height } : null;
}

/**
 * The pixel size of one terminal cell, used to turn a picture's size into cells. DUMBEDITOR_CELL_WIDTH and
 * DUMBEDITOR_CELL_HEIGHT win, then what the terminal reported, then a guess of 10x20.
 */
export function cellSize(environment: NodeJS.ProcessEnv = process.env): CellSize {
  return {
    width: positiveInteger(environment.DUMBEDITOR_CELL_WIDTH, measured?.width ?? 10),
    height: positiveInteger(environment.DUMBEDITOR_CELL_HEIGHT, measured?.height ?? 20),
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
