import { copyFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { MediaInfo, TimeRange, VersionEntry } from "../types.js";
import { probeMedia } from "./media.js";
import { runProcess } from "./process.js";
import { ProjectStore } from "./project.js";
import { formatTime } from "./time.js";

export type TextPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type VisualEffect = "grayscale" | "sepia" | "blur" | "sharpen" | "vignette";

export type AdvancedEdit =
  | {
      action: "text";
      text: string;
      range: TimeRange;
      position?: TextPosition;
      fontSize?: number;
      color?: string;
    }
  | { action: "subtitles"; filePath: string }
  | {
      action: "image-overlay";
      filePath: string;
      range: TimeRange;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      opacity?: number;
    }
  | { action: "effect"; effect: VisualEffect; range: TimeRange; intensity?: number }
  | { action: "fade"; direction: "in" | "out"; range: TimeRange; color?: string; audio?: boolean }
  | {
      action: "background-music";
      filePath: string;
      volume?: number;
      loop?: boolean;
      trim?: TimeRange;
      startAt?: number;
    };

export interface AdvancedEditResult {
  version: VersionEntry;
  media: MediaInfo;
}

interface RenderPlan {
  extraInputs: string[];
  graph: string;
  video: string;
  audio: "source" | string | null;
  summary: string;
}

/** Render one advanced local edit and add it to the project's immutable history. */
export async function executeAdvancedEdit(
  store: ProjectStore,
  edit: AdvancedEdit,
  request: string,
  onStage?: (stage: string) => void,
): Promise<AdvancedEditResult> {
  const input = store.current.filePath;
  const media = await probeMedia(input);
  const output = store.nextOutputPath(".mp4");
  const workspace = await mkdtemp(join(store.snapshot.projectDir, "advanced-"));
  let committed = false;

  try {
    onStage?.("Preparing advanced edit");
    const plan = await prepareEdit(edit, media, workspace);
    const args = renderArgs(input, output, media, plan);
    onStage?.("Rendering with FFmpeg");
    await runProcess("ffmpeg", args, {
      cwd: workspace,
      timeoutMs: 30 * 60_000,
      maxOutputBytes: 8_000_000,
    });
    onStage?.("Checking rendered video");
    const outputMedia = await probeMedia(output);
    onStage?.("Saving new version");
    const version = await store.commit({
      outputPath: output,
      action: plan.summary,
      request,
      duration: outputMedia.duration,
    });
    committed = true;
    return { version, media: outputMedia };
  } catch (error) {
    if (!committed) await rm(output, { force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Advanced edit failed: ${message}`, { cause: error });
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function prepareEdit(edit: AdvancedEdit, media: MediaInfo, workspace: string): Promise<RenderPlan> {
  if (edit.action === "text") return prepareText(edit, media, workspace);
  if (edit.action === "subtitles") return prepareSubtitles(edit, media, workspace);
  if (edit.action === "image-overlay") return prepareImageOverlay(edit, media);
  if (edit.action === "effect") return prepareEffect(edit, media);
  if (edit.action === "fade") return prepareFade(edit, media);
  return prepareBackgroundMusic(edit, media, workspace);
}

async function prepareText(
  edit: Extract<AdvancedEdit, { action: "text" }>,
  media: MediaInfo,
  workspace: string,
): Promise<RenderPlan> {
  const range = validRange(edit.range, media.duration, "Text overlay");
  const text = edit.text.trim();
  if (!text) throw new Error("Text overlay cannot be empty");
  if (Buffer.byteLength(text, "utf8") > 20_000) throw new Error("Text overlay is too long");
  const fontSize = edit.fontSize ?? Math.max(16, Math.round(media.height / 14));
  if (!Number.isInteger(fontSize) || fontSize < 6 || fontSize > 500) {
    throw new Error("Text font size must be a whole number from 6 to 500");
  }
  const color = assColor(edit.color ?? "#ffffff");
  const position = edit.position ?? "bottom-center";
  const alignment = ASS_ALIGNMENT[position];
  const subtitleName = "text-overlay.ass";
  const subtitle = buildAssDocument({
    width: media.width,
    height: media.height,
    fontSize,
    color,
    alignment,
    start: range.start,
    end: range.end,
    text,
  });
  await writeFile(join(workspace, subtitleName), subtitle, "utf8");
  return {
    extraInputs: [],
    graph: `[0:v:0]ass=${subtitleName}[vout]`,
    video: "[vout]",
    audio: media.hasAudio ? "source" : null,
    summary: `Added text at ${formatRange(range)}`,
  };
}

async function prepareSubtitles(
  edit: Extract<AdvancedEdit, { action: "subtitles" }>,
  media: MediaInfo,
  workspace: string,
): Promise<RenderPlan> {
  const input = await localFile(edit.filePath, "Subtitle");
  const extension = extname(input).toLowerCase();
  if (!new Set([".srt", ".ass", ".ssa", ".vtt"]).has(extension)) {
    throw new Error("Subtitle file must use .srt, .ass, .ssa, or .vtt");
  }
  const subtitleName = `subtitles${extension}`;
  await copyFile(input, join(workspace, subtitleName));
  return {
    extraInputs: [],
    graph: `[0:v:0]subtitles=${subtitleName}[vout]`,
    video: "[vout]",
    audio: media.hasAudio ? "source" : null,
    summary: "Burned in subtitles",
  };
}

async function prepareImageOverlay(
  edit: Extract<AdvancedEdit, { action: "image-overlay" }>,
  media: MediaInfo,
): Promise<RenderPlan> {
  const image = await localFile(edit.filePath, "Overlay image");
  await probeImage(image);
  const range = validRange(edit.range, media.duration, "Image overlay");
  const x = nonNegativeInteger(edit.x ?? 0, "Image x coordinate");
  const y = nonNegativeInteger(edit.y ?? 0, "Image y coordinate");
  const width = optionalPositiveInteger(edit.width, "Image width");
  const height = optionalPositiveInteger(edit.height, "Image height");
  const opacity = edit.opacity ?? 1;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error("Image opacity must be from 0 to 1");

  const filters: string[] = [];
  if (width !== undefined || height !== undefined) filters.push(`scale=${width ?? -1}:${height ?? -1}`);
  filters.push("format=rgba");
  if (opacity !== 1) filters.push(`colorchannelmixer=aa=${fixed(opacity)}`);
  return {
    extraInputs: ["-loop", "1", "-i", image],
    graph: `[1:v:0]${filters.join(",")}[overlay_asset];[0:v:0][overlay_asset]overlay=${x}:${y}:enable='between(t,${fixed(range.start)},${fixed(range.end)})':eof_action=pass[vout]`,
    video: "[vout]",
    audio: media.hasAudio ? "source" : null,
    summary: `Added image at ${formatRange(range)}`,
  };
}

function prepareEffect(edit: Extract<AdvancedEdit, { action: "effect" }>, media: MediaInfo): RenderPlan {
  const range = validRange(edit.range, media.duration, "Visual effect");
  const intensity = edit.intensity ?? 0.5;
  if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
    throw new Error("Effect intensity must be from 0 to 1");
  }
  const enable = `enable='between(t,${fixed(range.start)},${fixed(range.end)})'`;
  const filter = effectFilter(edit.effect, intensity, enable);
  return {
    extraInputs: [],
    graph: `[0:v:0]${filter}[vout]`,
    video: "[vout]",
    audio: media.hasAudio ? "source" : null,
    summary: `Applied ${edit.effect} at ${formatRange(range)}`,
  };
}

function prepareFade(edit: Extract<AdvancedEdit, { action: "fade" }>, media: MediaInfo): RenderPlan {
  const range = validRange(edit.range, media.duration, "Fade");
  const color = ffmpegColor(edit.color ?? "black");
  const duration = range.end - range.start;
  const parts = [
    `[0:v:0]fade=t=${edit.direction}:st=${fixed(range.start)}:d=${fixed(duration)}:color=${color}[vout]`,
  ];
  const fadeAudio = (edit.audio ?? true) && media.hasAudio;
  if (fadeAudio) {
    parts.push(`[0:a:0]afade=t=${edit.direction}:st=${fixed(range.start)}:d=${fixed(duration)}[aout]`);
  }
  return {
    extraInputs: [],
    graph: parts.join(";"),
    video: "[vout]",
    audio: fadeAudio ? "[aout]" : media.hasAudio ? "source" : null,
    summary: `${edit.direction === "in" ? "Faded in" : "Faded out"} over ${formatRange(range)}`,
  };
}

async function prepareBackgroundMusic(
  edit: Extract<AdvancedEdit, { action: "background-music" }>,
  media: MediaInfo,
  workspace: string,
): Promise<RenderPlan> {
  const music = await localFile(edit.filePath, "Music");
  const musicDuration = await probeAudioDuration(music);
  const trim = edit.trim === undefined
    ? { start: 0, end: musicDuration }
    : validRange(edit.trim, musicDuration, "Music trim");
  const volume = edit.volume ?? 0.25;
  if (!Number.isFinite(volume) || volume < 0 || volume > 2) throw new Error("Music volume must be from 0 to 2");
  const startAt = edit.startAt ?? 0;
  if (!Number.isFinite(startAt) || startAt < 0 || startAt >= media.duration) {
    throw new Error("Music start time must be inside the video");
  }

  const preparedName = "background.wav";
  await runProcess("ffmpeg", [
    "-y", "-v", "error", "-i", music,
    "-ss", fixed(trim.start), "-t", fixed(trim.end - trim.start),
    "-map", "0:a:0", "-vn", "-c:a", "pcm_s16le", preparedName,
  ], { cwd: workspace, timeoutMs: 10 * 60_000, maxOutputBytes: 4_000_000 });

  const delay = Math.round(startAt * 1000);
  const musicFilters = [`volume=${fixed(volume)}`];
  if (delay > 0) musicFilters.push(`adelay=${delay}:all=1`);
  const parts = [`[1:a:0]${musicFilters.join(",")}[background]`];
  if (media.hasAudio) {
    parts.push("[0:a:0][background]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]");
  } else {
    parts.push(`[background]apad,atrim=duration=${fixed(media.duration)}[aout]`);
  }
  return {
    extraInputs: [...(edit.loop ? ["-stream_loop", "-1"] : []), "-i", preparedName],
    graph: parts.join(";"),
    video: "0:v:0",
    audio: "[aout]",
    summary: `Mixed background music${edit.loop ? " (looped)" : ""}`,
  };
}

function renderArgs(input: string, output: string, media: MediaInfo, plan: RenderPlan): string[] {
  const audioMap = plan.audio === "source" ? "0:a:0" : plan.audio;
  return [
    "-y", "-v", "error", "-i", input,
    ...plan.extraInputs,
    "-filter_complex", plan.graph,
    "-map", plan.video,
    ...(audioMap ? ["-map", audioMap] : []),
    "-t", fixed(media.duration),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    ...(audioMap ? ["-c:a", "aac", "-b:a", "192k"] : []),
    "-movflags", "+faststart", output,
  ];
}

function effectFilter(effect: VisualEffect, intensity: number, enable: string): string {
  if (effect === "grayscale") return `hue=s=0:${enable}`;
  if (effect === "sepia") {
    return `colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131:${enable}`;
  }
  if (effect === "blur") return `boxblur=luma_radius=${fixed(1 + intensity * 9)}:luma_power=1:${enable}`;
  if (effect === "sharpen") return `unsharp=5:5:${fixed(0.1 + intensity * 1.4)}:5:5:0:${enable}`;
  return `vignette=angle=${fixed(Math.PI / (3 + intensity * 3))}:${enable}`;
}

function validRange(range: TimeRange, duration: number, label: string): TimeRange {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) throw new Error(`${label} times must be finite numbers`);
  if (range.start < 0 || range.end > duration + 0.001) throw new Error(`${label} must stay inside the media duration`);
  if (range.end - range.start < 0.01) throw new Error(`${label} range is empty`);
  return { start: range.start, end: Math.min(range.end, duration) };
}

async function localFile(filePath: string, label: string): Promise<string> {
  if (!filePath.trim() || /^https?:\/\//i.test(filePath)) throw new Error(`${label} must be a local file path`);
  const path = resolve(filePath);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`${label} file was not found: ${path}`);
  }
  if (!info.isFile()) throw new Error(`${label} path is not a file: ${path}`);
  return path;
}

async function probeAudioDuration(filePath: string): Promise<number> {
  const result = await runProcess("ffprobe", [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type:format=duration", "-of", "json", filePath,
  ], { timeoutMs: 20_000, maxOutputBytes: 1_000_000 });
  const payload = JSON.parse(result.stdout.toString("utf8")) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string }>;
  };
  if (!payload.streams?.some((stream) => stream.codec_type === "audio")) throw new Error("Music file has no audio stream");
  const duration = Number(payload.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not determine music duration");
  return duration;
}

async function probeImage(filePath: string): Promise<void> {
  const result = await runProcess("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type,width,height", "-of", "json", filePath,
  ], { timeoutMs: 20_000, maxOutputBytes: 1_000_000 });
  const payload = JSON.parse(result.stdout.toString("utf8")) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const stream = payload.streams?.find((item) => item.codec_type === "video");
  if (!stream?.width || !stream.height) throw new Error("Overlay image has no readable image stream");
}

function buildAssDocument(options: {
  width: number;
  height: number;
  fontSize: number;
  color: string;
  alignment: number;
  start: number;
  end: number;
  text: string;
}): string {
  const text = options.text
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${options.width}`,
    `PlayResY: ${options.height}`,
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: Default,Arial,${options.fontSize},${options.color},&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,${options.alignment},20,20,20,1`,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 0,${assTime(options.start)},${assTime(options.end)},Default,,0,0,0,,${text}`,
    "",
  ].join("\n");
}

function assTime(seconds: number): string {
  const centiseconds = Math.round(seconds * 100);
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const remainder = centiseconds % 6_000;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(Math.floor(remainder / 100)).padStart(2, "0")}.${String(remainder % 100).padStart(2, "0")}`;
}

function assColor(color: string): string {
  const match = color.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) throw new Error("Text color must be a six digit hex color");
  return `&H00${match[3]}${match[2]}${match[1]}`.toUpperCase();
}

function ffmpegColor(color: string): string {
  if (/^[a-z]+$/i.test(color)) return color.toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(color)) return `0x${color.slice(1)}`;
  throw new Error("Fade color must be a color name or six digit hex color");
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative whole number`);
  return value;
}

function optionalPositiveInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive whole number`);
  return value;
}

function formatRange(range: TimeRange): string {
  return `${formatTime(range.start)}–${formatTime(range.end)}`;
}

function fixed(value: number): string {
  return Number(value.toFixed(6)).toString();
}

const ASS_ALIGNMENT: Record<TextPosition, number> = {
  "top-left": 7,
  "top-center": 8,
  "top-right": 9,
  center: 5,
  "bottom-left": 1,
  "bottom-center": 2,
  "bottom-right": 3,
};
