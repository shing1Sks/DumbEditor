import { parseEditCommand } from "../core/commands.js";
import type { Engine } from "../core/engine/engine.js";
import type { ProjectStore } from "../core/project.js";
import type { DumbEditorSettings } from "../core/settings.js";
import type { EditorState } from "../core/state/editor-state.js";
import { formatTime } from "../core/time.js";
import { formatUsd } from "../core/usage.js";
import type { DirectEdit } from "../types.js";
import type { ShellState } from "./state/shell-state.js";

/** What a slash command needs from the application. */
export interface CommandApp {
  readonly state: ShellState;
  readonly project: ProjectStore | null;
  readonly editor: EditorState | null;
  readonly engine: Engine | null;
  readonly settings: DumbEditorSettings;
  answer(text: string): Promise<void>;
  quit(): void;
  openVideo(path: string): Promise<void>;
  openProjects(): Promise<void>;
  openModelPicker(): void;
  openModePicker(): void;
  openMusic(query: string): Promise<void>;
  openAssets(): void;
  openExport(requested: string): void;
  openHistory(showAll: boolean): void;
  applyEdit(edit: DirectEdit, request: string): Promise<void>;
  changeVersion(reference: string): Promise<void>;
  setPermissionMode(mode: "ask" | "auto"): Promise<void>;
  togglePermissionMode(): Promise<"ask" | "auto">;
  setSpendCeiling(usd: number): Promise<void>;
  setVersionLimit(limit: number): Promise<void>;
  compact(): Promise<void>;
}

/** Commands that cannot disturb a running agent; everything else waits until it finishes or is stopped. */
const SAFE_DURING_RUN = new Set(["/help", "/chat", "/status", "/clear", "/play", "/pause", "/quit", "/exit", "/mode", "/permissions", "/budget", "/version", "/versions", "/assets"]);

export async function runCommand(app: CommandApp, line: string): Promise<void> {
  const { state } = app;
  const space = line.indexOf(" ");
  const command = (space === -1 ? line : line.slice(0, space)).toLowerCase();
  const argument = unquote(space === -1 ? "" : line.slice(space + 1).trim());
  if (state.agentRunning && !SAFE_DURING_RUN.has(command)) { await app.answer("The agent is working. Wait for it to finish, or press Esc to stop it."); return; }

  if (command === "/quit" || command === "/exit") { app.quit(); return; }
  if (command === "/help") { state.openOverlay("help"); return; }
  if (command === "/clear") { state.clearMessages(); state.closeOverlay(); return; }
  if (command === "/chat") { state.toggleChatExpanded(); return; }
  if (command === "/play") { if (state.media) state.setPlaying(true); return; }
  if (command === "/pause") { state.setPlaying(false); return; }
  if (command === "/open") { if (!argument) { await app.answer("Usage: /open <VIDEO PATH>"); return; } await app.openVideo(argument); return; }
  if (command === "/projects") { await app.openProjects(); return; }
  if (command === "/model") { app.openModelPicker(); return; }
  if (command === "/bg-music") { await app.openMusic(argument); return; }
  if (command === "/mode" || command === "/permissions") {
    if (!argument) { app.openModePicker(); return; }
    if (argument !== "ask" && argument !== "auto") { await app.answer("Usage: /mode  (pick from the list), or /mode ask, /mode auto"); return; }
    await app.setPermissionMode(argument);
    await app.answer(`Agent permission mode set to ${argument}.`);
    return;
  }
  if (command === "/budget") {
    if (!argument) {
      const limit = app.settings.agent.spendCeilingUsd;
      await app.answer(limit > 0
        ? `Each agent run pauses to ask at ${formatUsd(limit)}. Use /budget <USD> to change it, or /budget 0 to turn it off.`
        : "There is no per-run spend limit. Use /budget <USD> to set one.");
      return;
    }
    await app.setSpendCeiling(Number(argument));
    const limit = app.settings.agent.spendCeilingUsd;
    await app.answer(limit > 0 ? `Per-run spend limit set to ${formatUsd(limit)}.` : "Per-run spend limit turned off.");
    return;
  }
  if (command === "/compact") { await app.compact(); return; }

  const { project, state: shell } = app;
  const media = shell.media;
  if (!project || !media) { await app.answer("Open a video first with /open <path>."); return; }
  if (command === "/assets") {
    if (argument) { await app.answer("Usage: /assets"); return; }
    app.openAssets();
    return;
  }

  const direct = parseEditCommand(line, { duration: media.duration, currentTime: shell.playhead, selection: shell.selection });
  if (direct) {
    shell.setPlaying(false);
    try { await app.applyEdit(direct, line); }
    catch (error) { await app.answer(message(error)); shell.setStatus("Edit failed"); }
    finally { shell.setLoader(null); }
    return;
  }
  if (command === "/version" || command === "/versions") {
    if (argument && argument.toLowerCase() !== "all") { await app.answer("Usage: /version [all]"); return; }
    app.openHistory(argument.toLowerCase() === "all");
    return;
  }
  if (command === "/version-limits") {
    if (!argument) { await app.answer(`Keeping up to ${project.versionLimit} rendered edit versions, plus the original source.`); return; }
    const limit = Number(argument);
    await app.setVersionLimit(limit);
    await app.answer(`Version limit set to ${limit}. Older rendered versions were pruned.`);
    return;
  }
  if (command === "/status") { await app.answer(`${project.name} · ${project.current.id} · ${media.width}x${media.height} · ${formatTime(media.duration)} · ${project.snapshot.versions.length} versions · limit ${project.versionLimit}`); return; }
  if (command === "/undo") {
    const parent = project.current.parentId;
    if (!parent) { await app.answer("Already at the original version."); return; }
    await app.changeVersion(parent);
    return;
  }
  if (command === "/revert") { if (!argument) { await app.answer("Usage: /revert <VERSION>"); return; } await app.changeVersion(argument); return; }
  if (command === "/export") { app.openExport(argument); return; }
  await app.answer(`Unknown command ${command}. Type / to see commands.`);
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function unquote(value: string): string {
  const first = value[0];
  return value.length >= 2 && (first === "'" || first === "\"") && value.at(-1) === first ? value.slice(1, -1) : value;
}
