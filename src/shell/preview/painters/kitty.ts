import { deflateSync } from "node:zlib";
import { previewRenderSize } from "../../../core/media.js";
import { pixelCells, pixelIdealRows, pixelPlace } from "./pixel.js";
import type { Painter } from "./types.js";

// The Kitty graphics protocol (https://sw.kovidgoyal.net/kitty/graphics-protocol/), in the smallest form that every
// terminal that speaks it accepts: raw RGB, sent directly (not through a file or shared memory, which do not work
// over SSH), in chunks of at most 4096 base64 characters. Every frame carries the same image id and placement id,
// so the terminal replaces the picture in place and keeps one image in memory.

const CHUNK = 4096;
/** One id per process, so two running editors in one terminal do not replace each other's picture. */
const IMAGE_ID = 1 + Math.floor(Math.random() * 0x7ffffffe);

function compressionOn(environment: NodeJS.ProcessEnv): boolean {
  const setting = environment.DUMBEDITOR_KITTY_COMPRESS;
  if (setting === "1") return true;
  if (setting === "0") return false;
  return Boolean(environment.SSH_CONNECTION);
}

/** The escape sequences that transmit one RGB frame and show it. `columns` makes the terminal fit the width; the height follows the aspect ratio. */
export function kittyTransmit(
  rgb: Buffer,
  size: { width: number; height: number },
  options: { id: number; columns: number; compress: boolean },
): string {
  if (rgb.length < size.width * size.height * 3) throw new Error("Preview frame is incomplete");
  const payload = (options.compress ? deflateSync(rgb.subarray(0, size.width * size.height * 3), { level: 1 }) : rgb.subarray(0, size.width * size.height * 3)).toString("base64");
  const keys = [
    "a=T", "f=24", `s=${size.width}`, `v=${size.height}`, `i=${options.id}`, "p=1", `c=${options.columns}`, "C=1", "q=2",
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

/** A real picture in terminals that speak the Kitty graphics protocol: Ghostty, kitty, WezTerm, Konsole, iTerm2. */
export const kittyPainter: Painter = {
  id: "kitty",
  fps: 15,
  persistent: true,
  renderSize: (media, columns, rows) => previewRenderSize(media, columns, rows, "kitty"),
  encode: (rgb, size) => kittyTransmit(rgb, size, { id: IMAGE_ID, columns: pixelCells(size).columns, compress: compressionOn(process.env) }),
  cells: pixelCells,
  idealRows: pixelIdealRows,
  place: (frame, rect) => pixelPlace(frame.encoded, frame.size, rect),
  remove: () => kittyDelete(IMAGE_ID),
};
