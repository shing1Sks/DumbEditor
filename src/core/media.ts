import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import type { MediaInfo } from "../types.js";
import { runProcess } from "./process.js";

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
  const result = await runProcess(
    "ffmpeg",
    [
      "-v", "error", "-ss", Math.max(0, at).toFixed(3), "-i", filePath,
      "-frames:v", "1", "-vf", `scale=${size.width}:${size.height}:flags=fast_bilinear`,
      "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ],
    {
      timeoutMs: 20_000,
      maxOutputBytes: size.width * size.height * 3 + 1024,
      ...(signal ? { signal } : {}),
    },
  );
  return rgbToAnsi(result.stdout, size.width, size.height);
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
  const fps = options.fps ?? 8;
  const frameBytes = options.size.width * options.size.height * 3;
  const child = spawn(
    "ffmpeg",
    [
      "-v", "error", "-ss", Math.max(0, options.start).toFixed(3), "-re", "-i", options.filePath,
      "-an", "-vf", `fps=${fps},scale=${options.size.width}:${options.size.height}:flags=fast_bilinear`,
      "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let pending = Buffer.alloc(0);
  let stderr = "";
  let index = 0;
  let errorReported = false;
  child.stdout.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
      options.onFrame(rgbToAnsi(frame, options.size.width, options.size.height), options.start + index / fps);
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
  return { process: child, stop: () => child.kill() };
}

export function playAudio(filePath: string, start: number, volume: number, onError?: (error: Error) => void): ChildProcess | null {
  try {
    let stderr = "";
    let errorReported = false;
    const child = spawn(
      "ffplay",
      ["-nodisp", "-autoexit", "-loglevel", "error", "-ss", Math.max(0, start).toFixed(3), "-volume", String(volume), filePath],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
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

function rgbToAnsi(buffer: Buffer, width: number, height: number): string {
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
