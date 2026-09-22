import { rm } from "node:fs/promises";
import type { DirectEdit, MediaInfo, TimeRange, VersionEntry } from "../types.js";
import { probeMedia } from "./media.js";
import { runProcess } from "./process.js";
import { ProjectStore } from "./project.js";
import { formatTime, normalizeRange } from "./time.js";

export async function executeDirectEdit(
  store: ProjectStore,
  edit: DirectEdit,
  request: string,
  onStage?: (stage: string) => void,
): Promise<{ version: VersionEntry; media: MediaInfo }> {
  const input = store.current.filePath;
  const media = await probeMedia(input);
  const output = store.nextOutputPath(".mp4");
  const { args, summary } = buildEdit(input, output, media, edit);

  try {
    onStage?.("Rendering with FFmpeg");
    await runProcess("ffmpeg", args, { timeoutMs: 30 * 60_000, maxOutputBytes: 8_000_000 });
    onStage?.("Checking rendered video");
    const outputMedia = await probeMedia(output);
    onStage?.("Saving new version");
    const version = await store.commit({
      outputPath: output,
      action: summary,
      request,
      duration: outputMedia.duration,
    });
    return { version, media: outputMedia };
  } catch (error) {
    await rm(output, { force: true }).catch(() => undefined);
    throw error;
  }
}

function buildEdit(input: string, output: string, media: MediaInfo, edit: DirectEdit): { args: string[]; summary: string } {
  if (edit.action === "remove") return buildRemove(input, output, media, edit.ranges);
  if (edit.action === "trim") return buildTrim(input, output, media, edit.range);
  if (edit.action === "speed") return buildSpeed(input, output, media, edit.range, edit.factor);
  if (edit.action === "mute") return buildMute(input, output, media, edit.range);
  return buildCrop(input, output, media, edit);
}

function buildRemove(input: string, output: string, media: MediaInfo, ranges: TimeRange[]) {
  const normalized = normalizeRemovalRanges(ranges, media.duration);
  if (normalized.length === 0) throw new Error("The requested ranges do not remove any video");
  const keep: TimeRange[] = [];
  let cursor = 0;
  for (const range of normalized) {
    if (range.start > cursor + 0.001) keep.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < media.duration - 0.001) keep.push({ start: cursor, end: media.duration });
  if (keep.length === 0) throw new Error("That request would remove the entire video");
  const filter = concatFilter(keep.map((range) => ({ ...range, factor: 1 })), media.hasAudio);
  const args = encodeArgs(input, output, media.hasAudio, filter.graph, filter.video, filter.audio);
  const summary = `Removed ${normalized.map((range) => `${formatTime(range.start)}–${formatTime(range.end)}`).join(", ")}`;
  return { args, summary };
}

function buildTrim(input: string, output: string, media: MediaInfo, requested: TimeRange) {
  assertFiniteRange(requested);
  const range = normalizeRange(requested.start, requested.end, media.duration);
  if (range.end - range.start < 0.01) throw new Error("The kept range is empty");
  const filter = concatFilter([{ ...range, factor: 1 }], media.hasAudio);
  return {
    args: encodeArgs(input, output, media.hasAudio, filter.graph, filter.video, filter.audio),
    summary: `Kept ${formatTime(range.start)}–${formatTime(range.end)}`,
  };
}

function buildSpeed(input: string, output: string, media: MediaInfo, requested: TimeRange, factor: number) {
  assertFiniteRange(requested);
  if (!Number.isFinite(factor) || factor <= 0) throw new Error("Speed factor must be greater than zero");
  const range = normalizeRange(requested.start, requested.end, media.duration);
  if (range.end - range.start < 0.01) throw new Error("The speed range is empty");
  const segments: Array<TimeRange & { factor: number }> = [];
  if (range.start > 0.001) segments.push({ start: 0, end: range.start, factor: 1 });
  segments.push({ ...range, factor });
  if (range.end < media.duration - 0.001) segments.push({ start: range.end, end: media.duration, factor: 1 });
  const filter = concatFilter(segments, media.hasAudio);
  return {
    args: encodeArgs(input, output, media.hasAudio, filter.graph, filter.video, filter.audio),
    summary: `${factor}x speed at ${formatTime(range.start)}–${formatTime(range.end)}`,
  };
}

function buildMute(input: string, output: string, media: MediaInfo, requested: TimeRange) {
  if (!media.hasAudio) throw new Error("This video has no audio stream to mute");
  assertFiniteRange(requested);
  const range = normalizeRange(requested.start, requested.end, media.duration);
  if (range.end - range.start < 0.01) throw new Error("The mute range is empty");
  const filter = `[0:a:0]volume=enable='between(t,${fixed(range.start)},${fixed(range.end)})':volume=0[aout]`;
  const args = [
    "-y", "-v", "error", "-i", input,
    "-filter_complex", filter,
    "-map", "0:v:0", "-map", "[aout]",
    ...videoEncoding(), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output,
  ];
  return { args, summary: `Muted ${formatTime(range.start)}–${formatTime(range.end)}` };
}

function buildCrop(
  input: string,
  output: string,
  media: MediaInfo,
  crop: Extract<DirectEdit, { action: "crop" }>,
) {
  if (![crop.width, crop.height, crop.x ?? 0, crop.y ?? 0].every(Number.isFinite)) {
    throw new Error("Crop dimensions and coordinates must be finite numbers");
  }
  const width = even(crop.width);
  const height = even(crop.height);
  if (width < 2 || height < 2 || width > media.width || height > media.height) {
    throw new Error(`Crop must fit inside ${media.width}x${media.height}`);
  }
  const cropX = crop.x === undefined ? undefined : Math.max(0, Math.floor(crop.x));
  const cropY = crop.y === undefined ? undefined : Math.max(0, Math.floor(crop.y));
  if (cropX !== undefined && cropX + width > media.width) throw new Error(`Crop exceeds the ${media.width}px video width`);
  if (cropY !== undefined && cropY + height > media.height) throw new Error(`Crop exceeds the ${media.height}px video height`);
  const x = cropX === undefined ? `(in_w-${width})/2` : String(cropX);
  const y = cropY === undefined ? `(in_h-${height})/2` : String(cropY);
  const args = [
    "-y", "-v", "error", "-i", input,
    "-vf", `crop=${width}:${height}:${x}:${y}`,
    "-map", "0:v:0", ...(media.hasAudio ? ["-map", "0:a:0"] : []),
    ...videoEncoding(), ...(media.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
    "-movflags", "+faststart", output,
  ];
  return { args, summary: `Cropped to ${width}x${height}` };
}

function concatFilter(segments: Array<TimeRange & { factor: number }>, hasAudio: boolean) {
  const parts: string[] = [];
  const inputs: string[] = [];
  segments.forEach((segment, index) => {
    const start = fixed(segment.start);
    const end = fixed(segment.end);
    parts.push(`[0:v:0]trim=start=${start}:end=${end},setpts=(PTS-STARTPTS)/${fixed(segment.factor)}[v${index}]`);
    inputs.push(`[v${index}]`);
    if (hasAudio) {
      const tempo = segment.factor === 1 ? "" : `,${atempoChain(segment.factor)}`;
      parts.push(`[0:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS${tempo}[a${index}]`);
      inputs.push(`[a${index}]`);
    }
  });
  if (segments.length === 1) {
    return { graph: parts.join(";"), video: "[v0]", audio: hasAudio ? "[a0]" : null };
  }
  parts.push(`${inputs.join("")}concat=n=${segments.length}:v=1:a=${hasAudio ? 1 : 0}[vout]${hasAudio ? "[aout]" : ""}`);
  return { graph: parts.join(";"), video: "[vout]", audio: hasAudio ? "[aout]" : null };
}

function encodeArgs(input: string, output: string, hasAudio: boolean, graph: string, video: string, audio: string | null): string[] {
  return [
    "-y", "-v", "error", "-i", input,
    "-filter_complex", graph,
    "-map", video, ...(hasAudio && audio ? ["-map", audio] : []),
    ...videoEncoding(), ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
    "-movflags", "+faststart", output,
  ];
}

function videoEncoding(): string[] {
  return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"];
}

function atempoChain(factor: number): string {
  const filters: string[] = [];
  let remaining = factor;
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  filters.push(`atempo=${fixed(remaining)}`);
  return filters.join(",");
}

function fixed(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function even(value: number): number {
  const rounded = Math.floor(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function assertFiniteRange(range: TimeRange): void {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) {
    throw new Error("Time range values must be finite numbers");
  }
}

function normalizeRemovalRanges(ranges: TimeRange[], duration: number): TimeRange[] {
  const normalized = ranges
    .map((range) => {
      assertFiniteRange(range);
      return normalizeRange(range.start, range.end, duration);
    })
    .filter((range) => range.end - range.start >= 0.01)
    .sort((left, right) => left.start - right.start);
  const merged: TimeRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 0.001) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
