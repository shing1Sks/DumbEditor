import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TextPosition } from "./advanced-editor.js";

type CanvasModule = typeof import("@napi-rs/canvas");

export class ImageTextUnavailable extends Error {
  constructor() {
    super("Drawing text needs either an FFmpeg with libass or the optional image library (@napi-rs/canvas), and neither is available. Run `dumbeditor doctor` to see how to fix it.");
    this.name = "ImageTextUnavailable";
  }
}

const FONT_FILES: Array<[family: string, file: string]> = [
  ["DumbEditor Latin", "noto-sans-latin-700-normal.woff"],
  ["DumbEditor Latin Ext", "noto-sans-latin-ext-700-normal.woff"],
  ["DumbEditor Cyrillic", "noto-sans-cyrillic-700-normal.woff"],
  ["DumbEditor Greek", "noto-sans-greek-700-normal.woff"],
];
const FONT_STACK = `${FONT_FILES.map(([family]) => `"${family}"`).join(", ")}, sans-serif`;
const MARGIN = 20;
const OUTLINE = 2;
const SHADOW = 1;

let loaded: Promise<CanvasModule | null> | null = null;

function fontDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(directory, "assets", "fonts"))) return join(directory, "assets", "fonts");
    directory = dirname(directory);
  }
  throw new Error("The bundled fonts were not found");
}

let override: (() => Promise<CanvasModule | null>) | null = null;

/** Test hook: replace how the canvas library is loaded (null restores the real loader). */
export function overrideCanvasLoader(loader: (() => Promise<CanvasModule | null>) | null): void {
  override = loader;
}

/** The optional canvas library with the bundled fonts registered, or null when it is not installed. */
export function loadCanvas(): Promise<CanvasModule | null> {
  if (override) return override();
  loaded ??= import("@napi-rs/canvas")
    .then((canvas) => { registerFonts(canvas); return canvas; }, () => null);
  return loaded;
}

/** Why the bundled fonts could not be registered, or null when they are. The library itself is fine in that case. */
let fontProblem: string | null = null;

function registerFonts(canvas: CanvasModule): void {
  try {
    const directory = fontDirectory();
    const failed = FONT_FILES.filter(([family, file]) => !canvas.GlobalFonts.registerFromPath(join(directory, file), family));
    fontProblem = failed.length === 0 ? null : `could not register ${failed.map(([, file]) => file).join(", ")}`;
  } catch (error) {
    fontProblem = error instanceof Error ? error.message : String(error);
  }
}

/** The families the bundled fonts register under (for tests and diagnostics). */
export const FONT_FAMILIES: readonly string[] = FONT_FILES.map(([family]) => family);

/** Greedy word wrap. Explicit line breaks stay, and a word longer than the line gets a line of its own. */
export function wrapLines(text: string, maxWidth: number, widthOf: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const attempt = line ? `${line} ${word}` : word;
      if (line && widthOf(attempt) > maxWidth) { lines.push(line); line = word; } else line = attempt;
    }
    lines.push(line);
  }
  return lines;
}

export interface TextImage { png: Buffer; width: number; height: number; x: number; y: number }

export interface TextImageOptions {
  videoWidth: number;
  videoHeight: number;
  text: string;
  fontSize: number;
  color: string;
  position: TextPosition;
}

function parts(position: TextPosition): { horizontal: "left" | "center" | "right"; vertical: "top" | "middle" | "bottom" } {
  if (position === "center") return { horizontal: "center", vertical: "middle" };
  const [vertical, horizontal] = position.split("-") as ["top" | "bottom", "left" | "center" | "right"];
  return { horizontal, vertical };
}

/**
 * Draw the text on a transparent image cropped to the text, and say where to lay it on the video. The look follows the
 * libass style the editor used: bold, a 2 px dark outline, a soft shadow, 20 px margins.
 */
export async function renderTextImage(options: TextImageOptions): Promise<TextImage> {
  if (!/^#?[0-9a-f]{6}$/i.test(options.color)) throw new Error("Text color must be a six digit hex color");
  const canvas = await loadCanvas();
  if (!canvas) throw new ImageTextUnavailable();
  if (fontProblem) throw new Error(`The bundled fonts for drawing text could not be loaded (${fontProblem}). Reinstall DumbEditor, or use an FFmpeg with libass (run \`dumbeditor doctor\`).`);
  const font = `bold ${options.fontSize}px ${FONT_STACK}`;
  const measure = canvas.createCanvas(1, 1).getContext("2d");
  measure.font = font;
  const widthOf = (text: string) => measure.measureText(text).width;
  const lines = wrapLines(options.text, Math.max(1, options.videoWidth - MARGIN * 2), widthOf);
  const lineHeight = Math.round(options.fontSize * 1.2);
  const pad = OUTLINE + SHADOW + 2;
  const width = Math.min(options.videoWidth, Math.ceil(Math.max(...lines.map(widthOf))) + pad * 2);
  const height = Math.min(options.videoHeight, lines.length * lineHeight + pad * 2);
  const image = canvas.createCanvas(width, height);
  const context = image.getContext("2d");
  const { horizontal, vertical } = parts(options.position);
  context.font = font;
  context.textAlign = horizontal;
  context.textBaseline = "middle";
  context.lineJoin = "round";
  const textX = horizontal === "left" ? pad : horizontal === "right" ? width - pad : width / 2;
  const colour = options.color.startsWith("#") ? options.color : `#${options.color}`;
  lines.forEach((line, index) => {
    const y = pad + index * lineHeight + lineHeight / 2;
    context.fillStyle = "rgba(0,0,0,0.5)";
    context.fillText(line, textX + SHADOW, y + SHADOW);
    context.lineWidth = OUTLINE * 2;
    context.strokeStyle = "#000000";
    context.strokeText(line, textX, y);
    context.fillStyle = colour;
    context.fillText(line, textX, y);
  });
  const x = horizontal === "left" ? MARGIN : horizontal === "right" ? options.videoWidth - MARGIN - width : Math.round((options.videoWidth - width) / 2);
  const y = vertical === "top" ? MARGIN : vertical === "bottom" ? options.videoHeight - MARGIN - height : Math.round((options.videoHeight - height) / 2);
  return {
    png: await image.encode("png"),
    width, height,
    x: Math.max(0, Math.min(options.videoWidth - width, x)),
    y: Math.max(0, Math.min(options.videoHeight - height, y)),
  };
}
