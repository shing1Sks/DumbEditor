import type { MediaInfo, Selection, VersionEntry } from "../../types.js";
import { AgentWorkspace, type AgentAsset } from "../agent-workspace.js";
import { probeMedia } from "../media.js";
import type { ProjectStore } from "../project.js";
import { formatTime } from "../time.js";
import { summarizeUsage, type UsageEntry, type UsageSummary } from "../usage.js";

export interface EditorStateDescription {
  /** Increments whenever the described text would change. */
  revision: number;
  /** What the agent reads each turn it changed. */
  body: string;
}

/**
 * The single live view of the open project. The UI reads it, the agent reads it, and actions
 * write it. Durable data stays in ProjectStore; this class adds what is only true right now
 * (playhead, marks) and notifies subscribers when anything changes.
 */
export class EditorState {
  private readonly listeners = new Set<() => void>();
  private revisionCounter = 0;
  private mediaInfo: MediaInfo;
  private playheadSeconds = 0;
  private marks: Selection = { in: null, out: null };
  private assetList: AgentAsset[] = [];
  private usageEntries: UsageEntry[] = [];

  private constructor(readonly store: ProjectStore, readonly workspace: AgentWorkspace, media: MediaInfo) {
    this.mediaInfo = media;
  }

  static async open(store: ProjectStore): Promise<EditorState> {
    const workspace = new AgentWorkspace(store.createAgentWorkspace());
    await workspace.initialize();
    const state = new EditorState(store, workspace, await probeMedia(store.current.filePath));
    await state.reloadAssetsAndUsage();
    return state;
  }

  get media(): MediaInfo { return this.mediaInfo; }
  get playhead(): number { return this.playheadSeconds; }
  get selection(): Selection { return this.marks; }
  get assets(): readonly AgentAsset[] { return this.assetList; }
  get usage(): UsageSummary { return summarizeUsage(this.usageEntries); }
  get revision(): number { return this.revisionCounter; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setPlayhead(seconds: number): void {
    const next = Math.max(0, Math.min(this.mediaInfo.duration, Number.isFinite(seconds) ? seconds : 0));
    const changed = Math.round(next * 10) !== Math.round(this.playheadSeconds * 10);
    this.playheadSeconds = next;
    if (changed) this.bump();
  }

  setSelection(selection: Selection): void {
    if (selection.in === this.marks.in && selection.out === this.marks.out) return;
    this.marks = { in: selection.in, out: selection.out };
    this.bump();
  }

  /** Re-read everything that depends on the active version, then reset playhead and marks. */
  async afterVersionChange(): Promise<void> {
    this.mediaInfo = await probeMedia(this.store.current.filePath);
    this.playheadSeconds = 0;
    this.marks = { in: null, out: null };
    await this.store.pinVersion(this.store.current.id);
    await this.reloadAssetsAndUsage();
    this.bump();
  }

  async revertTo(reference: string): Promise<VersionEntry> {
    const version = await this.store.revert(reference);
    await this.afterVersionChange();
    return version;
  }

  async refreshAssets(): Promise<void> {
    await this.reloadAssetsAndUsage();
    this.bump();
  }

  async recordUsage(entry: Omit<UsageEntry, "id" | "at">): Promise<void> {
    this.usageEntries.push(await this.store.appendUsage(entry));
    this.notify();
  }

  describe(): EditorStateDescription {
    const version = this.store.current;
    const recent = this.store.history(6).map((item) => `${item.id} ${truncate(item.action, 60)}`).join(" · ");
    const mark = (value: number | null) => value === null ? "unset" : `${value.toFixed(1)}s`;
    const body = [
      `Active version: ${version.id}${version.parentId ? ` (parent ${version.parentId})` : " (original)"}`,
      `Video: ${this.mediaInfo.duration.toFixed(1)}s, ${this.mediaInfo.width}x${this.mediaInfo.height}, ${this.mediaInfo.fps}fps, audio ${this.mediaInfo.hasAudio ? "yes" : "no"}`,
      `Playhead: ${this.playheadSeconds.toFixed(1)}s (${formatTime(this.playheadSeconds)})`,
      `In mark: ${mark(this.marks.in)}`,
      `Out mark: ${mark(this.marks.out)}`,
      `Recent versions, newest first: ${recent}`,
      `Workspace assets: ${this.assetList.length}`,
    ].join("\n");
    return { revision: this.revisionCounter, body };
  }

  private async reloadAssetsAndUsage(): Promise<void> {
    const [assets, usage] = await Promise.all([this.workspace.assets(), this.store.usageEntries()]);
    this.assetList = assets;
    this.usageEntries = usage;
  }

  private bump(): void {
    this.revisionCounter += 1;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
