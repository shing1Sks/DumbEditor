export interface CellSize { width: number; height: number }

/**
 * The pixel size of one terminal cell, used to turn a picture's size into cells. Sixel and block layouts need a
 * guess: 10x20 unless DUMBEDITOR_CELL_WIDTH / DUMBEDITOR_CELL_HEIGHT say otherwise.
 */
export function cellSize(environment: NodeJS.ProcessEnv = process.env): CellSize {
  return {
    width: positiveInteger(environment.DUMBEDITOR_CELL_WIDTH, 10),
    height: positiveInteger(environment.DUMBEDITOR_CELL_HEIGHT, 20),
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
