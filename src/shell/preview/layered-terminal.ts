import type { Terminal } from "@earendil-works/pi-tui";
import type { CellRect } from "./video-layer.js";

const SYNC_START = "\u001B[?2026h";
const SYNC_END = "\u001B[?2026l";
const FOCUS_IN = "\u001B[I";

export interface VideoLayer {
  rect: CellRect;
  /** Changes whenever there is a new picture to show. */
  revision: number;
  /** The escape sequences that paint the picture (see buildVideoLayer). */
  output: string;
}

export interface LayerHooks {
  /** The picture to show now, or null when nothing should be drawn (no video, or a panel covers it). */
  layer(): VideoLayer | null;
  /** The text currently drawn in the rows of the rectangle, used to notice when something may have erased the picture. */
  bandText(rect: CellRect): string;
  /** Escape sequences that take the picture off the screen, for painters whose picture outlives the text drawn over it. */
  remove?(): string;
  onResize?(): void;
}

/**
 * Wraps the terminal pi-tui draws on. pi-tui writes text only, so the video is a separate layer: each frame
 * is held for one microtask (so pi-tui has updated its copy of the screen), then written together with the
 * layer as one synchronized update. The layer is sent again only when something could have erased it.
 */
export class LayeredTerminal implements Terminal {
  private pending: string[] = [];
  private scheduled = false;
  private forced = true;
  private stopped = false;
  private lastKey: string | null = null;

  constructor(private readonly inner: Terminal, private readonly hooks: LayerHooks) {}

  get columns(): number { return this.inner.columns; }
  get rows(): number { return this.inner.rows; }
  get kittyProtocolActive(): boolean { return this.inner.kittyProtocolActive; }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inner.start((data) => {
      // Windows Terminal can drop Sixel images when its window regains focus; pi-tui swallows the focus
      // report, so watch for it here and draw the picture again.
      if (data === FOCUS_IN) { this.forced = true; this.schedule(); }
      onInput(data);
    }, () => { this.forced = true; this.hooks.onResize?.(); onResize(); });
  }
  /**
   * Give the terminal back. What pi-tui just wrote (leave the alternate screen, mouse off) must reach the terminal
   * now: work queued for a microtask never runs while the process is exiting.
   */
  stop(): void {
    this.stopped = true;
    const cleanup = this.lastKey !== null ? this.hooks.remove?.() ?? "" : "";
    const data = cleanup + this.pending.join("");
    this.pending = [];
    if (data) this.inner.write(data);
    this.inner.stop();
  }
  drainInput(maxMs?: number, idleMs?: number): Promise<void> { return this.inner.drainInput(maxMs, idleMs); }
  moveBy(lines: number): void { this.inner.moveBy(lines); }
  hideCursor(): void { this.inner.hideCursor(); }
  showCursor(): void { this.inner.showCursor(); }
  clearLine(): void { this.inner.clearLine(); }
  clearFromCursor(): void { this.inner.clearFromCursor(); }
  clearScreen(): void { this.forced = true; this.inner.clearScreen(); }
  setTitle(title: string): void { this.inner.setTitle(title); }
  setProgress(active: boolean): void { this.inner.setProgress(active); }

  /** Send the picture with the next frame, for example because the window regained focus and may have dropped it. */
  force(): void { this.forced = true; }

  write(data: string): void {
    if (this.stopped) { this.inner.write(data); return; }
    this.pending.push(data);
    this.schedule();
  }

  /** Draw the picture now even though pi-tui has nothing to draw, for example for a new video frame. */
  paint(): void { this.schedule(); }

  private schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.scheduled = false;
    if (this.stopped) return;
    const data = this.pending.join("");
    this.pending = [];
    const layer = this.hooks.layer();
    if (!layer) {
      let cleanup = "";
      if (this.lastKey !== null) { this.lastKey = null; this.forced = true; cleanup = this.hooks.remove?.() ?? ""; }
      const out = data.endsWith(SYNC_END) && cleanup ? `${data.slice(0, -SYNC_END.length)}${cleanup}${SYNC_END}` : data + cleanup;
      if (out) this.inner.write(out);
      return;
    }
    const key = `${layer.rect.x},${layer.rect.y},${layer.rect.w},${layer.rect.h}|${layer.revision}|${this.hooks.bandText(layer.rect)}`;
    if (!this.forced && key === this.lastKey) {
      if (data) this.inner.write(data);
      return;
    }
    this.lastKey = key;
    this.forced = false;
    this.inner.write(data.endsWith(SYNC_END)
      ? `${data.slice(0, -SYNC_END.length)}${layer.output}${SYNC_END}`
      : `${SYNC_START}${data}${layer.output}${SYNC_END}`);
  }
}
