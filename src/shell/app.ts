import type { ChildProcess } from "node:child_process";
import { extname, resolve } from "node:path";
import type { Component, Terminal } from "@earendil-works/pi-tui";
import { createEditorRegistry, directEditCall, type ActionContext } from "../core/actions/index.js";
import type { AgentAsset } from "../core/agent-workspace.js";
import { COMMANDS } from "../core/commands.js";
import { providerKeyStatus } from "../core/config.js";
import type { Engine } from "../core/engine/engine.js";
import type { ApprovalDecision } from "../core/engine/events.js";
import { exportDestination, exportVideo, type ExportFormat } from "../core/export.js";
import { detectPreviewBackend, playAudio, type PreviewBackend } from "../core/media.js";
import { listProviderModels } from "../core/models.js";
import { MusicPreviewController, clearMusicSelection, readMusicSelection, selectMusicTrack } from "../core/music.js";
import { ProjectStore, type ProjectSummary } from "../core/project.js";
import { terminateProcess, terminateRunningProcesses } from "../core/process.js";
import { DEFAULT_SETTINGS, readSettings, setAgentPermissionMode, setBaseAgentModel, setDefaultModel, setSpendCeiling, type DumbEditorSettings } from "../core/settings.js";
import { EditorState } from "../core/state/editor-state.js";
import { formatTime } from "../core/time.js";
import type { ChatMessage, DirectEdit } from "../types.js";
import { runCommand, type CommandApp } from "./commands.js";
import { createAgentEngine, type EditorModels } from "./engine-factory.js";
import { playbackStart } from "./input/keys.js";
import { ApprovalPanel } from "./overlays/approval.js";
import { AssetPanel } from "./overlays/assets.js";
import { ChoicePanel } from "./overlays/choice.js";
import { ModePanel } from "./overlays/mode.js";
import { ExportPanel } from "./overlays/export.js";
import type { PanelContext } from "./overlays/frame.js";
import { HelpPanel } from "./overlays/help.js";
import { HistoryPanel } from "./overlays/history.js";
import { ModelPanel } from "./overlays/model.js";
import { MusicPanel } from "./overlays/music.js";
import { ProjectsPanel } from "./overlays/projects.js";
import { AudioController, type AudioDeps } from "./preview/audio.js";
import { PlaybackController, type PlaybackFrame } from "./preview/playback.js";
import { createShellScreen, type OverlayContext, type ShellScreen } from "./screen.js";
import { bindEngineEvents } from "./state/engine-bridge.js";
import { ShellState, type OverlayKind } from "./state/shell-state.js";

export interface ShellAppOptions {
  terminal: Terminal;
  /** A video to open at start. */
  initialPath?: string;
  cwd?: string;
  backend?: PreviewBackend;
  /** Called when the app wants to quit, after it has released everything it holds. */
  onExit?: (code: number) => void;
  /** Test seam: build the agent for a project instead of reading the OpenRouter key. */
  createEngine?: (state: EditorState, chatSeed: readonly ChatMessage[]) => Promise<Engine | null>;
  audio?: AudioDeps;
}

/** The editor: opens projects, runs commands and the agent, and keeps the screen in step with what happens. */
export class ShellApp implements CommandApp {
  readonly state = new ShellState();
  readonly registry = createEditorRegistry();
  readonly screen: ShellScreen;
  project: ProjectStore | null = null;
  editor: EditorState | null = null;
  engine: Engine | null = null;
  settings: DumbEditorSettings = structuredClone(DEFAULT_SETTINGS);

  private readonly backend: PreviewBackend;
  private readonly playback: PlaybackController;
  private readonly audio: AudioController;
  private readonly models: { current: EditorModels | null } = { current: null };
  private readonly musicPreview = new MusicPreviewController();
  private unbindEngine: (() => void) | null = null;
  private unbindEditor: (() => void) | null = null;
  private openPanel: { kind: OverlayKind; dispose?: () => void } | null = null;
  private projectList: ProjectSummary[] = [];
  private showAllHistory = false;
  private musicQuery = "";
  private selectedMusicId: string | null = null;
  private exportInitial: { destination: string; format: ExportFormat } = { destination: "", format: "mp4" };
  private assetProcess: ChildProcess | null = null;
  private assetPlaying = false;
  private disposed = false;
  private readonly spinnerTimer: NodeJS.Timeout;

  constructor(private readonly options: ShellAppOptions) {
    this.backend = options.backend ?? detectPreviewBackend();
    this.screen = createShellScreen({
      terminal: options.terminal, state: this.state, backend: this.backend, commands: COMMANDS, cwd: options.cwd ?? process.cwd(),
      hooks: {
        onSubmit: (text) => { void this.submit(text); },
        onInterrupt: () => this.interrupt(),
        onAbortAgent: () => this.engine?.abort(),
        onOpenAssets: () => this.openAssets(),
        onTogglePermissions: () => { void this.togglePermissionMode(); },
      },
      overlays: (kind, context) => this.buildOverlay(kind, context),
      onLayout: () => this.onStateChange(),
    });
    this.playback = new PlaybackController({
      onFrame: (frame) => this.onFrame(frame),
      onEnd: () => { this.state.setPlaying(false); if (this.state.media) this.state.setPlayhead(this.state.media.duration); },
      onError: (error) => { this.state.setStatus(`Preview unavailable: ${error.message}`); this.state.setPlaying(false); },
    });
    this.audio = new AudioController((message) => this.state.setStatus(message), options.audio);
    this.state.subscribe(() => this.onStateChange());
    // Animate the busy spinner; it draws nothing while nothing is working.
    this.spinnerTimer = setInterval(() => this.state.tickSpinner(), 110);
    this.spinnerTimer.unref();
  }

  /** Start drawing, load settings, and open the video named at launch. */
  async start(): Promise<void> {
    this.screen.start();
    try {
      this.applySettings(await readSettings());
    } catch (error) {
      this.state.setStatus(message(error));
    }
    if (this.options.initialPath) await this.openVideo(this.options.initialPath);
    else this.state.addMessage("assistant", "Open a video with /open <path>, or relaunch as: dumbeditor video.mp4", "editor");
  }

  /** Release everything: stop the agent, the preview, the sound, and give the terminal back. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.spinnerTimer);
    this.engine?.abort();
    this.unbindEngine?.();
    this.unbindEditor?.();
    this.playback.dispose();
    this.audio.dispose();
    this.musicPreview.dispose();
    this.openPanel?.dispose?.();
    terminateProcess(this.assetProcess);
    terminateRunningProcesses();
    this.screen.stop();
  }

  quit(): void {
    this.dispose();
    this.options.onExit?.(0);
  }

  // Keys and text --------------------------------------------------------------------------------

  private interrupt(): void {
    if (this.engine?.running) this.engine.abort();
    else this.quit();
  }

  /** A line from the composer: a slash command, or a request for the agent. */
  async submit(request: string): Promise<void> {
    const { state } = this;
    if (state.busy) return;
    state.addMessage("user", request);
    this.screen.transcript.scrollToEnd();
    if (request.startsWith("/")) {
      try { await runCommand(this, request); } catch (error) { await this.answer(message(error)); }
      return;
    }
    const { project, editor, engine } = this;
    if (!project || !state.media || !editor) { await this.answer("Open a video first with /open <path>."); return; }
    if (!engine) { await this.answer("Add an OpenRouter API key with dumbeditor setup to talk to the agent."); return; }
    // Text sent while the agent is running steers it; otherwise it starts a run.
    editor.setPlayhead(state.playhead);
    editor.setSelection(state.selection);
    try {
      if (!engine.running) {
        await project.nameFromFirstRequest(request);
        await project.register();
      }
      await project.addChat("user", request);
      engine.submit(request);
    } catch (error) {
      await this.answer(message(error));
      state.setStatus("Request failed");
    }
  }

  async answer(text: string, label = this.state.agentModel): Promise<void> {
    this.state.addMessage("assistant", text, label);
    if (this.project) await this.project.addChat("assistant", text, label);
  }

  // Projects -------------------------------------------------------------------------------------

  async openVideo(path: string, projectDirectory?: string): Promise<void> {
    const { state } = this;
    if (this.engine?.running) {
      state.addMessage("assistant", "The agent is working. Wait for it to finish, or press Esc to stop it, before opening another video.");
      return;
    }
    state.setLoader({ source: "Editor", stage: "Opening video" });
    state.setPlaying(false);
    try {
      const store = projectDirectory ? await ProjectStore.openProject(projectDirectory) : await ProjectStore.open(resolve(path));
      state.setLoader({ source: "Editor", stage: "Reading media details" });
      const editor = await EditorState.open(store);
      const history = await store.chatHistory();
      await store.register();
      const engine = await this.createEngine(editor, history);

      this.unbindEditor?.();
      this.project = store;
      this.editor = editor;
      this.setEngine(engine);
      this.screen.preview.clear();
      this.unbindEditor = this.followEditor(editor, store);
      state.setProject(store.name, store.current.id, store.versionLimit);
      state.setMedia(editor.media);
      state.setVersions(store.history(Number.POSITIVE_INFINITY), store.current.id);
      state.setAssets([...editor.assets]);
      state.setUsage(editor.usage);
      state.setMessages(history);
      state.setSelection({ in: null, out: null });
      state.setPlayhead(0);
      state.setStatus(`Opened ${store.name}`);
      state.addMessage("assistant", `Opened ${store.name} · ${editor.media.width}x${editor.media.height} · ${formatTime(editor.media.duration)}`, "editor");
      if (!engine && this.engineNotices.length === 0) state.addMessage("assistant", "Add an OpenRouter API key with dumbeditor setup to talk to the agent. Slash commands still work.", "editor");
      this.flushEngineNotices();
    } catch (error) {
      state.addMessage("assistant", message(error));
      state.setStatus("Open failed");
    } finally {
      state.setLoader(null);
    }
  }

  async openProjects(): Promise<void> {
    const { state } = this;
    state.setPlaying(false);
    state.setLoader({ source: "Editor", stage: "Loading saved projects" });
    try {
      this.projectList = await ProjectStore.listProjects(this.project?.snapshot.sourcePath);
      state.openOverlay("projects");
      state.setStatus(`${this.projectList.length} saved project${this.projectList.length === 1 ? "" : "s"}`);
    } catch (error) {
      await this.answer(message(error));
      state.setStatus("Could not load projects");
    } finally {
      state.setLoader(null);
    }
  }

  /** Keep the screen in step with the editor's own state: media, cost, assets, versions. */
  private followEditor(editor: EditorState, store: ProjectStore): () => void {
    let active = editor.store.current.id;
    return editor.subscribe(() => {
      const { state } = this;
      state.setMedia(editor.media);
      state.setUsage(editor.usage);
      state.setAssets([...editor.assets]);
      state.setVersions(store.history(Number.POSITIVE_INFINITY), store.current.id);
      if (editor.store.current.id !== active) {
        active = editor.store.current.id;
        state.setPlayhead(editor.playhead);
        state.setSelection(editor.selection);
      }
    });
  }

  // Engine ---------------------------------------------------------------------------------------

  /** Why the agent could not start, held until the chat is on screen: loading a project replaces the messages. */
  private engineNotices: string[] = [];

  private flushEngineNotices(): void {
    for (const text of this.engineNotices.splice(0)) this.state.addMessage("assistant", text, "error");
  }

  private async createEngine(editor: EditorState, chatSeed: readonly ChatMessage[]): Promise<Engine | null> {
    if (this.options.createEngine) return this.options.createEngine(editor, chatSeed);
    return createAgentEngine({
      state: editor, registry: this.registry, getSettings: () => this.settings, models: this.models, chatSeed,
      report: (text) => { this.engineNotices.push(text); },
    });
  }

  private setEngine(engine: Engine | null): void {
    this.unbindEngine?.();
    this.engine = engine;
    this.unbindEngine = engine
      ? bindEngineEvents(this.state, engine, {
        label: () => this.state.agentModel,
        persistAnswer: (text) => { void this.project?.addChat("assistant", text, this.state.agentModel); },
      })
      : null;
  }

  private resolveApproval(decision: ApprovalDecision): void {
    const { approval } = this.state;
    if (approval) this.engine?.resolveApproval(approval.id, decision);
    this.state.clearPrompts();
  }

  private resolveChoice(answer: string | null): void {
    const { choice } = this.state;
    if (choice) this.engine?.resolveChoice(choice.id, answer);
    this.state.clearPrompts();
  }

  async compact(): Promise<void> {
    const { engine, state } = this;
    if (!engine) { await this.answer("Open a video, with an OpenRouter key configured, first."); return; }
    state.setLoader({ source: "Editor", stage: "Compacting conversation" });
    try { await this.answer(await engine.compact() ? "Compacted the earlier conversation." : "There is nothing to compact yet."); }
    finally { state.setLoader(null); }
  }

  // Editing --------------------------------------------------------------------------------------

  private actionContext(editor: EditorState, request: string, onStage: (stage: string) => void): ActionContext {
    return {
      state: editor, settings: this.settings, signal: new AbortController().signal, request,
      progress: (update) => onStage(update.stage), requestChoice: async () => null,
    };
  }

  async applyEdit(edit: DirectEdit, request: string): Promise<void> {
    const { editor, state } = this;
    if (!editor) throw new Error("Open a video first with /open <path>.");
    state.setLoader({ source: "Command", stage: "Preparing edit" });
    const { name, args } = directEditCall(edit);
    const result = await this.registry.run(name, args, this.actionContext(editor, request, (stage) => state.setLoader({ source: "Command", stage })));
    await this.answer(result.text);
    state.setStatus("Command · complete");
  }

  async changeVersion(reference: string): Promise<void> {
    const { editor, state } = this;
    if (!editor) return;
    state.setLoader({ source: "Editor", stage: "Loading saved version" });
    state.setPlaying(false);
    try {
      const version = await editor.revertTo(reference);
      await this.answer(`Now on ${version.id}: ${version.action}`);
      state.setStatus(`Current ${version.id}`);
    } catch (error) {
      await this.answer(message(error));
      state.setStatus("Revert failed");
    } finally {
      state.setLoader(null);
    }
  }

  async setVersionLimit(limit: number): Promise<void> {
    const { project, state } = this;
    if (!project) return;
    await project.setVersionLimit(limit);
    state.setProject(project.name, project.current.id, project.versionLimit);
    state.setVersions(project.history(Number.POSITIVE_INFINITY), project.current.id);
  }

  async setPermissionMode(mode: "ask" | "auto"): Promise<void> {
    this.applySettings(await setAgentPermissionMode(mode));
  }

  /** ask <-> auto; returns the mode now in force. */
  async togglePermissionMode(): Promise<"ask" | "auto"> {
    const next = this.settings.agent.permissionMode === "auto" ? "ask" : "auto";
    await this.setPermissionMode(next);
    this.state.setStatus(next === "auto" ? "Agent runs tools on its own (auto)" : "Agent asks before each tool (ask)");
    return next;
  }

  async setSpendCeiling(usd: number): Promise<void> {
    this.applySettings(await setSpendCeiling(usd));
  }

  private applySettings(settings: DumbEditorSettings): void {
    this.settings = settings;
    this.state.setAgentModel(settings.models.openrouter.text);
    this.state.setPermissionMode(settings.agent.permissionMode);
  }

  // Panels ---------------------------------------------------------------------------------------

  openModelPicker(): void { this.state.openOverlay("model"); }
  openModePicker(): void { this.state.openOverlay("mode"); }

  openHistory(showAll: boolean): void { this.showAllHistory = showAll; this.state.openOverlay("history"); }

  openAssets(): void {
    this.stopAssetPlayback();
    this.state.openOverlay("assets");
  }

  async openMusic(query: string): Promise<void> {
    this.musicPreview.stop();
    this.musicQuery = query;
    this.selectedMusicId = (await readMusicSelection()).trackId;
    this.state.openOverlay("music");
  }

  openExport(requested: string): void {
    const { project } = this;
    if (!project) return;
    const format: ExportFormat = extname(requested).toLowerCase() === ".mkv" ? "mkv" : "mp4";
    this.exportInitial = { destination: exportDestination(project.snapshot.sourcePath, requested || undefined, format), format };
    this.state.openOverlay("export");
  }

  private async performExport(choice: { destination: string; format: ExportFormat; preset: "copy" | "high" | "balanced" | "compact" }): Promise<void> {
    const { project, state } = this;
    if (!project) return;
    state.setLoader({ source: "Editor", stage: "Preparing export" });
    try {
      const result = await exportVideo({
        input: project.current.filePath, destination: choice.destination, format: choice.format, preset: choice.preset,
        onStage: (stage) => state.setLoader({ source: "Editor", stage }),
      });
      state.closeOverlay();
      await this.answer(`Exported ${result.path} · ${result.format.toUpperCase()} · ${formatBytes(result.bytes)}`);
      state.setStatus("Export complete");
    } catch (error) {
      await this.answer(message(error));
      state.setStatus("Export failed");
    } finally {
      state.setLoader(null);
    }
  }

  private stopAssetPlayback(): void {
    terminateProcess(this.assetProcess);
    this.assetProcess = null;
    this.assetPlaying = false;
  }

  private toggleAssetPlayback(asset: AgentAsset): void {
    if (this.assetPlaying) { this.stopAssetPlayback(); return; }
    const onError = asset.kind === "video" ? () => undefined : (error: Error) => { this.state.setStatus(error.message); this.assetPlaying = false; };
    this.assetProcess = playAudio(asset.path, 0, this.state.volume, onError);
    this.assetPlaying = this.assetProcess !== null;
    this.assetProcess?.once("close", () => { this.assetPlaying = false; this.screen.tui.requestRender(); });
  }

  private buildOverlay(kind: OverlayKind, context: OverlayContext): Component | null {
    const { state } = this;
    const panel: PanelContext = { bandRows: context.bandRows, requestRender: () => this.screen.tui.requestRender() };
    const close = context.close;
    // A panel that is being replaced (the asset browser by an approval, say) must stop what it started.
    this.openPanel?.dispose?.();
    this.openPanel = { kind };
    switch (kind) {
      case "mode":
        return new ModePanel(panel, {
          current: this.settings.agent.permissionMode, close,
          apply: (mode) => { void this.setPermissionMode(mode).then(() => state.setStatus(mode === "auto" ? "Agent runs tools on its own (auto)" : "Agent asks before each tool (ask)")); },
        });
      case "help": return new HelpPanel(panel, { model: () => state.agentModel, close });
      case "history": return new HistoryPanel(panel, { state, showAll: this.showAllHistory, close });
      case "projects":
        return new ProjectsPanel(panel, {
          projects: this.projectList, activeProjectDir: this.project?.snapshot.projectDir,
          open: (summary) => { close(); void this.openVideo(summary.sourcePath, summary.projectDir); }, close,
        });
      case "approval":
        return state.approval ? new ApprovalPanel(panel, { request: state.approval, decide: (decision) => this.resolveApproval(decision) }) : null;
      case "choice":
        return state.choice ? new ChoicePanel(panel, { request: state.choice, answer: (answer) => this.resolveChoice(answer) }) : null;
      case "assets": {
        const assets = new AssetPanel(panel, {
          assets: () => state.assets, playing: () => this.assetPlaying, togglePlay: (asset) => this.toggleAssetPlayback(asset),
          stopPlay: () => this.stopAssetPlayback(), typeText: (text) => this.screen.composer.restore(text), close,
        });
        this.openPanel = { kind, dispose: () => { assets.dispose(); this.stopAssetPlayback(); } };
        return assets;
      }
      case "model":
        return new ModelPanel(panel, {
          settings: () => this.settings, keys: () => providerKeyStatus(), listModels: (provider, slot) => listProviderModels(provider, slot),
          setLoader: (loader) => state.setLoader(loader), close,
          save: async ({ capability, provider, slot, model }) => {
            const next = capability === "agent" ? await setBaseAgentModel(provider, model.id) : await setDefaultModel(provider, slot, model.id);
            this.applySettings(next);
            if (capability === "agent" && this.editor && !this.engine?.running) { this.setEngine(await this.createEngine(this.editor, await this.project?.chatHistory() ?? [])); this.flushEngineNotices(); }
            state.setStatus(`${model.id} selected`);
            await this.answer(capability === "agent" ? `Base agent set to ${model.id} through ${provider}.` : `Default ${provider} ${slot} model set to ${model.id}.`);
          },
        });
      case "music": {
        const music = new MusicPanel(panel, {
          play: (id, callbacks) => { this.musicPreview.play(id, { volume: state.volume, onEnd: callbacks.onEnd, onError: callbacks.onError }); },
          stop: () => this.musicPreview.stop(),
          select: async (track) => {
            await selectMusicTrack(track.id);
            state.setStatus(`${track.title} selected`);
            await this.answer(`${track.title} selected. Ask ${state.agentModel} to add the selected background music.`);
          },
          clearSelection: async () => { await clearMusicSelection(); }, setStatus: (text) => state.setStatus(text), close,
        }, this.selectedMusicId, this.musicQuery);
        this.openPanel = { kind, dispose: () => music.dispose() };
        return music;
      }
      case "export":
        return new ExportPanel(panel, {
          sourcePath: this.project?.snapshot.sourcePath ?? "", destination: this.exportInitial.destination, format: this.exportInitial.format,
          busy: () => state.busy, perform: (choice) => { void this.performExport(choice); }, close,
        });
      default:
        return null;
    }
  }

  // Preview --------------------------------------------------------------------------------------

  private onFrame(frame: PlaybackFrame): void {
    this.screen.preview.setFrame(frame);
    // A picture arrived, so an earlier "Preview unavailable" note is out of date.
    if (this.state.status.startsWith("Preview unavailable")) this.state.setStatus("Ready");
    if (this.state.playing && Math.abs(frame.time - this.state.playhead) >= 0.1) this.state.setPlayhead(frame.time);
  }

  /** Called on every change: keeps playback, sound and the shared editor state in step with what is on screen. */
  private onStateChange(): void {
    if (this.disposed || !this.playback) return;
    const { state } = this;
    if (this.openPanel && state.overlay !== this.openPanel.kind) { this.openPanel.dispose?.(); this.openPanel = null; }
    // A new version is being rendered: playing the old one alongside would only get in its way.
    if (state.videoMutationActive && state.playing) { state.setPlaying(false); return; }
    const layout = this.screen.layout();
    const visible = state.overlay === null && !state.chatExpanded;
    const filePath = this.project?.current.filePath;
    this.playback.update({
      filePath: visible ? filePath : undefined, media: state.media, columns: layout.videoColumns, rows: layout.bandRows,
      backend: this.backend, playing: state.playing, time: state.playhead,
    });
    this.audio.update({
      filePath, hasAudio: state.media?.hasAudio ?? false, playing: state.playing,
      start: playbackStart(state.playhead, state.media?.duration ?? 0), volume: state.volume,
    });
    // The agent reads the playhead and marks, so keep them current; the playhead only while paused, to stay cheap.
    if (this.editor) {
      if (!state.playing) this.editor.setPlayhead(state.playhead);
      this.editor.setSelection(state.selection);
    }
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
