import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import type { MediaInfo } from "../types.js";
import { runProcess, terminateProcess, trackProcess } from "./process.js";

interface ProbePayload {
  format?: { duration?: string; format_name?: string };
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    duration?: string;
    avg_frame_rate?: string;
  }>;
}

export async function assertFfmpeg(): Promise<void> {
  await Promise.all([
    runProcess("ffmpeg", ["-version"], { timeoutMs: 8_000, maxOutputBytes: 64_000 }),
    runProcess("ffprobe", ["-version"], { timeoutMs: 8_000, maxOutputBytes: 64_000 }),
  ]);
}

export async function probeMedia(filePath: string): Promise<MediaInfo> {
  await access(filePath);
  const result = await runProcess(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,width,height,duration,avg_frame_rate", "-of", "json", filePath],
    { timeoutMs: 20_000, maxOutputBytes: 2_000_000 },
  );
  const payload = JSON.parse(result.stdout.toString("utf8")) as ProbePayload;
  const video = payload.streams?.find((stream) => stream.codec_type === "video");
  if (!video?.width || !video.height) throw new Error("The selected file has no readable video stream");
  const duration = Number(payload.format?.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not determine the video duration");
  return {
    path: filePath,
    duration,
    width: video.width,
    height: video.height,
    fps: parseRate(video.avg_frame_rate),
    hasAudio: Boolean(payload.streams?.some((stream) => stream.codec_type === "audio")),
    formatName: payload.format?.format_name ?? "unknown",
  };
}

export interface PreviewSize {
  width: number;
  height: number;
}

export type PreviewBackend = "sixel" | "blocks";

export function detectPreviewBackend(environment: NodeJS.ProcessEnv = process.env): PreviewBackend {
  const override = environment.DUMBEDITOR_PREVIEW?.trim().toLowerCase();
  if (override === "blocks" || override === "sixel") return override;
  if (environment.WT_SESSION) return "sixel";
  if (/sixel/i.test(environment.TERM ?? "")) return "sixel";
  return "blocks";
}

export function previewRenderSize(
  info: MediaInfo,
  maxColumns: number,
  maxRows: number,
  backend: PreviewBackend,
): PreviewSize {
  if (backend === "blocks") return previewSize(info, maxColumns, maxRows);
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

export function previewSize(info: MediaInfo, maxColumns: number, maxRows: number): PreviewSize {
  const columnLimit = even(Math.max(0, Math.floor(maxColumns)));
  const pixelHeightLimit = even(Math.max(0, Math.floor(maxRows) * 2));
  if (columnLimit < 2 || pixelHeightLimit < 2) return { width: 0, height: 0 };
  const scale = Math.min(1, columnLimit / info.width, pixelHeightLimit / info.height);
  const width = even(Math.max(2, Math.floor(info.width * scale)));
  const height = even(Math.max(2, Math.floor(info.height * scale)));
  return { width, height };
}

export async function extractFrame(filePath: string, at: number, size: PreviewSize, signal?: AbortSignal): Promise<string> {
  const raw = await extractRawFrame(filePath, at, size, signal);
  return rgbToAnsi(raw, size.width, size.height);
}

export async function extractRawFrame(filePath: string, at: number, size: PreviewSize, signal?: AbortSignal): Promise<Buffer> {
  const result = await runProcess(
    "ffmpeg",
    [
      "-v", "error", "-ss", Math.max(0, at).toFixed(3), "-i", filePath,
      "-frames:v", "1", "-vf", `scale=${size.width}:${size.height}:flags=lanczos`,
      "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ],
    {
      timeoutMs: 20_000,
      maxOutputBytes: size.width * size.height * 3 + 1024,
      ...(signal ? { signal } : {}),
    },
  );
  return result.stdout;
}

export interface PreviewStream {
  process: ChildProcess;
  stop: () => void;
}

export function streamPreview(options: {
  filePath: string;
  start: number;
  size: PreviewSize;
  fps?: number;
  onFrame: (frame: string, time: number) => void;
  onEnd: () => void;
  onError?: (error: Error) => void;
}): PreviewStream {
  return streamRawPreview({
    ...options,
    onFrame: (frame, time) => options.onFrame(rgbToAnsi(frame, options.size.width, options.size.height), time),
  });
}

export function streamRawPreview(options: {
  filePath: string;
  start: number;
  size: PreviewSize;
  fps?: number;
  onFrame: (frame: Buffer, time: number) => void;
  onEnd: () => void;
  onError?: (error: Error) => void;
}): PreviewStream {
  const fps = options.fps ?? 8;
  const frameBytes = options.size.width * options.size.height * 3;
  const child = trackProcess(spawn(
    "ffmpeg",
    [
      "-v", "error", "-ss", Math.max(0, options.start).toFixed(3), "-re", "-i", options.filePath,
      "-an", "-vf", `fps=${fps},scale=${options.size.width}:${options.size.height}:flags=lanczos`,
      "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  ));
  let pending = Buffer.alloc(0);
  let stderr = "";
  let index = 0;
  let errorReported = false;
  child.stdout.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
      options.onFrame(frame, options.start + index / fps);
      index += 1;
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  child.on("error", (error) => {
    errorReported = true;
    options.onError?.(error);
  });
  child.on("close", (code) => {
    if (code !== 0 && !child.killed && !errorReported) {
      options.onError?.(new Error(stderr.trim() || `FFmpeg preview exited with code ${code}`));
    }
    options.onEnd();
  });
  return { process: child, stop: () => terminateProcess(child) };
}

export function encodePreviewFrame(
  buffer: Buffer,
  size: PreviewSize,
  backend: PreviewBackend,
): string {
  return backend === "sixel"
    ? rgbToSixel(buffer, size.width, size.height)
    : rgbToAnsi(buffer, size.width, size.height);
}

export function playAudio(filePath: string, start: number, volume: number, onError?: (error: Error) => void): ChildProcess | null {
  try {
    let stderr = "";
    let errorReported = false;
    const child = trackProcess(spawn(
      "ffplay",
      ["-nodisp", "-autoexit", "-loglevel", "error", "-ss", Math.max(0, start).toFixed(3), "-volume", String(volume), filePath],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    ));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.on("error", (error) => {
      errorReported = true;
      onError?.(error);
    });
    child.on("close", (code) => {
      if (code !== 0 && !child.killed && !errorReported) onError?.(new Error(stderr.trim() || `ffplay exited with code ${code}`));
    });
    return child;
  } catch {
    return null;
  }
}

export function rgbToAnsi(buffer: Buffer, width: number, height: number): string {
  const lines: string[] = [];
  for (let y = 0; y < height; y += 2) {
    let line = "";
    for (let x = 0; x < width; x += 1) {
      const top = (y * width + x) * 3;
      const bottom = ((Math.min(y + 1, height - 1) * width) + x) * 3;
      line += `\u001B[38;2;${buffer[top] ?? 0};${buffer[top + 1] ?? 0};${buffer[top + 2] ?? 0}m`;
      line += `\u001B[48;2;${buffer[bottom] ?? 0};${buffer[bottom + 1] ?? 0};${buffer[bottom + 2] ?? 0}m▀`;
    }
    lines.push(`${line}\u001B[0m`);
  }
  return lines.join("\n");
}

/** Encode RGB24 as a 64-colour Sixel image with ordered dithering. */
export function rgbToSixel(buffer: Buffer, width: number, height: number): string {
  if (buffer.length < width * height * 3) throw new Error("Preview frame is incomplete");
  const palette: string[] = [];
  for (let red = 0; red < 4; red += 1) {
    for (let green = 0; green < 4; green += 1) {
      for (let blue = 0; blue < 4; blue += 1) {
        const index = red * 16 + green * 4 + blue;
        palette.push(`#${index};2;${Math.round(red * 100 / 3)};${Math.round(green * 100 / 3)};${Math.round(blue * 100 / 3)}`);
      }
    }
  }

  const masks = new Uint8Array(64 * width);
  const used = new Uint8Array(64);
  const bands: string[] = [];
  for (let bandY = 0; bandY < height; bandY += 6) {
    masks.fill(0);
    used.fill(0);
    for (let offsetY = 0; offsetY < 6 && bandY + offsetY < height; offsetY += 1) {
      const y = bandY + offsetY;
      for (let x = 0; x < width; x += 1) {
        const pixel = (y * width + x) * 3;
        const threshold = (BAYER_4X4[(y & 3) * 4 + (x & 3)]! - 7.5) * 4;
        const red = quantizeChannel((buffer[pixel] ?? 0) + threshold);
        const green = quantizeChannel((buffer[pixel + 1] ?? 0) + threshold);
        const blue = quantizeChannel((buffer[pixel + 2] ?? 0) + threshold);
        const color = red * 16 + green * 4 + blue;
        const maskIndex = color * width + x;
        masks[maskIndex] = (masks[maskIndex] ?? 0) | (1 << offsetY);
        used[color] = 1;
      }
    }

    const colors: number[] = [];
    for (let color = 0; color < 64; color += 1) if (used[color]) colors.push(color);
    const planes: string[] = [];
    for (const color of colors) {
      const base = color * width;
      let last = width - 1;
      while (last >= 0 && masks[base + last] === 0) last -= 1;
      if (last < 0) continue;
      let row = "";
      let runCharacter = "";
      let runLength = 0;
      for (let x = 0; x <= last; x += 1) {
        const character = String.fromCharCode(63 + (masks[base + x] ?? 0));
        if (character === runCharacter) runLength += 1;
        else {
          row += encodeSixelRun(runCharacter, runLength);
          runCharacter = character;
          runLength = 1;
        }
      }
      row += encodeSixelRun(runCharacter, runLength);
      planes.push(`#${color}${row}`);
    }
    bands.push(planes.join("$"));
  }

  return `\u001BP0;1;0q"1;1;${width};${height}${palette.join("")}${bands.join("-")}\u001B\\`;
}

function parseRate(rate?: string): number {
  if (!rate) return 0;
  const [numerator, denominator] = rate.split("/").map(Number);
  if (!numerator || !denominator) return Number(rate) || 0;
  return numerator / denominator;
}

function even(value: number): number {
  const rounded = Math.floor(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function quantizeChannel(value: number): number {
  return Math.max(0, Math.min(3, Math.round(value / 85)));
}

function encodeSixelRun(character: string, length: number): string {
  if (!character || length <= 0) return "";
  return length >= 4 ? `!${length}${character}` : character.repeat(length);
}

const BAYER_4X4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
] as const;
