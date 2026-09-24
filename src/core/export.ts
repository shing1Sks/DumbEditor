import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { MediaInfo } from "../types.js";
import { probeMedia } from "./media.js";
import { runProcess } from "./process.js";

export const EXPORT_FORMATS = ["mp4", "mkv"] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number];

export const EXPORT_PRESETS = ["copy", "high", "balanced", "compact"] as const;
export type ExportPreset = typeof EXPORT_PRESETS[number];

export interface ExportPresetDetails {
  id: ExportPreset;
  label: string;
  description: string;
  video: string;
  audio: string;
}

export interface ExportResult {
  path: string;
  bytes: number;
  media: MediaInfo;
  format: ExportFormat;
  preset: ExportPreset;
}

export const EXPORT_PRESET_DETAILS: readonly ExportPresetDetails[] = [
  { id: "copy", label: "No recompression", description: "Fast container export with unchanged streams and file size.", video: "Stream copy", audio: "Stream copy" },
  { id: "high", label: "High quality", description: "CRF 18 for near-source quality with moderate compression.", video: "H.264 · CRF 18", audio: "AAC · 192 kb/s" },
  { id: "balanced", label: "Balanced", description: "CRF 23 for a useful quality and size balance.", video: "H.264 · CRF 23", audio: "AAC · 160 kb/s" },
  { id: "compact", label: "Small file", description: "CRF 28 for sharing when size matters more than fine detail.", video: "H.264 · CRF 28", audio: "AAC · 128 kb/s" },
] as const;

export function exportDestination(sourcePath: string, requested: string | undefined, format: ExportFormat): string {
  const fallback = join(dirname(sourcePath), `${basename(sourcePath, extname(sourcePath))}-export.${format}`);
  const candidate = resolve(requested?.trim() || fallback);
  const currentExtension = extname(candidate).toLowerCase();
  if (currentExtension === ".mp4" || currentExtension === ".mkv") return `${candidate.slice(0, -currentExtension.length)}.${format}`;
  return `${candidate}.${format}`;
}

export async function exportVideo(options: {
  input: string;
  destination: string;
  format: ExportFormat;
  preset: ExportPreset;
  onStage?: (stage: string) => void;
  signal?: AbortSignal;
}): Promise<ExportResult> {
  const input = resolve(options.input);
  const output = exportDestination(input, options.destination, options.format);
  if (output.toLowerCase() === input.toLowerCase()) throw new Error("Export destination must be different from the active video.");
  const preset = EXPORT_PRESET_DETAILS.find((item) => item.id === options.preset);
  if (!preset) throw new Error(`Unknown export preset: ${options.preset}`);
  await mkdir(dirname(output), { recursive: true });
  const temporary = join(dirname(output), `.dumbeditor-export-${randomUUID()}${extname(output)}`);
  try {
    options.onStage?.(preset.id === "copy" ? "Remuxing without recompression" : `Compressing · ${preset.label}`);
    await runProcess("ffmpeg", exportArguments(input, temporary, options.format, preset.id), {
      timeoutMs: 60 * 60_000,
      maxOutputBytes: 8_000_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    options.onStage?.("Checking exported video");
    const media = await probeMedia(temporary);
    options.onStage?.("Writing destination file");
    await copyFile(temporary, output);
    const file = await stat(output);
    return { path: output, bytes: file.size, media, format: options.format, preset: options.preset };
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function exportArguments(input: string, output: string, format: ExportFormat, preset: ExportPreset): string[] {
  const common = ["-y", "-v", "error", "-i", input, "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "0"];
  if (preset === "copy") return [...common, "-c", "copy", ...(format === "mp4" ? ["-movflags", "+faststart"] : []), output];
  const values = preset === "high"
    ? { crf: "18", audio: "192k", speed: "medium" }
    : preset === "balanced"
      ? { crf: "23", audio: "160k", speed: "medium" }
      : { crf: "28", audio: "128k", speed: "slow" };
  return [
    ...common,
    "-c:v", "libx264", "-preset", values.speed, "-crf", values.crf, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", values.audio,
    ...(format === "mp4" ? ["-movflags", "+faststart"] : []),
    output,
  ];
}
