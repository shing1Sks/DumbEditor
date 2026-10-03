export interface Cue { start: number; end: number; text: string }

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function seconds(text: string): number | null {
  const match = TIME.exec(text);
  if (!match) return null;
  const [, hours = "0", minutes = "0", secs = "0", fraction = "0"] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(secs) + Number(fraction.padEnd(3, "0")) / 1000;
}

/** Cues from SRT or WebVTT text: tags and positioning codes are removed, empty or backwards cues dropped, sorted by start. */
export function parseCues(source: string, extension: ".srt" | ".vtt"): Cue[] {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const cues: Cue[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n");
    if (extension === ".vtt" && /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0]?.trim() ?? "")) continue;
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing < 0) continue;
    const [from = "", to = ""] = (lines[timing] as string).split("-->");
    const start = seconds(from);
    const end = seconds(to.trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null || end <= start) continue;
    const body = lines.slice(timing + 1).join("\n")
      .replace(/\{\\[^}]*\}/g, "")
      .replace(/<[^>]*>/g, "")
      .split("\n").map((line) => line.trim()).join("\n").trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}
