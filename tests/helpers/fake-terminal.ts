import { createRequire } from "node:module";
import type { Terminal } from "@earendil-works/pi-tui";

// @xterm/headless is CommonJS; load it the way Node's ESM loader can.
const { Terminal: XTerm } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");

/** A pi-tui terminal that draws into an emulator, so tests can read the screen and the bytes written. */
export class FakeTerminal implements Terminal {
  readonly writes: string[] = [];
  private cols: number;
  private rowCount: number;
  private readonly emulator: InstanceType<typeof XTerm>;
  private readonly pending: Promise<void>[] = [];
  private onInput: (data: string) => void = () => undefined;
  private onResize: () => void = () => undefined;

  constructor(columns = 120, rows = 40) {
    this.cols = columns;
    this.rowCount = rows;
    this.emulator = new XTerm({ cols: columns, rows, allowProposedApi: true });
  }

  get columns(): number { return this.cols; }
  get rows(): number { return this.rowCount; }
  get kittyProtocolActive(): boolean { return false; }
  start(onInput: (data: string) => void, onResize: () => void): void { this.onInput = onInput; this.onResize = onResize; }
  stop(): void { /* nothing to restore */ }
  async drainInput(): Promise<void> { /* no stdin */ }
  write(data: string): void {
    this.writes.push(data);
    this.pending.push(new Promise<void>((done) => { this.emulator.write(data, done); }));
  }
  moveBy(lines: number): void { this.write(lines > 0 ? `\x1b[${lines}B` : lines < 0 ? `\x1b[${-lines}A` : ""); }
  hideCursor(): void { this.write("\x1b[?25l"); }
  showCursor(): void { this.write("\x1b[?25h"); }
  clearLine(): void { this.write("\x1b[2K"); }
  clearFromCursor(): void { this.write("\x1b[J"); }
  clearScreen(): void { this.write("\x1b[2J\x1b[H"); }
  setTitle(): void { /* not shown */ }
  setProgress(): void { /* not shown */ }

  /** Type or paste: the same bytes a real terminal would send. */
  send(data: string): void { this.onInput(data); }
  resize(columns: number, rows: number): void {
    this.cols = columns;
    this.rowCount = rows;
    this.emulator.resize(columns, rows);
    this.onResize();
  }
  /** Wait for pi-tui's render timers and for the emulator to consume everything written. */
  async settle(ms = 90): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await Promise.all(this.pending.splice(0));
  }
  /** What is on screen now, one string per row, trailing spaces trimmed. */
  screen(): string[] {
    const buffer = this.emulator.buffer.active;
    return Array.from({ length: this.rowCount }, (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? "");
  }
  mark(): number { return this.writes.length; }
  since(mark: number): string { return this.writes.slice(mark).join(""); }
}

/** Where Sixel images were placed (1-based row and column of the cursor move just before each image). */
export function sixelPlacements(output: string): Array<[number, number]> {
  return [...output.matchAll(/\x1b\[(\d+);(\d+)H(?:\x1b[78])?\x1bP[\d;]*q/g)].map((match) => [Number(match[1]), Number(match[2])]);
}

export const STUB_SIXEL = "\x1bPq\"1;1;40;40#0;2;0;0;0#0!40~\x1b\\";
