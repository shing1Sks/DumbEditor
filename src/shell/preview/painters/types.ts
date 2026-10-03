import type { PreviewBackend, PreviewSize } from "../../../core/media.js";
import type { MediaInfo } from "../../../types.js";

/** A rectangle in terminal cells, 0-based from the top-left of the screen. */
export interface CellRect { x: number; y: number; w: number; h: number }

/** The id of a painter. It is the backend name the rest of the app already uses. */
export type PainterId = PreviewBackend;

export interface EncodedFrame {
  /** What the painter's `encode` made: a Sixel image, or for the block painter, text rows separated by newlines. */
  encoded: string;
  size: PreviewSize;
  backend: PainterId;
}

/** Turns RGB frames into something the video layer can place, and knows how the picture covers the screen. */
export interface Painter {
  readonly id: PainterId;
  /** Frames per second asked of FFmpeg while playing. */
  readonly fps: number;
  /**
   * Whether the picture stays on screen when text is drawn over it. A Sixel image is erased by text, so it is drawn
   * again when the text around it changes; a Kitty image is not, so it is only drawn again when it changes.
   */
  readonly persistent: boolean;
  /** Pixel size of the picture for a rectangle of columns x rows cells. */
  renderSize(media: MediaInfo, columns: number, rows: number): PreviewSize;
  /** One RGB24 frame to the string the layer carries. */
  encode(rgb: Buffer, size: PreviewSize): string;
  /** Terminal cells the encoded picture covers. */
  cells(size: PreviewSize): { columns: number; rows: number };
  /** Rows of the band that suit a video of this aspect ratio in this many columns. */
  idealRows(columns: number, aspect: number): number;
  /** Escape sequences that draw the picture centred in the rectangle, leaving the cursor where it was. */
  place(frame: EncodedFrame, rect: CellRect): string;
  /** Escape sequences that take the picture off the screen. Empty when text drawn over it is enough. */
  remove(): string;
}
