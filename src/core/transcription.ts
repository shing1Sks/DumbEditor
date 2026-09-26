import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentWorkspace } from "./agent-workspace.js";
import { probeMedia } from "./media.js";
import { runProcess } from "./process.js";
import { readSettings } from "./settings.js";

interface TranscriptionResponse {
  text?: string;
  language?: string;
  error?: { message?: string };
}

export interface TranscriptionResult {
  path: string;
  transcript: string;
  cueCount: number;
  model: string;
  language?: string;
}

export interface TranscribeVideoOptions {
  filePath: string;
  workspace: AgentWorkspace;
  language?: string;
  context?: string;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
}

const CHUNK_SECONDS = 30;

/** Transcribe a video's audio and create a timed SRT in the isolated agent workspace. */
export async function transcribeVideoToSrt(options: TranscribeVideoOptions): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("Speech transcription needs an OpenAI key. Run dumbeditor setup.");
  const media = await probeMedia(options.filePath);
  if (!media.hasAudio) throw new Error("This video has no audio stream to transcribe.");
  await options.workspace.initialize();
  const settings = await readSettings();
  const model = settings.models.openai.transcription;
  const chunkCount = Math.max(1, Math.ceil(media.duration / CHUNK_SECONDS));
  const temporary = await mkdtemp(join(options.workspace.root, "transcribe-"));
  const cues: Cue[] = [];
  const transcriptParts: string[] = [];
  let detectedLanguage: string | undefined;

  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const start = index * CHUNK_SECONDS;
      const duration = Math.min(CHUNK_SECONDS, media.duration - start);
      const audioPath = join(temporary, `chunk-${String(index + 1).padStart(4, "0")}.mp3`);
      options.onStage?.(`Extracting speech ${index + 1}/${chunkCount}`);
      await runProcess("ffmpeg", [
        "-y", "-v", "error", "-ss", start.toFixed(3), "-t", duration.toFixed(3), "-i", options.filePath,
        "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", audioPath,
      ], { timeoutMs: 120_000, maxOutputBytes: 2_000_000, ...(options.signal ? { signal: options.signal } : {}) });

      options.onStage?.(`Transcribing speech ${index + 1}/${chunkCount} with ${model}`);
      const result = await transcribeChunk(audioPath, model, apiKey, options);
      const text = cleanTranscript(result.text ?? "");
      if (!text) continue;
      detectedLanguage ??= result.language;
      transcriptParts.push(text);
      cues.push(...timeCaptions(captionLines(text), start, start + duration));
    }
    if (cues.length === 0) throw new Error("No speech was detected in the video's audio.");
    const relativePath = `subtitles-${Date.now()}.srt`;
    const path = await options.workspace.writeText(relativePath, renderSrt(cues));
    return {
      path,
      transcript: transcriptParts.join("\n\n"),
      cueCount: cues.length,
      model,
      ...(detectedLanguage ? { language: detectedLanguage } : {}),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function transcribeChunk(
  audioPath: string,
  model: string,
  apiKey: string,
  options: TranscribeVideoOptions,
): Promise<TranscriptionResponse> {
  const bytes = await import("node:fs/promises").then(({ readFile }) => readFile(audioPath));
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model", model);
  form.append("response_format", "json");
  if (options.language?.trim()) form.append("language", options.language.trim());
  const prompt = options.context?.trim() || "Transcribe the spoken words accurately with natural punctuation. Do not describe music or sound effects.";
  form.append("prompt", prompt.slice(0, 1_000));
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: options.signal ?? AbortSignal.timeout(120_000),
  });
  const payload = await response.json().catch(() => ({})) as TranscriptionResponse;
  if (!response.ok) throw new Error(`OpenAI transcription failed: ${payload.error?.message ?? `HTTP ${response.status}`}`);
  return payload;
}

interface Cue { start: number; end: number; text: string }

function captionLines(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current: string[] = [];
  for (const word of words) {
    const candidate = [...current, word].join(" ");
    const sentenceEnd = /[.!?][\"')\]]?$/.test(word);
    if (current.length > 0 && (candidate.length > 76 || current.length >= 12)) {
      lines.push(current.join(" "));
      current = [word];
    } else {
      current.push(word);
    }
    if (sentenceEnd && current.length >= 4) {
      lines.push(current.join(" "));
      current = [];
    }
  }
  if (current.length > 0) lines.push(current.join(" "));
  return lines;
}

function timeCaptions(lines: string[], start: number, end: number): Cue[] {
  if (lines.length === 0) return [];
  const weights = lines.map((line) => Math.max(1, line.split(/\s+/).length));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const available = Math.max(0.25, end - start);
  let cursor = start;
  return lines.map((line, index) => {
    const isLast = index === lines.length - 1;
    const duration = available * (weights[index]! / total);
    const cueEnd = isLast ? end : Math.min(end, cursor + duration);
    const cue = { start: cursor, end: Math.max(cursor + 0.1, cueEnd), text: wrapCaption(line) };
    cursor = cueEnd;
    return cue;
  });
}

function wrapCaption(value: string): string {
  if (value.length <= 42) return value;
  const midpoint = Math.floor(value.length / 2);
  const before = value.lastIndexOf(" ", midpoint);
  const after = value.indexOf(" ", midpoint);
  const split = before > 20 ? before : after > 0 ? after : midpoint;
  return `${value.slice(0, split).trim()}\n${value.slice(split).trim()}`;
}

function renderSrt(cues: Cue[]): string {
  return `${cues.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join("\n")}\n`;
}

function srtTime(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(millis, 3)}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function cleanTranscript(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
