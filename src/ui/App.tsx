import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extname, join, resolve } from "node:path";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import type { ChildProcess } from "node:child_process";
import type { ChatMessage, DirectEdit, MediaInfo, Selection } from "../types.js";
import type { AgentAsset } from "../core/agent-workspace.js";
import { createEditorRegistry, directEditCall, type ActionContext } from "../core/actions/index.js";
import { loadAgentSkills } from "../core/agent-skills.js";
import { commandSuggestions, parseEditCommand } from "../core/commands.js";
import { providerKeyStatus } from "../core/config.js";
import { Engine } from "../core/engine/engine.js";
import type { ApprovalDecision, EngineEvent } from "../core/engine/events.js";
import { EXPORT_FORMATS, EXPORT_PRESETS, exportDestination, exportVideo, type ExportFormat } from "../core/export.js";
import { playAudio } from "../core/media.js";
import { listMusicTracks, searchMusicTracks } from "../core/music-catalog.js";
import { clearMusicSelection, MusicPreviewController, readMusicSelection, selectMusicTrack } from "../core/music.js";
import { listProviderModels } from "../core/models.js";
import { createEditorModels } from "../core/pi/models.js";
import { ProjectStore, type ProjectSummary } from "../core/project.js";
import { terminateProcess, terminateRunningProcesses } from "../core/process.js";
import { SessionStore } from "../core/session/session-store.js";
import { DEFAULT_SETTINGS, readSettings, setAgentPermissionMode, setBaseAgentModel, setDefaultModel, setSpendCeiling, type DumbEditorSettings, type ModelProvider, type ModelSlot } from "../core/settings.js";
import { EditorState } from "../core/state/editor-state.js";
import { formatTime } from "../core/time.js";
import { EMPTY_USAGE_SUMMARY, formatUsd, type UsageSummary } from "../core/usage.js";
import { AssetPanel } from "./AssetPanel.js";
import { ChatPanel } from "./ChatPanel.js";
import { ApprovalPanel, approvalDecision, approvalOptions, type ApprovalView } from "./ApprovalPanel.js";
import { ChoicePanel, type ChoicePanelState } from "./ChoicePanel.js";
import type { ChoiceRequest } from "../core/choice.js";
import { Help } from "./Help.js";
import { History } from "./History.js";
import { InputPanel } from "./InputPanel.js";
import { isBackspace, isFocusReport, playbackStart } from "./keys.js";
import { editorLayout } from "./layout.js";
import { ExportPanel, type ExportFocus, type ExportPanelState } from "./ExportPanel.js";
import { capabilityDefinition, filteredPickerModels, initialModelPicker, MODEL_CAPABILITIES, ModelPanel, type ModelPickerState } from "./ModelPanel.js";
import { MusicPanel } from "./MusicPanel.js";
import { ProjectsPanel } from "./ProjectsPanel.js";
import { AssetsSidebar, ProjectSidebar } from "./Sidebars.js";
import { Timeline } from "./Timeline.js";
import { chatViewport, inputViewport, moveInputCursorVertically } from "./text-layout.js";
import { clearRetainedTerminalLayer } from "./terminal-layers.js";
import { activePreviewBackend, VideoSurface } from "./VideoSurface.js";
import { isVideoMutationStage } from "./work-state.js";

type Overlay = "help" | "history" | "model" | "music" | "export" | "assets" | "projects" | "approval" | "choice" | null;
interface LoaderState { source: string; stage: string }
const LOADER_MARK = "◐";
/** Commands that cannot disturb a running agent; everything else waits until it finishes or is stopped. */
const SAFE_DURING_RUN = new Set(["/help", "/chat", "/status", "/clear", "/play", "/pause", "/quit", "/exit", "/permissions", "/budget", "/version", "/versions", "/assets"]);

export function App({ initialPath }: { initialPath?: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin } = useStdin();
  const [terminal, setTerminal] = useState({ columns: stdout.columns ?? 100, rows: stdout.rows ?? 36 });
  const [project, setProject] = useState<ProjectStore | null>(null);
  const [revision, setRevision] = useState(0);
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const currentTimeRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(70);
  const [selection, setSelection] = useState<Selection>({ in: null, out: null });
  const [input, setInput] = useState("");
  const [inputCursor, setInputCursor] = useState(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatScrollRows, setChatScrollRows] = useState(0);
  const [chatFocused, setChatFocused] = useState(false);
  const [loader, setLoader] = useState<LoaderState | null>(null);
  const [status, setStatus] = useState("Ready");
  const [assets, setAssets] = useState<AgentAsset[]>([]);
  const [usage, setUsage] = useState<UsageSummary>(EMPTY_USAGE_SUMMARY);
  const [assetIndex, setAssetIndex] = useState(0);
  const [assetPlaying, setAssetPlaying] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectIndex, setProjectIndex] = useState(0);
  const [approval, setApproval] = useState<ApprovalView | null>(null);
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [choice, setChoice] = useState<(ChoiceRequest & { id: string }) | null>(null);
  const [choicePanel, setChoicePanel] = useState<ChoicePanelState>({ selectedIndex: 0, customActive: false, customText: "", customCursor: 0 });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
  const registry = useMemo(() => createEditorRegistry(), []);
  const modelsRef = useRef<ReturnType<typeof createEditorModels> | null>(null);
  const liveMessage = useRef<{ id: string; text: string; timer: NodeJS.Timeout | null } | null>(null);
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const assetPreview = useRef<ChildProcess | null>(null);
  const [overlay, setOverlayState] = useState<Overlay>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [settings, setSettings] = useState<DumbEditorSettings>(() => structuredClone(DEFAULT_SETTINGS));
  const [settingsReady, setSettingsReady] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const projectRef = useRef(project);
  projectRef.current = project;
  const [modelPicker, setModelPicker] = useState<ModelPickerState>(initialModelPicker);
  const [modelOverlayReady, setModelOverlayReady] = useState(false);
  const modelRequest = useRef(0);
  const musicPreview = useRef<MusicPreviewController | null>(null);
  if (!musicPreview.current) musicPreview.current = new MusicPreviewController();
  const [musicQuery, setMusicQuery] = useState("");
  const [musicIndex, setMusicIndex] = useState(0);
  const [selectedMusicId, setSelectedMusicId] = useState<string | null>(null);
  const [previewMusicId, setPreviewMusicId] = useState<string | null>(null);
  const [exportPanel, setExportPanel] = useState<ExportPanelState>(() => ({ destination: "", cursor: 0, format: "mp4", preset: "balanced", focus: "path" }));
  const didOpenInitialPath = useRef(false);

  const setOverlay = useCallback((next: Overlay) => {
    if (next) {
      clearRetainedTerminalLayer();
      setChatFocused(false);
    }
    setOverlayState(next);
  }, []);

  // A running agent shows its stage in the header but must not block typing: text sent now steers it.
  const busy = loader !== null && !agentRunning;
  const videoMutationActive = loader !== null && isVideoMutationStage(loader.stage);
  const previewBackend = useMemo(() => activePreviewBackend(), []);
  const inputMetrics = useMemo(() => inputViewport(input, inputCursor, Math.max(8, terminal.columns - 6)), [input, inputCursor, terminal.columns]);
  const layout = useMemo(() => editorLayout(terminal, media, previewBackend, inputMetrics.rows), [terminal, media, previewBackend, inputMetrics.rows]);
  const suggestions = useMemo(() => commandSuggestions(input), [input]);
  const musicTracks = useMemo(() => musicQuery.trim() ? searchMusicTracks(musicQuery) : listMusicTracks(), [musicQuery]);
  const currentFile = project?.current.filePath;
  const agentModel = settingsReady ? settings.models.openrouter.text : "editor model";
  const agentModelRef = useRef(agentModel);
  agentModelRef.current = agentModel;
  const controlsHint = terminal.columns >= 120
    ? `${previewBackend.toUpperCase()} · Ctrl+P play · ←/→ 5s · +/- volume · ↑/↓ chat · Ctrl+G focus`
    : "Ctrl+P play · +/- volume · ↑/↓ chat · Ctrl+G focus";
  const focusedConversationRows = layout.playerRows + layout.chatRows + 2;
  const visibleConversationRows = chatFocused ? focusedConversationRows : layout.chatRows;
  const chatPageRows = Math.max(1, visibleConversationRows - 2);

  const toggleChatFocus = useCallback(() => {
    setPlaying(false);
    setOverlay(null);
    setChatFocused((current) => {
      if (!current) clearRetainedTerminalLayer();
      return !current;
    });
  }, [setOverlay]);

  useEffect(() => { setSuggestionIndex(0); }, [input]);
  useEffect(() => { setChatScrollRows(0); }, [messages.length]);
  useEffect(() => () => { engineRef.current?.abort(); musicPreview.current?.dispose(); terminateProcess(assetPreview.current); terminateRunningProcesses(); }, []);
  useEffect(() => {
    void readSettings()
      .then((value) => { setSettings(value); setSettingsReady(true); })
      .catch((error) => { setSettingsReady(true); setStatus(errorMessage(error)); });
  }, []);

  useEffect(() => {
    if (videoMutationActive) setPlaying(false);
  }, [videoMutationActive]);
  useEffect(() => {
    if (overlay !== "model") { setModelOverlayReady(false); return; }
    setModelOverlayReady(false);
    const timer = setTimeout(() => setModelOverlayReady(true), 0);
    return () => clearTimeout(timer);
  }, [overlay]);
  useEffect(() => {
    const onResize = () => setTerminal({ columns: stdout.columns ?? 100, rows: stdout.rows ?? 36 });
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);
  useEffect(() => {
    if (!stdin.isTTY || !stdout.isTTY) return;
    const focusSequence = "\u001B[I";
    const onData = (chunk: Buffer | string) => {
      if (String(chunk).includes(focusSequence)) setPreviewRefresh((value) => value + 1);
    };
    stdout.write("\u001B[?1004h");
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      stdout.write("\u001B[?1004l");
    };
  }, [stdin, stdout]);

  // Mirror what the user does into the shared editor state so the agent sees the same playhead and marks.
  useEffect(() => { editor?.setPlayhead(currentTime); }, [currentTime, editor]);
  useEffect(() => { editor?.setSelection(selection); }, [selection, editor]);
  useEffect(() => {
    if (!editor) return;
    let activeVersion = editor.store.current.id;
    return editor.subscribe(() => {
      setMedia(editor.media); setUsage(editor.usage); setAssets([...editor.assets]); setRevision((value) => value + 1);
      if (editor.store.current.id !== activeVersion) {
        activeVersion = editor.store.current.id;
        currentTimeRef.current = editor.playhead; setCurrentTime(editor.playhead); setSelection(editor.selection);
      }
    });
  }, [editor]);

  const movePlayhead = useCallback((next: number) => {
    if (!media) return;
    const value = Math.max(0, Math.min(media.duration, next));
    currentTimeRef.current = value;
    setCurrentTime(value);
  }, [media]);
  const updatePreviewTime = useCallback((time: number, force: boolean) => {
    currentTimeRef.current = time;
    if (force) setCurrentTime(time);
  }, []);
  const addUiMessage = useCallback((role: ChatMessage["role"], content: string, label?: string) => {
    setMessages((items) => [...items, { role, content, at: new Date().toISOString(), ...(label ? { label } : {}) }]);
    setChatScrollRows(0);
  }, []);
  const answer = useCallback(async (content: string, label = agentModel) => {
    addUiMessage("assistant", content, label);
    if (project) await project.addChat("assistant", content, label);
  }, [addUiMessage, agentModel, project]);
  const stopAssetPlayback = useCallback(() => {
    terminateProcess(assetPreview.current);
    assetPreview.current = null;
    setAssetPlaying(false);
  }, []);
  const handlePreviewEnd = useCallback(() => setPlaying(false), []);
  const handlePreviewError = useCallback((error: Error) => {
    setStatus(`Preview unavailable: ${error.message}`);
    setPlaying(false);
  }, []);
  const closeAssetBrowser = useCallback(() => {
    stopAssetPlayback();
    setOverlay(null);
  }, [stopAssetPlayback]);
  const openAssetBrowser = useCallback(() => {
    setPlaying(false);
    stopAssetPlayback();
    setAssetIndex(Math.max(0, assets.length - 1));
    setOverlay("assets");
  }, [assets.length, stopAssetPlayback]);
  const resolveApproval = useCallback((decision: ApprovalDecision) => {
    if (approval) engineRef.current?.resolveApproval(approval.id, decision);
    setApproval(null);
    setOverlay(null);
  }, [approval, setOverlay]);
  const resolveChoice = useCallback((answer: string | null) => {
    if (choice) engineRef.current?.resolveChoice(choice.id, answer);
    setChoice(null);
    setOverlay(null);
  }, [choice, setOverlay]);

  /** Show the agent working: stream text, list tool calls, and surface approvals and choices. */
  const handleEngineEvent = useCallback((event: EngineEvent) => {
    const label = agentModelRef.current;
    const flushLive = () => {
      const live = liveMessage.current;
      if (!live) return;
      if (live.timer) { clearTimeout(live.timer); live.timer = null; }
      setMessages((items) => items.map((item) => item.at === live.id ? { ...item, content: live.text } : item));
    };
    switch (event.type) {
      case "run_start":
        setAgentRunning(true); setLoader({ source: label, stage: "Thinking" });
        break;
      case "text_delta": {
        let live = liveMessage.current;
        if (!live) {
          const id = `live-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          live = { id, text: "", timer: null };
          liveMessage.current = live;
          setMessages((items) => [...items, { role: "assistant", content: "", at: id, label }]);
        }
        live.text += event.text;
        setLoader((current) => current?.stage === "Writing response" ? current : { source: label, stage: "Writing response" });
        if (!live.timer) {
          const target = live;
          live.timer = setTimeout(() => {
            target.timer = null;
            setMessages((items) => items.map((item) => item.at === target.id ? { ...item, content: target.text } : item));
            setChatScrollRows(0);
          }, 80);
        }
        break;
      }
      case "tool_start":
        flushLive(); liveMessage.current = null;
        addUiMessage("assistant", `▸ ${event.summary}`, "tool");
        setLoader({ source: event.name === "run_sandbox_script" ? "Sandbox" : label, stage: event.summary });
        break;
      case "tool_progress":
        setLoader((current) => ({ source: current?.source ?? label, stage: event.stage }));
        break;
      case "tool_end":
        addUiMessage("assistant", `${event.ok ? "✓" : "✗"} ${event.summary}`, "tool");
        break;
      case "approval_request":
        setApproval(event); setApprovalIndex(approvalOptions(event).length - 1); setOverlay("approval");
        break;
      case "choice_request":
        setChoice({ id: event.id, question: event.question, options: event.options, allowCustom: event.allowCustom });
        setChoicePanel({ selectedIndex: 0, customActive: false, customText: "", customCursor: 0 });
        setOverlay("choice");
        break;
      case "steer_queued":
        setStatus("Queued · the agent will read it after its current step");
        break;
      case "compaction":
        if (event.phase === "start") setLoader((current) => ({ source: current?.source ?? label, stage: "Compacting conversation" }));
        else if (event.tokensBefore !== undefined) addUiMessage("assistant", `Compacted earlier conversation (${event.tokensBefore} → ${event.tokensAfter ?? 0} tokens).`, "editor");
        break;
      case "error":
        addUiMessage("assistant", event.message, "error");
        break;
      case "run_end": {
        flushLive();
        const live = liveMessage.current;
        liveMessage.current = null;
        setAgentRunning(false); setLoader(null); setApproval(null); setChoice(null);
        setOverlayState((current) => current === "approval" || current === "choice" ? null : current);
        if (event.reason === "done" && event.message) {
          if (!live || live.text.trim() !== event.message.trim()) addUiMessage("assistant", event.message, label);
          void projectRef.current?.addChat("assistant", event.message, label);
        }
        if (event.reason === "aborted") addUiMessage("assistant", "Stopped.", "editor");
        if (event.reason === "budget") addUiMessage("assistant", "Stopped at the spend limit. Raise it with /budget.", "editor");
        setStatus(event.reason === "done" ? `${label} · done` : event.reason === "error" ? `${label} request failed` : "Stopped");
        break;
      }
      default:
        break;
    }
  }, [addUiMessage, setOverlay]);
  useEffect(() => (engine ? engine.on(handleEngineEvent) : undefined), [engine, handleEngineEvent]);

  /** Build the agent for an open project, or null when no OpenRouter key is configured. */
  const createEngine = useCallback(async (state: EditorState, chatSeed: readonly ChatMessage[]) => {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) return null;
    modelsRef.current ??= createEditorModels({ apiKey });
    return Engine.create({
      state, registry, models: modelsRef.current, modelId: settingsRef.current.models.openrouter.text,
      session: new SessionStore(join(state.store.snapshot.projectDir, "agent", "session.jsonl")),
      getSettings: () => settingsRef.current, skills: await loadAgentSkills(), chatSeed,
    });
  }, [registry]);

  const actionContext = useCallback((state: EditorState, request: string, onStage: (stage: string) => void): ActionContext => ({
    state, settings: settingsRef.current, signal: new AbortController().signal, request,
    progress: (update) => onStage(update.stage), requestChoice: async () => null,
  }), []);

  const openVideo = useCallback(async (path: string, projectDirectory?: string) => {
    if (engineRef.current?.running) {
      addUiMessage("assistant", "The agent is working. Wait for it to finish, or press Esc to stop it, before opening another video.");
      return;
    }
    setLoader({ source: "Editor", stage: "Opening video" });
    setPlaying(false);
    try {
      const store = projectDirectory
        ? await ProjectStore.openProject(projectDirectory)
        : await ProjectStore.open(resolve(path));
      setLoader({ source: "Editor", stage: "Reading media details" });
      const state = await EditorState.open(store);
      const history = await store.chatHistory();
      await store.register();
      const nextEngine = await createEngine(state, history);
      setProject(store); setEditor(state); setEngine(nextEngine); setRevision((value) => value + 1);
      setMedia(state.media); setAssets([...state.assets]); setUsage(state.usage); setMessages(history);
      setSelection({ in: null, out: null }); currentTimeRef.current = 0; setCurrentTime(0);
      setStatus(`Opened ${store.name}`);
      addUiMessage("assistant", `Opened ${store.name} · ${state.media.width}x${state.media.height} · ${formatTime(state.media.duration)}`, "editor");
      if (!nextEngine) addUiMessage("assistant", "Add an OpenRouter API key with dumbeditor setup to talk to the agent. Slash commands still work.", "editor");
    } catch (error) { addUiMessage("assistant", errorMessage(error)); setStatus("Open failed"); }
    finally { setLoader(null); }
  }, [addUiMessage, createEngine]);

  const openProjectsBrowser = useCallback(async () => {
    setPlaying(false);
    setLoader({ source: "Editor", stage: "Loading saved projects" });
    try {
      const next = await ProjectStore.listProjects(project?.snapshot.sourcePath);
      setProjects(next);
      const active = next.findIndex((item) => item.projectDir.toLowerCase() === project?.snapshot.projectDir.toLowerCase());
      setProjectIndex(active >= 0 ? active : 0);
      setOverlay("projects");
      setStatus(`${next.length} saved project${next.length === 1 ? "" : "s"}`);
    } catch (error) {
      await answer(errorMessage(error));
      setStatus("Could not load projects");
    } finally {
      setLoader(null);
    }
  }, [answer, project, setOverlay]);

  useEffect(() => {
    if (didOpenInitialPath.current) return;
    didOpenInitialPath.current = true;
    if (initialPath) void openVideo(initialPath);
    else addUiMessage("assistant", "Open a video with /open <path>, or relaunch as: dumbeditor video.mp4");
  }, [initialPath, openVideo, addUiMessage]);
  // ffplay cannot change volume while running, so a volume change restarts it. Debounce
  // so a burst of +/- presses causes one restart instead of one gap per keypress.
  const [audioVolume, setAudioVolume] = useState(volume);
  useEffect(() => {
    const timer = setTimeout(() => setAudioVolume(volume), 400);
    return () => clearTimeout(timer);
  }, [volume]);
  useEffect(() => {
    if (!currentFile || !media?.hasAudio || !playing || layout.playerRows === 0) return;
    let stopped = false;
    const audio: ChildProcess | null = playAudio(currentFile, playbackStart(currentTimeRef.current, media.duration), audioVolume, (error) => {
      if (!stopped) setStatus(`Audio preview unavailable: ${error.message}`);
    });
    return () => { stopped = true; terminateProcess(audio); };
  }, [currentFile, media, playing, layout.playerRows, audioVolume]);

  const applyEdit = useCallback(async (edit: DirectEdit, request: string, source: LoaderState["source"]) => {
    if (!editor) throw new Error("Open a video first with /open <path>.");
    setLoader({ source, stage: "Preparing edit" });
    const { name, args } = directEditCall(edit);
    const result = await registry.run(name, args, actionContext(editor, request, (stage) => setLoader({ source, stage })));
    await answer(result.text);
    setStatus(`${source} · complete`);
  }, [actionContext, answer, editor, registry]);

  const changeVersion = useCallback(async (reference: string) => {
    if (!editor) return;
    setLoader({ source: "Editor", stage: "Loading saved version" }); setPlaying(false);
    try {
      const version = await editor.revertTo(reference);
      await answer(`Now on ${version.id}: ${version.action}`); setStatus(`Current ${version.id}`);
    } catch (error) { await answer(errorMessage(error)); setStatus("Revert failed"); }
    finally { setLoader(null); }
  }, [answer, editor]);

  const openModelPicker = useCallback(() => {
    modelRequest.current += 1;
    setPlaying(false);
    setModelPicker(initialModelPicker());
    setOverlay("model");
  }, []);

  const openMusicBrowser = useCallback(async (query: string) => {
    setPlaying(false);
    musicPreview.current?.stop();
    setPreviewMusicId(null);
    setMusicQuery(query);
    setMusicIndex(0);
    const saved = await readMusicSelection();
    setSelectedMusicId(saved.trackId);
    setOverlay("music");
  }, []);

  const openExportPanel = useCallback((requested: string) => {
    if (!project) return;
    const format: ExportFormat = extname(requested).toLowerCase() === ".mkv" ? "mkv" : "mp4";
    const destination = exportDestination(project.snapshot.sourcePath, requested || undefined, format);
    setPlaying(false);
    setExportPanel({ destination, cursor: destination.length, format, preset: "balanced", focus: "path" });
    setOverlay("export");
  }, [project]);

  const performExport = useCallback(async () => {
    if (!project) return;
    setLoader({ source: "Editor", stage: "Preparing export" });
    try {
      const result = await exportVideo({
        input: project.current.filePath,
        destination: exportPanel.destination,
        format: exportPanel.format,
        preset: exportPanel.preset,
        onStage: (stage) => setLoader({ source: "Editor", stage }),
      });
      setOverlay(null);
      await answer(`Exported ${result.path} · ${result.format.toUpperCase()} · ${formatBytes(result.bytes)}`);
      setStatus("Export complete");
    } catch (error) {
      await answer(errorMessage(error));
      setStatus("Export failed");
    } finally {
      setLoader(null);
    }
  }, [answer, exportPanel, project]);

  const loadModelChoices = useCallback(async (provider: ModelProvider, slot: ModelSlot) => {
    const request = ++modelRequest.current;
    setModelPicker((current) => ({ ...current, step: "models", provider, slot, models: [], query: "", selectedIndex: 0, loading: true, error: null }));
    setLoader({ source: "Editor", stage: `Loading ${provider} ${slot} models` });
    try {
      const models = await listProviderModels(provider, slot);
      if (request !== modelRequest.current) return;
      setModelPicker((current) => ({ ...current, step: "models", provider, slot, models, query: "", selectedIndex: 0, loading: false, error: null }));
    } catch (error) {
      if (request !== modelRequest.current) return;
      setModelPicker((current) => ({ ...current, step: "models", provider, slot, models: [], query: "", selectedIndex: 0, loading: false, error: errorMessage(error) }));
    } finally {
      if (request === modelRequest.current) setLoader(null);
    }
  }, []);

  const chooseModelPickerItem = useCallback(async () => {
    if (modelPicker.loading) return;
    if (modelPicker.step === "capability") {
      const capability = MODEL_CAPABILITIES[modelPicker.selectedIndex] ?? MODEL_CAPABILITIES[0]!;
      setModelPicker({ ...initialModelPicker(), step: "provider", capability: capability.id, slot: capability.slot });
      return;
    }
    if (modelPicker.step === "provider") {
      const capability = capabilityDefinition(modelPicker.capability);
      const provider = capability.providers[modelPicker.selectedIndex] ?? capability.providers[0]!;
      await loadModelChoices(provider, capability.slot);
      return;
    }
    if (!modelPicker.provider) return;
    if (modelPicker.error) { await loadModelChoices(modelPicker.provider, modelPicker.slot); return; }
    const selected = filteredPickerModels(modelPicker)[modelPicker.selectedIndex];
    if (!selected) return;
    setLoader({ source: "Editor", stage: "Saving model default" });
    try {
      const next = modelPicker.capability === "agent"
        ? await setBaseAgentModel(modelPicker.provider, selected.id)
        : await setDefaultModel(modelPicker.provider, modelPicker.slot, selected.id);
      setSettings(next);
      if (modelPicker.capability === "agent" && editor && !engineRef.current?.running) {
        settingsRef.current = next;
        setEngine(await createEngine(editor, []));
      }
      setOverlay(null);
      setStatus(`${selected.id} selected`);
      await answer(modelPicker.capability === "agent"
        ? `Base agent set to ${selected.id} through ${modelPicker.provider}.`
        : `Default ${modelPicker.provider} ${modelPicker.slot} model set to ${selected.id}.`);
    } catch (error) {
      setModelPicker((current) => ({ ...current, error: errorMessage(error) }));
    } finally {
      setLoader(null);
    }
  }, [answer, createEngine, editor, loadModelChoices, modelPicker]);

  const backModelPicker = useCallback(() => {
    modelRequest.current += 1;
    setLoader(null);
    if (modelPicker.step === "capability") { setOverlay(null); return; }
    if (modelPicker.step === "provider") {
      setModelPicker(initialModelPicker());
      return;
    }
    const capability = capabilityDefinition(modelPicker.capability);
    setModelPicker({
      ...initialModelPicker(),
      step: "provider",
      capability: modelPicker.capability,
      slot: modelPicker.slot,
      selectedIndex: Math.max(0, capability.providers.indexOf(modelPicker.provider ?? capability.providers[0]!)),
    });
  }, [modelPicker]);

  const handleCommand = useCallback(async (line: string) => {
    const space = line.indexOf(" ");
    const command = (space === -1 ? line : line.slice(0, space)).toLowerCase();
    const argument = unquoteArgument(space === -1 ? "" : line.slice(space + 1).trim());
    if (agentRunning && !SAFE_DURING_RUN.has(command)) { await answer("The agent is working. Wait for it to finish, or press Esc to stop it."); return; }
    if (command === "/quit" || command === "/exit") { exit(); return; }
    if (command === "/help") { setOverlay("help"); return; }
    if (command === "/clear") { setMessages([]); setOverlay(null); return; }
    if (command === "/chat") { toggleChatFocus(); return; }
    if (command === "/play") { if (media) setPlaying(true); return; }
    if (command === "/pause") { setCurrentTime(currentTimeRef.current); setPlaying(false); return; }
    if (command === "/open") { if (!argument) { await answer("Usage: /open <VIDEO PATH>"); return; } await openVideo(argument); return; }
    if (command === "/projects") { await openProjectsBrowser(); return; }
    if (command === "/model") { openModelPicker(); return; }
    if (command === "/bg-music") { await openMusicBrowser(argument); return; }
    if (command === "/permissions") {
      if (!argument) { await answer(`Agent permission mode: ${settings.agent.permissionMode}. Use /permissions ask or /permissions auto.`); return; }
      if (argument !== "ask" && argument !== "auto") { await answer("Usage: /permissions [ask|auto]"); return; }
      const next = await setAgentPermissionMode(argument);
      setSettings(next);
      await answer(`Agent permission mode set to ${argument}.`);
      return;
    }
    if (command === "/budget") {
      if (!argument) {
        const limit = settings.agent.spendCeilingUsd;
        await answer(limit > 0
          ? `Each agent run pauses to ask at ${formatUsd(limit)}. Use /budget <USD> to change it, or /budget 0 to turn it off.`
          : "There is no per-run spend limit. Use /budget <USD> to set one.");
        return;
      }
      const next = await setSpendCeiling(Number(argument));
      setSettings(next);
      await answer(next.agent.spendCeilingUsd > 0 ? `Per-run spend limit set to ${formatUsd(next.agent.spendCeilingUsd)}.` : "Per-run spend limit turned off.");
      return;
    }
    if (command === "/compact") {
      const current = engineRef.current;
      if (!current) { await answer("Open a video, with an OpenRouter key configured, first."); return; }
      setLoader({ source: "Editor", stage: "Compacting conversation" });
      try { await answer(await current.compact() ? "Compacted the earlier conversation." : "There is nothing to compact yet."); }
      finally { setLoader(null); }
      return;
    }
    if (!project || !media) { await answer("Open a video first with /open <path>."); return; }
    if (command === "/assets") {
      if (argument) { await answer("Usage: /assets"); return; }
      openAssetBrowser();
      return;
    }

    const direct = parseEditCommand(line, { duration: media.duration, currentTime: currentTimeRef.current, selection });
    if (direct) {
      setPlaying(false);
      try { await applyEdit(direct, line, "Command"); }
      catch (error) { await answer(errorMessage(error)); setStatus("Edit failed"); }
      finally { setLoader(null); }
      return;
    }
    if (command === "/version" || command === "/versions") {
      if (argument && argument.toLowerCase() !== "all") { await answer("Usage: /version [all]"); return; }
      setShowAllHistory(argument.toLowerCase() === "all"); setOverlay("history"); return;
    }
    if (command === "/version-limits") {
      if (!argument) { await answer(`Keeping up to ${project.versionLimit} rendered edit versions, plus the original source.`); return; }
      const limit = Number(argument);
      await project.setVersionLimit(limit); setRevision((value) => value + 1);
      await answer(`Version limit set to ${limit}. Older rendered versions were pruned.`); return;
    }
    if (command === "/status") { await answer(`${project.name} · ${project.current.id} · ${media.width}x${media.height} · ${formatTime(media.duration)} · ${project.snapshot.versions.length} versions · limit ${project.versionLimit}`); return; }
    if (command === "/undo") {
      const parent = project.current.parentId;
      if (!parent) { await answer("Already at the original version."); return; }
      await changeVersion(parent); return;
    }
    if (command === "/revert") { if (!argument) { await answer("Usage: /revert <VERSION>"); return; } await changeVersion(argument); return; }
    if (command === "/export") { openExportPanel(argument); return; }
    await answer(`Unknown command ${command}. Type / to see commands.`);
  }, [answer, applyEdit, changeVersion, exit, media, openAssetBrowser, openExportPanel, openModelPicker, openMusicBrowser, openProjectsBrowser, openVideo, project, selection, settings.agent.permissionMode, settings.agent.spendCeilingUsd, agentRunning, toggleChatFocus]);

  const submit = useCallback(async () => {
    const request = input.trim();
    if (!request || busy) return;
    if (request === "/" || (suggestions.length > 0 && !request.includes(" ") && suggestions[0]?.name !== request)) {
      const selected = suggestions[suggestionIndex] ?? suggestions[0];
      if (selected) { setInput(`${selected.name} `); setInputCursor(selected.name.length + 1); }
      return;
    }
    setInput(""); setInputCursor(0); setOverlay(null); addUiMessage("user", request);
    if (request.startsWith("/")) { try { await handleCommand(request); } catch (error) { await answer(errorMessage(error)); } return; }
    if (!project || !media || !editor) { await answer("Open a video first with /open <path>."); return; }
    const agent = engineRef.current;
    if (!agent) { await answer("Add an OpenRouter API key with dumbeditor setup to talk to the agent."); return; }

    // Text sent while the agent is running steers it; otherwise it starts a run.
    editor.setPlayhead(currentTimeRef.current);
    editor.setSelection(selection);
    try {
      if (!agent.running) {
        await project.nameFromFirstRequest(request);
        await project.register();
      }
      await project.addChat("user", request);
      agent.submit(request);
    } catch (error) { await answer(errorMessage(error)); setStatus(`${agentModel} request failed`); }
  }, [addUiMessage, agentModel, answer, busy, editor, handleCommand, input, media, project, selection, setOverlay, suggestionIndex, suggestions]);

  useInput((character, key) => {
    if (key.ctrl && character === "c") {
      if (engineRef.current?.running) engineRef.current.abort();
      else exit();
      return;
    }
    if (isFocusReport(character)) return;
    if (overlay === "approval") {
      if (!approval) return;
      const options = approvalOptions(approval);
      if (key.escape) { resolveApproval("deny"); return; }
      if (key.leftArrow || key.upArrow) { setApprovalIndex((value) => (value - 1 + options.length) % options.length); return; }
      if (key.rightArrow || key.downArrow || key.tab) { setApprovalIndex((value) => (value + 1) % options.length); return; }
      if (key.return) { resolveApproval(approvalDecision(approval, approvalIndex)); return; }
      return;
    }
    if (overlay === "choice" && choice) {
      if (key.escape) { resolveChoice(null); return; }
      if (key.tab && choice.allowCustom) {
        setChoicePanel((current) => ({ ...current, customActive: !current.customActive }));
        return;
      }
      if (key.upArrow || key.downArrow) {
        setChoicePanel((current) => ({
          ...current,
          customActive: false,
          selectedIndex: (current.selectedIndex + (key.upArrow ? -1 : 1) + choice.options.length) % choice.options.length,
        }));
        return;
      }
      if (key.return) {
        const answer = choicePanel.customActive ? choicePanel.customText.trim() : choice.options[choicePanel.selectedIndex];
        if (answer) resolveChoice(answer);
        return;
      }
      if (choicePanel.customActive) {
        if (key.leftArrow) { setChoicePanel((current) => ({ ...current, customCursor: Math.max(0, current.customCursor - 1) })); return; }
        if (key.rightArrow) { setChoicePanel((current) => ({ ...current, customCursor: Math.min(current.customText.length, current.customCursor + 1) })); return; }
        if (isBackspace(key)) {
          setChoicePanel((current) => current.customCursor === 0 ? current : {
            ...current,
            customText: current.customText.slice(0, current.customCursor - 1) + current.customText.slice(current.customCursor),
            customCursor: current.customCursor - 1,
          });
          return;
        }
        if (character && !key.ctrl && !key.meta && !key.tab) {
          const text = character.replace(/[\r\n]+/g, " ");
          setChoicePanel((current) => ({
            ...current,
            customText: current.customText.slice(0, current.customCursor) + text + current.customText.slice(current.customCursor),
            customCursor: current.customCursor + text.length,
          }));
        }
      } else if (choice.allowCustom && character && !key.ctrl && !key.meta && !key.tab) {
        const text = character.replace(/[\r\n]+/g, " ");
        setChoicePanel((current) => ({ ...current, customActive: true, customText: text, customCursor: text.length }));
      }
      return;
    }
    if (overlay === "projects") {
      if (key.escape || key.leftArrow) { setOverlay(null); return; }
      if (key.upArrow || key.downArrow || key.tab) {
        if (projects.length > 0) setProjectIndex((value) => (value + (key.upArrow ? -1 : 1) + projects.length) % projects.length);
        return;
      }
      if (key.return || key.rightArrow) {
        const selected = projects[projectIndex];
        if (selected) {
          setOverlay(null);
          void openVideo(selected.sourcePath, selected.projectDir);
        }
        return;
      }
      return;
    }
    if (overlay === "assets") {
      if (key.escape || (key.ctrl && character === "o")) { closeAssetBrowser(); return; }
      if (key.upArrow || key.downArrow) {
        terminateProcess(assetPreview.current);
        assetPreview.current = null;
        setAssetPlaying(false);
        if (assets.length > 0) setAssetIndex((value) => (value + (key.upArrow ? -1 : 1) + assets.length) % assets.length);
        return;
      }
      if (character === " ") {
        const asset = assets[assetIndex];
        if (!asset || !["audio", "music", "video"].includes(asset.kind)) return;
        if (assetPlaying) {
          terminateProcess(assetPreview.current);
          assetPreview.current = null;
          setAssetPlaying(false);
        } else {
          if (asset.kind === "video") {
            assetPreview.current = playAudio(asset.path, 0, volume, () => undefined);
            setAssetPlaying(true);
          } else {
            assetPreview.current = playAudio(asset.path, 0, volume, (error) => { setStatus(error.message); setAssetPlaying(false); });
            setAssetPlaying(assetPreview.current !== null);
            assetPreview.current?.once("close", () => setAssetPlaying(false));
          }
        }
        return;
      }
      if (character && !key.ctrl && !key.meta && !key.tab) {
        closeAssetBrowser();
        const text = character.replace(/[\r\n]+/g, " ");
        setInput(text);
        setInputCursor(text.length);
      }
      return;
    }
    if (overlay === "export") {
      if (key.escape) { if (!busy) setOverlay(null); return; }
      if (busy) return;
      if (key.return) { void performExport(); return; }
      if (key.tab) {
        setExportPanel((current) => ({ ...current, focus: cycleExportFocus(current.focus, key.shift ? -1 : 1) }));
        return;
      }
      if (exportPanel.focus === "format") {
        if (key.leftArrow || key.upArrow || key.rightArrow || key.downArrow) {
          const direction = key.leftArrow || key.upArrow ? -1 : 1;
          setExportPanel((current) => {
            const format = cycleChoice(EXPORT_FORMATS, current.format, direction);
            const destination = exportDestination(project?.snapshot.sourcePath ?? current.destination, current.destination, format);
            return { ...current, format, destination, cursor: Math.min(current.cursor, destination.length) };
          });
        }
        return;
      }
      if (exportPanel.focus === "compression") {
        if (key.leftArrow || key.upArrow || key.rightArrow || key.downArrow) {
          const direction = key.leftArrow || key.upArrow ? -1 : 1;
          setExportPanel((current) => ({ ...current, preset: cycleChoice(EXPORT_PRESETS, current.preset, direction) }));
        }
        return;
      }
      if (key.ctrl && character === "a") { setExportPanel((current) => ({ ...current, cursor: 0 })); return; }
      if (key.ctrl && character === "e") { setExportPanel((current) => ({ ...current, cursor: current.destination.length })); return; }
      if (key.ctrl && character === "u") { setExportPanel((current) => ({ ...current, destination: "", cursor: 0 })); return; }
      if (key.leftArrow) { setExportPanel((current) => ({ ...current, cursor: Math.max(0, current.cursor - 1) })); return; }
      if (key.rightArrow) { setExportPanel((current) => ({ ...current, cursor: Math.min(current.destination.length, current.cursor + 1) })); return; }
      if (isBackspace(key)) {
        setExportPanel((current) => current.cursor === 0 ? current : {
          ...current,
          destination: current.destination.slice(0, current.cursor - 1) + current.destination.slice(current.cursor),
          cursor: current.cursor - 1,
        });
        return;
      }
      if (character && !key.ctrl && !key.meta && !key.tab) {
        const text = character.replace(/[\r\n]+/g, " ");
        setExportPanel((current) => ({ ...current,
          destination: current.destination.slice(0, current.cursor) + text + current.destination.slice(current.cursor),
          cursor: current.cursor + text.length,
        }));
      }
      return;
    }
    if (overlay === "music") {
      if (key.escape || key.leftArrow) { musicPreview.current?.stop(); setPreviewMusicId(null); setOverlay(null); return; }
      if (key.upArrow || key.downArrow || key.tab) {
        if (musicTracks.length > 0) setMusicIndex((value) => (value + (key.upArrow ? -1 : 1) + musicTracks.length) % musicTracks.length);
        return;
      }
      if (character === " ") {
        const track = musicTracks[musicIndex];
        if (!track) return;
        if (previewMusicId === track.id) { musicPreview.current?.stop(); setPreviewMusicId(null); }
        else {
          try {
            musicPreview.current?.play(track.id, {
              volume,
              onEnd: () => setPreviewMusicId(null),
              onError: (error) => { setPreviewMusicId(null); setStatus(error.message); },
            });
            setPreviewMusicId(track.id);
          } catch (error) { setStatus(errorMessage(error)); }
        }
        return;
      }
      if (key.return || key.rightArrow) {
        const track = musicTracks[musicIndex];
        if (track) void selectMusicTrack(track.id).then(() => {
          musicPreview.current?.stop(); setPreviewMusicId(null); setSelectedMusicId(track.id); setOverlay(null);
          setStatus(`${track.title} selected`); void answer(`${track.title} selected. Ask ${agentModel} to add the selected background music.`);
        }).catch((error) => setStatus(errorMessage(error)));
        return;
      }
      if (key.ctrl && character === "k") { void clearMusicSelection().then(() => { setSelectedMusicId(null); setStatus("Background music selection cleared"); }); return; }
      if (key.ctrl && character === "u") { setMusicQuery(""); setMusicIndex(0); return; }
      if (isBackspace(key)) { setMusicQuery((value) => value.slice(0, -1)); setMusicIndex(0); return; }
      if (character && !key.ctrl && !key.meta && !key.tab) { setMusicQuery((value) => value + character.replace(/[\r\n]+/g, " ")); setMusicIndex(0); }
      return;
    }
    if (overlay === "model") {
      if (key.escape || key.leftArrow) { backModelPicker(); return; }
      if (!modelOverlayReady) return;
      if (modelPicker.loading || busy) return;
      if (key.upArrow || key.downArrow || key.tab) {
        setModelPicker((current) => {
          const count = current.step === "capability" ? MODEL_CAPABILITIES.length : current.step === "provider"
            ? capabilityDefinition(current.capability).providers.length
            : filteredPickerModels(current).length;
          if (count === 0) return current;
          const direction = key.upArrow ? -1 : 1;
          return { ...current, selectedIndex: (current.selectedIndex + direction + count) % count };
        });
        return;
      }
      if (key.return || key.rightArrow) { void chooseModelPickerItem(); return; }
      if (modelPicker.step === "models") {
        if (isBackspace(key)) {
          setModelPicker((current) => ({ ...current, query: current.query.slice(0, -1), selectedIndex: 0 }));
          return;
        }
        if (key.ctrl && character === "a") {
          setModelPicker((current) => ({ ...current, query: "", selectedIndex: 0 }));
          return;
        }
        if (character && !key.ctrl && !key.meta && !key.tab) {
          const text = character.replace(/[\r\n]+/g, " ");
          setModelPicker((current) => ({ ...current, query: current.query + text, selectedIndex: 0 }));
        }
      }
      return;
    }
    if (key.ctrl && character.toLowerCase() === "g") { toggleChatFocus(); return; }
    if (key.escape) {
      if (overlay) setOverlay(null);
      else if (chatFocused) setChatFocused(false);
      else if (agentRunning && input.length === 0) engineRef.current?.abort();
      else { setInput(""); setInputCursor(0); }
      return;
    }
    if (key.pageUp) { setChatScrollRows((value) => value + chatPageRows); return; }
    if (key.pageDown) { setChatScrollRows((value) => Math.max(0, value - chatPageRows)); return; }
    if (busy) {
      if (key.upArrow) { setChatScrollRows((value) => value + 1); return; }
      if (key.downArrow) { setChatScrollRows((value) => Math.max(0, value - 1)); return; }
      if (!videoMutationActive && key.leftArrow) { setPlaying(false); movePlayhead(currentTimeRef.current - 5); return; }
      if (!videoMutationActive && key.rightArrow) { setPlaying(false); movePlayhead(currentTimeRef.current + 5); return; }
      if (!videoMutationActive && key.ctrl && character === "p") {
        if (media) {
          if (playing) setCurrentTime(currentTimeRef.current);
          setPlaying((value) => !value);
        }
        return;
      }
      if (character === "+" || character === "=") { setVolume((value) => Math.min(100, value + 5)); return; }
      if (character === "-") { setVolume((value) => Math.max(0, value - 5)); return; }
      return;
    }
    if (key.ctrl && character === "o") {
      openAssetBrowser();
      return;
    }
    if (key.tab && suggestions.length > 0) {
      const selected = suggestions[suggestionIndex] ?? suggestions[0];
      if (selected) { setInput(`${selected.name} `); setInputCursor(selected.name.length + 1); }
      return;
    }
    if (key.return) { void submit(); return; }
    if (key.ctrl && character === "a") { setInputCursor(0); return; }
    if (key.ctrl && character === "e") { setInputCursor(input.length); return; }
    if (isBackspace(key)) { if (inputCursor > 0) { setInput((value) => value.slice(0, inputCursor - 1) + value.slice(inputCursor)); setInputCursor((value) => value - 1); } return; }
    if (key.leftArrow) { if (input.length > 0) setInputCursor((value) => Math.max(0, value - 1)); else { setPlaying(false); movePlayhead(currentTimeRef.current - 5); } return; }
    if (key.rightArrow) { if (input.length > 0) setInputCursor((value) => Math.min(input.length, value + 1)); else { setPlaying(false); movePlayhead(currentTimeRef.current + 5); } return; }
    if (key.upArrow) {
      if (suggestions.length > 0) setSuggestionIndex((value) => (value - 1 + suggestions.length) % suggestions.length);
      else if (input.length > 0) setInputCursor((value) => moveInputCursorVertically(input, value, inputMetrics.capacity, -1));
      else setChatScrollRows((value) => value + 1);
      return;
    }
    if (key.downArrow) {
      if (suggestions.length > 0) setSuggestionIndex((value) => (value + 1) % suggestions.length);
      else if (input.length > 0) setInputCursor((value) => moveInputCursorVertically(input, value, inputMetrics.capacity, 1));
      else setChatScrollRows((value) => Math.max(0, value - 1));
      return;
    }
    if (key.ctrl && character === "p") { if (media) { if (playing) setCurrentTime(currentTimeRef.current); setPlaying((value) => !value); } return; }
    if (input.length === 0 && (character === "+" || character === "=")) { setVolume((value) => Math.min(100, value + 5)); return; }
    if (input.length === 0 && character === "-") { setVolume((value) => Math.max(0, value - 5)); return; }
    if (character === "[" && input.length === 0) { setSelection((value) => ({ ...value, in: currentTimeRef.current })); return; }
    if (character === "]" && input.length === 0) { setSelection((value) => ({ ...value, out: currentTimeRef.current })); return; }
    if (character && !key.ctrl && !key.meta && !key.tab) {
      const text = character.replace(/[\r\n]+/g, " ");
      setInput((value) => value.slice(0, inputCursor) + text + value.slice(inputCursor)); setInputCursor((value) => value + text.length);
    }
  });

  const chatView = useMemo(
    () => chatViewport(messages, agentModel, Math.max(16, terminal.columns - 3), Math.max(1, visibleConversationRows - 1), chatScrollRows),
    [agentModel, chatScrollRows, messages, terminal.columns, visibleConversationRows],
  );
  useEffect(() => {
    if (chatScrollRows > chatView.maxScroll) setChatScrollRows(chatView.maxScroll);
  }, [chatScrollRows, chatView.maxScroll]);
  const versions = useMemo(() => project?.history(showAllHistory ? project.snapshot.versions.length : 8) ?? [], [project, revision, showAllHistory]);
  const sidebarVersions = useMemo(() => project?.history(Number.POSITIVE_INFINITY) ?? [], [project, revision]);
  const suggestionCapacity = Math.max(1, visibleConversationRows - 1);
  const suggestionStart = Math.min(
    Math.max(0, suggestionIndex - suggestionCapacity + 1),
    Math.max(0, suggestions.length - suggestionCapacity),
  );
  const visibleSuggestions = suggestions.slice(suggestionStart, suggestionStart + suggestionCapacity);
  const conversationPanel = suggestions.length > 0 ? (
    <Box flexDirection="column" height={visibleConversationRows} minHeight={visibleConversationRows} overflow="hidden">
      <Box height={1} minHeight={1} justifyContent="space-between">
        <Text bold color="cyan">Commands</Text>
        <Text dimColor>{suggestionStart + 1}-{suggestionStart + visibleSuggestions.length} / {suggestions.length} · ↑/↓ select · Tab complete</Text>
      </Box>
      {visibleSuggestions.map((command, offset) => (
        <Text key={command.name} {...(suggestionStart + offset === suggestionIndex ? { color: "cyan" as const, inverse: true } : {})} wrap="truncate-end">
          {suggestionStart + offset === suggestionIndex ? "› " : "  "}{command.usage}  <Text dimColor>{command.description}</Text>
        </Text>
      ))}
    </Box>
  ) : <ChatPanel {...chatView} height={visibleConversationRows} width={terminal.columns - 2} focused={chatFocused} />;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="magenta">DumbEditor</Text>
        {loader
          ? <Text color={loader.source === "Sandbox" ? "cyan" : "yellow"} wrap="truncate-end">
              {LOADER_MARK} {loader.source === "Sandbox" ? "⬡ SANDBOX" : loader.source} · {loader.stage}{videoMutationActive ? " · video updating" : ""}
            </Text>
          : <Text dimColor wrap="truncate-end">{project ? `${project.name} · ${project.current.id}` : "No video"}</Text>}
      </Box>
      {chatFocused ? conversationPanel : <>
        <Box height={layout.playerRows} minHeight={layout.playerRows} flexDirection="row">
        {overlay === "help" ? <Help model={agentModel} /> : overlay === "history" && project ? <History versions={versions} currentId={project.current.id} />
          : overlay === "model" ? modelOverlayReady
            ? <ModelPanel picker={modelPicker} settings={settings} keys={providerKeyStatus()}
              width={terminal.columns - 2} height={layout.playerRows} />
            : <Box width={terminal.columns - 2} height={layout.playerRows} />
          : overlay === "music" ? <MusicPanel tracks={musicTracks} query={musicQuery} selectedIndex={musicIndex}
              selectedId={selectedMusicId} previewId={previewMusicId} width={terminal.columns - 2} height={layout.playerRows} />
          : overlay === "export" ? <ExportPanel state={exportPanel} width={terminal.columns - 2} height={layout.playerRows} />
          : overlay === "projects" ? <ProjectsPanel projects={projects} selectedIndex={projectIndex}
              {...(project ? { activeProjectDir: project.snapshot.projectDir } : {})}
              width={terminal.columns - 2} height={layout.playerRows} />
          : overlay === "assets" ? <AssetPanel assets={assets} selectedIndex={assetIndex} playing={assetPlaying}
              onPlaybackEnd={stopAssetPlayback}
              width={terminal.columns - 2} height={layout.playerRows} />
          : overlay === "approval" && approval ? <ApprovalPanel request={approval} options={approvalOptions(approval)} selectedIndex={approvalIndex}
              width={terminal.columns - 2} height={layout.playerRows} />
          : overlay === "choice" && choice ? <ChoicePanel request={choice} state={choicePanel}
              width={terminal.columns - 2} height={layout.playerRows} />
          : <>
            {layout.leftSidebarColumns > 0 && <ProjectSidebar versions={sidebarVersions} currentId={project?.current.id ?? ""}
              projectName={project?.name ?? "No project"}
              model={settings.models[settings.agent.provider].text} permissionMode={settings.agent.permissionMode} usage={usage} versionLimit={project?.versionLimit ?? 5}
              width={layout.leftSidebarColumns} height={layout.playerRows} />}
            <VideoSurface {...(currentFile ? { filePath: currentFile } : {})} media={media} playing={playing} time={currentTime}
              columns={layout.videoColumns} rows={layout.playerRows} topRow={2} leftColumn={2 + layout.leftSidebarColumns}
              timelineColumns={layout.videoColumns} timelineLeftColumn={2 + layout.leftSidebarColumns} selection={selection}
              repaintKey={previewRefresh}
              onTime={updatePreviewTime} onEnd={handlePreviewEnd} onError={handlePreviewError} />
            {layout.rightSidebarColumns > 0 && <AssetsSidebar assets={assets} usage={usage}
              width={layout.rightSidebarColumns} height={layout.playerRows} />}
          </>}
        </Box>
        <Box height={1} minHeight={1} flexDirection="row">
          {layout.leftSidebarColumns > 0 && <Box width={layout.leftSidebarColumns} />}
          <Box width={layout.videoColumns} justifyContent="center">
            {media ? <Timeline current={currentTime} duration={media.duration} selection={selection} width={layout.videoColumns} /> : <Text> </Text>}
          </Box>
          {layout.rightSidebarColumns > 0 && <Box width={layout.rightSidebarColumns} />}
        </Box>
        <Box height={1} minHeight={1} justifyContent="space-between">
          <Text dimColor wrap="truncate-end">{playing ? "▶ playing" : "Ⅱ paused"} · volume {volume}%{selection.in !== null ? ` · in ${formatTime(selection.in)}` : ""}{selection.out !== null ? ` · out ${formatTime(selection.out)}` : ""}</Text>
          <Text dimColor wrap="truncate-end">{controlsHint}</Text>
        </Box>
        {conversationPanel}
      </>}
      {overlay ? <Box height={3} minHeight={3} borderStyle="round" borderColor={overlay === "approval" ? "yellow" : "gray"} paddingX={1} overflow="hidden">
            <Text color={overlay === "approval" ? "yellow" : "cyan"} wrap="truncate-end">{overlayHint(overlay)}</Text>
          </Box>
        : <InputPanel value={input} cursor={inputCursor} width={terminal.columns - 2} busy={busy} />}
      <Box height={1} minHeight={1} overflow="hidden">
        <Text dimColor wrap="truncate-end">{loader
          ? `${loader.source} is working · ${agentModel} ${formatUsd(usage.lunaUsd)} · Assets ${formatUsd(usage.assetUsd)} · Total ${formatUsd(usage.totalUsd)} · ${agentRunning ? "Enter steers · Esc stops" : videoMutationActive ? "video updating · ↑/↓ chat" : "↑/↓ chat · ←/→ seek · Ctrl+P play"}`
          : `${status} · ${agentModel} ${formatUsd(usage.lunaUsd)} · Assets ${formatUsd(usage.assetUsd)} · Total ${formatUsd(usage.totalUsd)} · Enter to send · Ctrl+C to quit`}</Text>
      </Box>
    </Box>
  );
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function overlayHint(overlay: Exclude<Overlay, null>): string {
  if (overlay === "model") return "Model picker active · use the keyboard in the popup";
  if (overlay === "music") return "Music browser active · search, preview, and select in the popup";
  if (overlay === "export") return "Export popup active · choose format and compression";
  if (overlay === "projects") return "Project browser active · choose a saved editing session";
  if (overlay === "assets") return "Asset browser active · browse, preview, or type to return to chat";
  if (overlay === "approval") return "Approval required · review the request above";
  if (overlay === "choice") return "Choice picker active · select an option or type a custom answer";
  return "Panel active · Esc closes";
}
function unquoteArgument(value: string): string {
  const first = value[0];
  return value.length >= 2 && (first === "'" || first === "\"") && value.at(-1) === first ? value.slice(1, -1) : value;
}

function cycleExportFocus(current: ExportFocus, direction: number): ExportFocus {
  return cycleChoice(["path", "format", "compression"] as const, current, direction);
}

function cycleChoice<T extends string>(choices: readonly T[], current: T, direction: number): T {
  const index = Math.max(0, choices.indexOf(current));
  return choices[(index + direction + choices.length) % choices.length] ?? current;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
