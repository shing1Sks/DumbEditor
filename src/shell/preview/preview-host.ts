import type { Terminal } from "@earendil-works/pi-tui";
import { LayeredTerminal, type VideoLayer } from "./layered-terminal.js";
import { buildVideoLayer, frameFits, type CellRect, type EncodedFrame } from "./video-layer.js";

export interface PreviewHostOptions {
  /** True when the picture should be on screen: a video is open and no panel or expanded chat covers the band. */
  visible(): boolean;
  rect(): CellRect;
  /** The rows pi-tui last drew, one string per terminal row. */
  screenLines(): string[];
  onResize?(): void;
}

/**
 * Owns the video picture. Hand `terminal` to pi-tui instead of the real terminal; new pictures are painted
 * straight away, and the picture is kept on screen across pi-tui's own redraws.
 */
export class PreviewHost {
  readonly terminal: LayeredTerminal;
  private frame: EncodedFrame | null = null;
  private revision = 0;
  private cached: { revision: number; rect: string; output: string } | null = null;

  constructor(inner: Terminal, private readonly options: PreviewHostOptions) {
    this.terminal = new LayeredTerminal(inner, {
      layer: () => this.layer(),
      bandText: (rect) => this.options.screenLines().slice(rect.y, rect.y + rect.h).join("\n"),
      ...(options.onResize ? { onResize: options.onResize } : {}),
    });
  }

  /** Show a new picture. */
  setFrame(frame: EncodedFrame): void {
    this.frame = frame;
    this.revision += 1;
    this.terminal.paint();
  }

  /** Forget the picture, for example when another video is opened. */
  clear(): void {
    this.frame = null;
    this.revision += 1;
    this.cached = null;
  }

  /** Draw the picture again, for example when the window regains focus (Windows Terminal can drop Sixel images). */
  repaint(): void {
    this.terminal.force();
    this.terminal.paint();
  }

  private layer(): VideoLayer | null {
    if (!this.frame || !this.options.visible()) return null;
    const rect = this.options.rect();
    // A picture made for a bigger window would cover the chat and the prompt box: wait for one that fits.
    if (!frameFits(this.frame, rect)) return null;
    const rectKey = `${rect.x},${rect.y},${rect.w},${rect.h}`;
    if (!this.cached || this.cached.revision !== this.revision || this.cached.rect !== rectKey) {
      this.cached = { revision: this.revision, rect: rectKey, output: buildVideoLayer(this.frame, rect) };
    }
    return { rect, revision: this.revision, output: this.cached.output };
  }
}
