import { deflateSync } from "node:zlib";
import { previewRenderSize } from "../../../core/media.js";
import { cellSize } from "./cell-size.js";
import { pixelCells, pixelIdealRows, pixelPlace } from "./pixel.js";
import type { Painter } from "./types.js";

// The Kitty graphics protocol (https://sw.kovidgoyal.net/kitty/graphics-protocol/), in the smallest form that every
// terminal that speaks it accepts: raw RGB, sent directly (not through a file or shared memory, which do not work
// over SSH), in chunks of at most 4096 base64 characters. Every frame carries the same image id and placement id,
// so the terminal replaces the picture in place and keeps one image in memory.

const CHUNK = 4096;
/** One id per process, so two running editors in one terminal do not replace each other's picture. */
const IMAGE_ID = 1 + Math.floor(Math.random() * 0x7ffffffe);

/** zlib only where it pays: over SSH, or when DUMBEDITOR_KITTY_COMPRESS says 1 (0 turns it off). */
export function compressionOn(environment: NodeJS.ProcessEnv): boolean {
  const setting = environment.DUMBEDITOR_KITTY_COMPRESS;
  if (setting === "1") return true;
  if (setting === "0") return false;
  return Boolean(environment.SSH_CONNECTION);
}

/** The escape sequences that transmit one RGB frame and show it, fitted to exactly `columns` x `rows` cells. */
export function kittyTransmit(
  rgb: Buffer,
  size: { width: number; height: number },
  options: { id: number; columns: number; rows: number; compress: boolean },
): string {
  const bytes = size.width * size.height * 3;
  if (rgb.length < bytes) throw new Error("Preview frame is incomplete");
  const pixels = rgb.subarray(0, bytes);
  const payload = (options.compress ? deflateSync(pixels, { level: 1 }) : pixels).toString("base64");
  const keys = [
    "a=T", "f=24", `s=${size.width}`, `v=${size.height}`, `i=${options.id}`, "p=1", `c=${options.columns}`, `r=${options.rows}`, "C=1", "q=2",
    ...(options.compress ? ["o=z"] : []),
  ].join(",");
  let output = "";
  for (let offset = 0; offset === 0 || offset < payload.length; offset += CHUNK) {
    const chunk = payload.slice(offset, offset + CHUNK);
    const more = offset + CHUNK < payload.length ? 1 : 0;
    output += `\u001B_G${offset === 0 ? `${keys},` : ""}m=${more};${chunk}\u001B\\`;
  }
  return output;
}

/** The sequence that deletes an image and frees its data. */
export function kittyDelete(id: number): string {
  return `\u001B_Ga=d,d=I,i=${id},q=2\u001B\\`;
}

let persistent = false;

/**
 * Whether the picture survives a line being cleared over it. Only kitty itself is known to keep it (pi-tui notes that
 * WezTerm erases image cells on a line clear), so every other terminal gets the picture sent again when the text
 * around it changes. Set once at startup from the terminal's name.
 */
export function setKittyPersistent(value: boolean): void {
  persistent = value;
}

/** True for kitty itself, by the name it gives (`CSI > 0 q`) or its environment. */
export function kittyKeepsImages(name: string | null | undefined, environment: NodeJS.ProcessEnv): boolean {
  return /^kitty/i.test(name ?? "") || Boolean(environment.KITTY_WINDOW_ID);
}

/** A real picture in terminals that speak the Kitty graphics protocol: Ghostty, kitty, WezTerm, Konsole, iTerm2. */
export const kittyPainter: Painter = {
  id: "kitty",
  fps: 15,
  get persistent() { return persistent; },
  /** The picture is made a whole number of cells wide and tall, so it fills them exactly and nothing spills into the row below. */
  renderSize(media, columns, rows) {
    const size = previewRenderSize(media, columns, rows, "kitty");
    if (size.width === 0 || size.height === 0) return size;
    const cell = cellSize();
    return {
      width: Math.max(cell.width, Math.floor(size.width / cell.width) * cell.width),
      height: Math.max(cell.height, Math.floor(size.height / cell.height) * cell.height),
    };
  },
  encode(rgb, size) {
    const { columns, rows } = pixelCells(size);
    return kittyTransmit(rgb, size, { id: IMAGE_ID, columns, rows, compress: compressionOn(process.env) });
  },
  cells: pixelCells,
  idealRows: pixelIdealRows,
  place: (frame, rect) => pixelPlace(frame.encoded, frame.size, rect),
  remove: () => kittyDelete(IMAGE_ID),
};
