import { matchesKey } from "@earendil-works/pi-tui";
import { isFocusReport } from "./keys.js";

/** What a global key press means. The app turns each intent into a state change or an engine call. */
export type Intent =
  | { type: "interrupt" }
  | { type: "ignore" }
  | { type: "toggle-chat-focus" }
  | { type: "collapse-chat" }
  | { type: "abort-agent" }
  | { type: "clear-composer" }
  | { type: "scroll-chat"; rows: number }
  | { type: "scroll-chat-page"; direction: 1 | -1 }
  | { type: "seek"; seconds: number }
  | { type: "toggle-play" }
  | { type: "toggle-permissions" }
  | { type: "volume"; delta: number }
  | { type: "mark-in" }
  | { type: "mark-out" }
  | { type: "open-assets" };

export interface KeyContext {
  overlayOpen: boolean;
  composerEmpty: boolean;
  agentRunning: boolean;
  /** An export or render is running; typing is blocked but the agent is not. */
  busy: boolean;
  videoMutationActive: boolean;
  chatExpanded: boolean;
  hasMedia: boolean;
}

const SEEK_SECONDS = 5;
const VOLUME_STEP = 5;

/**
 * Decide what a key means before the focused component sees it. Returns null when the key is not global,
 * so the composer or the open panel handles it as text or navigation.
 */
export function resolveKey(data: string, context: KeyContext): Intent | null {
  if (isFocusReport(data)) return { type: "ignore" };
  if (matchesKey(data, "ctrl+c")) return { type: "interrupt" };
  if (context.overlayOpen) return null;
  if (matchesKey(data, "ctrl+g")) return { type: "toggle-chat-focus" };
  if (matchesKey(data, "escape")) {
    if (context.chatExpanded) return { type: "collapse-chat" };
    if (context.agentRunning && context.composerEmpty) return { type: "abort-agent" };
    return context.composerEmpty ? null : { type: "clear-composer" };
  }
  if (matchesKey(data, "pageUp")) return { type: "scroll-chat-page", direction: 1 };
  if (matchesKey(data, "pageDown")) return { type: "scroll-chat-page", direction: -1 };
  // Ctrl+arrows seek even with text in the message box, where the plain arrows move the cursor.
  const jump = matchesKey(data, "ctrl+left") ? -SEEK_SECONDS : matchesKey(data, "ctrl+right") ? SEEK_SECONDS : 0;
  if (jump !== 0 && !(context.busy && context.videoMutationActive)) return { type: "seek", seconds: jump };
  if (matchesKey(data, "shift+tab")) return { type: "toggle-permissions" };
  if (context.busy) return busyIntent(data, context);
  if (matchesKey(data, "ctrl+o")) return { type: "open-assets" };
  if (matchesKey(data, "ctrl+p")) return context.hasMedia ? { type: "toggle-play" } : null;
  if (!context.composerEmpty) return null;
  if (matchesKey(data, "left")) return { type: "seek", seconds: -SEEK_SECONDS };
  if (matchesKey(data, "right")) return { type: "seek", seconds: SEEK_SECONDS };
  if (matchesKey(data, "up")) return { type: "scroll-chat", rows: 1 };
  if (matchesKey(data, "down")) return { type: "scroll-chat", rows: -1 };
  if (data === "+" || data === "=") return { type: "volume", delta: VOLUME_STEP };
  if (data === "-") return { type: "volume", delta: -VOLUME_STEP };
  if (data === "[") return { type: "mark-in" };
  if (data === "]") return { type: "mark-out" };
  return null;
}

function busyIntent(data: string, context: KeyContext): Intent {
  if (matchesKey(data, "up")) return { type: "scroll-chat", rows: 1 };
  if (matchesKey(data, "down")) return { type: "scroll-chat", rows: -1 };
  if (data === "+" || data === "=") return { type: "volume", delta: VOLUME_STEP };
  if (data === "-") return { type: "volume", delta: -VOLUME_STEP };
  if (!context.videoMutationActive) {
    if (matchesKey(data, "left")) return { type: "seek", seconds: -SEEK_SECONDS };
    if (matchesKey(data, "right")) return { type: "seek", seconds: SEEK_SECONDS };
    if (matchesKey(data, "ctrl+p")) return { type: "toggle-play" };
  }
  return { type: "ignore" };
}
