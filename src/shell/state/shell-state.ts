import type { AgentAsset } from "../../core/agent-workspace.js";
import type { ChoiceRequest } from "../../core/choice.js";
import type { EngineEvent } from "../../core/engine/events.js";
import { EMPTY_USAGE_SUMMARY, type UsageSummary } from "../../core/usage.js";
import type { ChatMessage, MediaInfo, Selection, VersionEntry } from "../../types.js";
import { isVideoMutationStage } from "../work-state.js";

export type OverlayKind = "help" | "history" | "model" | "music" | "export" | "assets" | "projects" | "approval" | "choice";
export type ApprovalRequest = Extract<EngineEvent, { type: "approval_request" }>;
export type ChoicePrompt = ChoiceRequest & { id: string };

export interface Loader { source: string; stage: string }

/** One line item of the conversation. `label` is a model name, or "tool" / "editor" / "error" for non-chat lines. */
export interface TranscriptMessage {
  id: string;
  role: ChatMessage["role"];
  text: string;
  label?: string;
  live: boolean;
}

/**
 * Everything the screen shows, with no terminal code in it. Views read it, intents change it, and every
 * change notifies subscribers once so the screen can redraw.
 */
export class ShellState {
  projectName: string | null = null;
  versionId = "";
  versions: VersionEntry[] = [];
  versionLimit = 5;
  media: MediaInfo | null = null;
  playhead = 0;
  playing = false;
  volume = 70;
  selection: Selection = { in: null, out: null };
  messages: TranscriptMessage[] = [];
  chatExpanded = false;
  agentRunning = false;
  loader: Loader | null = null;
  status = "Ready";
  usage: UsageSummary = EMPTY_USAGE_SUMMARY;
  assets: AgentAsset[] = [];
  overlay: OverlayKind | null = null;
  approval: ApprovalRequest | null = null;
  choice: ChoicePrompt | null = null;
  agentModel = "editor model";
  permissionMode: "ask" | "auto" = "ask";
  /** Which frame of the busy spinner to show; advanced by a timer while something is working. */
  spinner = 0;

  private readonly listeners = new Set<() => void>();
  private liveId: string | null = null;
  private counter = 0;
  private composerRestore: string | null = null;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Typing is blocked only by non-agent work (an export, a render); text sent to a running agent steers it. */
  get busy(): boolean { return this.loader !== null && !this.agentRunning; }
  get videoMutationActive(): boolean { return this.loader !== null && isVideoMutationStage(this.loader.stage); }

  setProject(name: string | null, versionId: string, versionLimit = this.versionLimit): void {
    this.projectName = name; this.versionId = versionId; this.versionLimit = versionLimit; this.emit();
  }
  setVersions(versions: VersionEntry[], versionId: string): void { this.versions = versions; this.versionId = versionId; this.emit(); }
  setMedia(media: MediaInfo | null): void { this.media = media; this.emit(); }
  setAgentModel(model: string): void { this.agentModel = model; this.emit(); }
  setPermissionMode(mode: "ask" | "auto"): void { this.permissionMode = mode; this.emit(); }
  setUsage(usage: UsageSummary): void { this.usage = usage; this.emit(); }
  setAssets(assets: AgentAsset[]): void { this.assets = assets; this.emit(); }
  setStatus(status: string): void { this.status = status; this.emit(); }
  setLoader(loader: Loader | null): void { this.loader = loader; this.emit(); }
  /** Move the busy spinner on one frame. Does nothing, and draws nothing, when nothing is working. */
  tickSpinner(): void { if (this.loader) { this.spinner += 1; this.emit(); } }
  setAgentRunning(running: boolean): void { this.agentRunning = running; this.emit(); }

  // Playback and marks ---------------------------------------------------------------------------
  setPlayhead(seconds: number): void {
    const limit = this.media?.duration ?? 0;
    this.playhead = Math.max(0, Math.min(limit, seconds));
    this.emit();
  }
  movePlayhead(delta: number): void { this.setPlayhead(this.playhead + delta); }
  setPlaying(playing: boolean): void { this.playing = playing; this.emit(); }
  togglePlaying(): void { if (this.media) this.setPlaying(!this.playing); }
  adjustVolume(delta: number): void { this.volume = Math.max(0, Math.min(100, this.volume + delta)); this.emit(); }
  setIn(): void { this.selection = { ...this.selection, in: this.playhead }; this.emit(); }
  setOut(): void { this.selection = { ...this.selection, out: this.playhead }; this.emit(); }
  setSelection(selection: Selection): void { this.selection = { in: selection.in, out: selection.out }; this.emit(); }

  // Conversation ---------------------------------------------------------------------------------
  setMessages(history: readonly ChatMessage[]): void {
    this.liveId = null;
    this.messages = history.map((item) => ({ id: this.nextId(), role: item.role, text: item.content, ...(item.label ? { label: item.label } : {}), live: false }));
    this.emit();
  }
  addMessage(role: ChatMessage["role"], text: string, label?: string): void {
    this.messages = [...this.messages, { id: this.nextId(), role, text, ...(label ? { label } : {}), live: false }];
    this.emit();
  }
  clearMessages(): void { this.liveId = null; this.messages = []; this.emit(); }
  /** Add streamed text to the message being written, starting one if needed. */
  appendLive(text: string, label: string): void {
    const live = this.messages.find((message) => message.id === this.liveId);
    if (live) live.text += text;
    else {
      this.liveId = this.nextId();
      this.messages = [...this.messages, { id: this.liveId, role: "assistant", text, label, live: true }];
    }
    this.emit();
  }
  /** Stop streaming into the current message and return what it holds. */
  endLive(): string | null {
    const live = this.messages.find((message) => message.id === this.liveId);
    this.liveId = null;
    if (!live) return null;
    live.live = false;
    this.emit();
    return live.text;
  }
  setChatExpanded(expanded: boolean): void { this.chatExpanded = expanded; this.emit(); }
  toggleChatExpanded(): void {
    if (!this.chatExpanded) { this.playing = false; this.overlay = null; }
    this.chatExpanded = !this.chatExpanded;
    this.emit();
  }
  restoreComposerText(text: string): void { this.composerRestore = text; this.emit(); }
  takeComposerRestore(): string | null { const text = this.composerRestore; this.composerRestore = null; return text; }

  // Panels ---------------------------------------------------------------------------------------
  openOverlay(kind: OverlayKind): void {
    this.playing = false; this.chatExpanded = false; this.overlay = kind; this.emit();
  }
  closeOverlay(): void { this.overlay = null; this.emit(); }
  openApproval(request: ApprovalRequest): void { this.approval = request; this.openOverlay("approval"); }
  openChoice(request: ChoicePrompt): void { this.choice = request; this.openOverlay("choice"); }
  clearPrompts(): void {
    this.approval = null; this.choice = null;
    if (this.overlay === "approval" || this.overlay === "choice") this.overlay = null;
    this.emit();
  }

  private nextId(): string { this.counter += 1; return `m${this.counter}`; }
  private emit(): void { for (const listener of this.listeners) listener(); }
}
