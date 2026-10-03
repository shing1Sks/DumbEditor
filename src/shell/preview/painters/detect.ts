import { detectPreviewBackend } from "../../../core/media.js";
import { explainBackend } from "./index.js";
import type { PainterId } from "./types.js";
import type { ProbeResult } from "./probe.js";

export interface DetectOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Whether stdin and stdout are both a terminal: asking is pointless (and wrong) otherwise. */
  isTTY: boolean;
  /** Asks the terminal. Absent means "do not ask". */
  probe?: () => Promise<ProbeResult | null>;
}

export interface Detected {
  id: PainterId;
  /** In words a user can act on, for `dumbeditor doctor`. */
  reason: string;
  /** What the terminal said, when it was asked. */
  probed: ProbeResult | null;
}

function kittyHint(env: NodeJS.ProcessEnv): boolean {
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  return Boolean(env.KITTY_WINDOW_ID) || /^xterm-(kitty|ghostty)$/.test(env.TERM ?? "") || program === "ghostty" || program === "wezterm";
}

/**
 * Pick the painter: an explicit setting, else (outside Windows) ask the terminal, else what the environment says.
 * Windows never asks and keeps its rule exactly. Terminal.app prints the end of sequences it does not know, and tmux
 * or screen filter image sequences, so none of those are asked either.
 */
export async function detectPainter(options: DetectOptions): Promise<Detected> {
  const { env, platform } = options;
  const multiplexer = Boolean(env.TMUX) || Boolean(env.ZELLIJ) || /^(tmux|screen)/.test(env.TERM ?? "");
  const appleTerminal = env.TERM_PROGRAM === "Apple_Terminal";
  const mayAsk = platform !== "win32" && options.isTTY && !multiplexer && !appleTerminal && options.probe !== undefined;

  const override = env.DUMBEDITOR_PREVIEW?.trim().toLowerCase();
  if (override === "blocks" || override === "sixel" || override === "kitty") {
    // The choice is made, but a picture still needs the terminal's cell size, so ask for that.
    const probed = override !== "blocks" && mayAsk ? await options.probe!() : null;
    return { id: override, reason: `set by DUMBEDITOR_PREVIEW=${override}`, probed };
  }
  const fallback = (): Detected => ({ id: detectPreviewBackend(env), reason: explainBackend(env), probed: null });
  if (!mayAsk) return fallback();

  const probed = await options.probe!();
  if (probed?.kitty) return { id: "kitty", reason: `Kitty graphics (answered by ${probed.name ?? "the terminal"})`, probed };
  if (probed?.sixel) return { id: "sixel", reason: `Sixel (reported by ${probed.name ?? "the terminal"})`, probed };
  if (!probed && kittyHint(env)) return { id: "kitty", reason: "Kitty graphics (the terminal did not answer in time, but the environment says it has them)", probed: null };
  return { ...fallback(), probed };
}
