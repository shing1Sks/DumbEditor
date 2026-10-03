import { runProcess } from "./process.js";

export interface FfmpegCapabilities {
  /** The FFmpeg version string ("7.1.1"), or null when it could not be read. */
  version: string | null;
  filters: ReadonlySet<string>;
  encoders: ReadonlySet<string>;
}

export type RunCommand = (command: string, args: string[]) => Promise<string>;

const defaultRun: RunCommand = async (command, args) => {
  const result = await runProcess(command, args, { timeoutMs: 15_000, maxOutputBytes: 2_000_000 });
  return result.stdout.toString("utf8");
};

/**
 * Filter names from `ffmpeg -filters`. Older builds print three flag columns (" T.C adelay"), newer ones two
 * (" TS aap"). The legend lines ("T.. = Timeline support") do not match, because "=" is not a name.
 */
export function parseFilters(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[TSC.]{2,3}\s+([A-Za-z0-9_]+)(?:\s|$)/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

/** Encoder names from `ffmpeg -encoders`. The legend lines ("V..... = Video") do not match. */
export function parseEncoders(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[VAS][.FSXBD]{5}\s+([A-Za-z0-9_-]+)(?:\s|$)/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

export function parseVersion(text: string): string | null {
  return /^ffmpeg version (\S+)/m.exec(text)?.[1] ?? null;
}

/** Ask FFmpeg what it can do. Null when FFmpeg cannot be run at all. */
export async function loadCapabilities(run: RunCommand = defaultRun): Promise<FfmpegCapabilities | null> {
  try {
    const [version, filters, encoders] = await Promise.all([
      run("ffmpeg", ["-version"]),
      run("ffmpeg", ["-hide_banner", "-filters"]),
      run("ffmpeg", ["-hide_banner", "-encoders"]),
    ]);
    return { version: parseVersion(version), filters: parseFilters(filters), encoders: parseEncoders(encoders) };
  } catch {
    return null;
  }
}

let cached: FfmpegCapabilities | null = null;

/** Asked until it works, then remembered for the process. A failed probe (a timeout, say) is not remembered. */
export async function ffmpegCapabilities(): Promise<FfmpegCapabilities | null> {
  if (cached) return cached;
  const caps = await loadCapabilities();
  if (caps) cached = caps;
  return caps;
}

export function resetFfmpegCapabilities(): void {
  cached = null;
}

export type TextRenderer = "libass" | "images";

/**
 * How text and captions are drawn: through libass (the `ass` filter) when this FFmpeg has it, otherwise as images.
 * When FFmpeg cannot be asked the answer is libass, which is what the editor always did. DUMBEDITOR_TEXT_RENDERER
 * forces a path (used by tests).
 */
export function chooseTextRenderer(caps: FfmpegCapabilities | null, environment: NodeJS.ProcessEnv = process.env): TextRenderer {
  const forced = environment.DUMBEDITOR_TEXT_RENDERER?.trim().toLowerCase();
  if (forced === "images" || forced === "libass") return forced;
  if (!caps) return "libass";
  return caps.filters.has("ass") ? "libass" : "images";
}
