import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** Where Homebrew puts the keg-only `ffmpeg-full` (it is not linked into PATH, so installing it alone changes nothing). */
const HOMEBREW_KEGS = ["/opt/homebrew/opt/ffmpeg-full/bin", "/usr/local/opt/ffmpeg-full/bin"];
const FFMPEG_TOOLS = new Set(["ffmpeg", "ffprobe", "ffplay"]);

export interface BinaryContext {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  exists(path: string): boolean;
}

const real = (): BinaryContext => ({ env: process.env, platform: process.platform, exists: existsSync });

/**
 * The folder that holds ffmpeg, ffprobe and ffplay: DUMBEDITOR_FFMPEG_DIR when set; on macOS otherwise Homebrew's
 * `ffmpeg-full` when it is installed (it has libass); else null, meaning "whatever is on PATH".
 */
export function ffmpegDirectory(context: BinaryContext = real()): string | null {
  const configured = context.env.DUMBEDITOR_FFMPEG_DIR?.trim();
  if (configured) return resolve(configured);
  if (context.platform === "darwin") return HOMEBREW_KEGS.find((directory) => context.exists(join(directory, "ffmpeg"))) ?? null;
  return null;
}

/**
 * The command to run for a program. The FFmpeg tools come from the chosen folder when it has them; everything else,
 * and a folder without the tool, falls back to the bare name so PATH decides, exactly as before.
 */
export function resolveBinary(name: string, context: BinaryContext = real()): string {
  if (!FFMPEG_TOOLS.has(name)) return name;
  const directory = ffmpegDirectory(context);
  if (!directory) return name;
  const file = join(directory, context.platform === "win32" ? `${name}.exe` : name);
  return context.exists(file) ? file : name;
}

/** A sentence when DUMBEDITOR_FFMPEG_DIR is set but does not hold ffmpeg, otherwise null (for `dumbeditor doctor`). */
export function ffmpegDirectoryProblem(context: BinaryContext = real()): string | null {
  const configured = context.env.DUMBEDITOR_FFMPEG_DIR?.trim();
  if (!configured) return null;
  const file = join(resolve(configured), context.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  return context.exists(file) ? null : `DUMBEDITOR_FFMPEG_DIR is ${configured}, but there is no ${file}`;
}
