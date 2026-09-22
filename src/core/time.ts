import type { Selection, TimeRange } from "../types.js";

const TIME_TOKEN = String.raw`(?:the\s+)?(?:start|beginning|end|current|playhead)|\d+(?::\d+){1,2}(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?)?`;

export function parseTimestamp(token: string, duration: number, currentTime = 0): number | null {
  const value = token.trim().toLowerCase().replace(/^the\s+/, "");
  if (value === "start" || value === "beginning") return 0;
  if (value === "end") return duration;
  if (value === "current" || value === "playhead") return currentTime;

  const unitMatch = value.match(/^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?)$/);
  if (unitMatch) {
    const amount = Number(unitMatch[1]);
    const unit = unitMatch[2] ?? "s";
    if (unit.startsWith("m") && unit !== "ms" && !unit.startsWith("milli")) return amount * 60;
    if (unit === "ms" || unit.startsWith("milli")) return amount / 1000;
    return amount;
  }

  if (/^\d+(?::\d+){1,2}(?:\.\d+)?$/.test(value)) {
    const parts = value.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return null;
    if ((parts.at(-1) ?? 60) >= 60) return null;
    if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
    if ((parts[1] ?? 60) >= 60) return null;
    return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  }

  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return null;
}

export function extractRanges(
  input: string,
  duration: number,
  currentTime = 0,
  selection?: Selection,
): TimeRange[] {
  const ranges: TimeRange[] = [];
  const patterns = [
    new RegExp(`\\bfrom\\s+(${TIME_TOKEN})\\s+(?:to|until|till|through)\\s+(${TIME_TOKEN})(?=\\s*(?:[,.!?;]|\\band\\b|$))`, "gi"),
    new RegExp(`\\bbetween\\s+(${TIME_TOKEN})\\s+and\\s+(${TIME_TOKEN})(?=\\s*(?:[,.!?;]|$))`, "gi"),
  ];

  for (const pattern of patterns) {
    for (const match of input.matchAll(pattern)) {
      const start = parseTimestamp(match[1] ?? "", duration, currentTime);
      const end = parseTimestamp(match[2] ?? "", duration, currentTime);
      if (start !== null && end !== null) ranges.push(normalizeRange(start, end, duration));
    }
  }

  if (ranges.length === 0 && /\b(this|selected|marked)\s+(section|range|part)\b/i.test(input)) {
    if (selection?.in !== null && selection?.in !== undefined && selection.out !== null && selection.out !== undefined) {
      ranges.push(normalizeRange(selection.in, selection.out, duration));
    }
  }

  return mergeRanges(ranges.filter((range) => range.end - range.start >= 0.01));
}

export function parseSpeedFactor(input: string): number {
  const explicit = input.match(/(?:at\s+)?(\d+(?:\.\d+)?)\s*x\b/i);
  if (explicit) return clamp(Number(explicit[1]), 0.25, 16);
  const percent = input.match(/(?:by|to)\s+(\d+(?:\.\d+)?)\s*%/i);
  if (percent) return clamp(Number(percent[1]) / 100, 0.25, 16);
  if (/slow/i.test(input)) return 0.5;
  return 2;
}

export function parseCrop(input: string): { width: number; height: number; x?: number; y?: number } | null {
  const size = input.match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/i);
  if (!size) return null;
  const position = input.match(/(?:at|from)\s+(\d{1,5})\s*[,x:]\s*(\d{1,5})/i);
  const crop: { width: number; height: number; x?: number; y?: number } = {
    width: Number(size[1]),
    height: Number(size[2]),
  };
  if (position) {
    crop.x = Number(position[1]);
    crop.y = Number(position[2]);
  }
  return crop;
}

export function formatTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const millis = Math.floor((safe % 1) * 10);
  return `${hours > 0 ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${millis}`;
}

export function normalizeRange(start: number, end: number, duration: number): TimeRange {
  const first = clamp(Math.min(start, end), 0, duration);
  const second = clamp(Math.max(start, end), 0, duration);
  return { start: first, end: second };
}

function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 0.001) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
