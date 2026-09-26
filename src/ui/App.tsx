import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extname, resolve } from "node:path";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import type { ChildProcess } from "node:child_process";
import type { ChatMessage, DirectEdit, MediaInfo, Selection } from "../types.js";
import { AgentWorkspace, type AgentAsset } from "../core/agent-workspace.js";
import type { ApprovalRequest, RequestApproval } from "../core/approval.js";
import type { ChoiceRequest, RequestChoice } from "../core/choice.js";
import { runEditorAgent } from "../core/agent-runtime.js";
import { commandSuggestions, parseEditCommand } from "../core/commands.js";
import { providerKeyStatus } from "../core/config.js";
import { executeDirectEdit } from "../core/editor.js";
import { EXPORT_FORMATS, EXPORT_PRESETS, exportDestination, exportVideo, type ExportFormat } from "../core/export.js";
import { playAudio, probeMedia } from "../core/media.js";
import { listMusicTracks, searchMusicTracks } from "../core/music-catalog.js";
import { clearMusicSelection, MusicPreviewController, readMusicSelection, selectMusicTrack } from "../core/music.js";
import { listProviderModels } from "../core/models.js";
import { ProjectStore, type ProjectSummary } from "../core/project.js";
import { terminateProcess, terminateRunningProcesses } from "../core/process.js";
import { DEFAULT_SETTINGS, OPENAI_SLOTS, OPENROUTER_SLOTS, readSettings, setAgentPermissionMode, setClaudeHarnessModel, setDefaultModel, type DumbEditorSettings, type ModelProvider, type ModelSlot } from "../core/settings.js";
import { formatTime } from "../core/time.js";
import { EMPTY_USAGE_SUMMARY, formatUsd, type UsageSummary } from "../core/usage.js";
import { AssetPanel } from "./AssetPanel.js";
import { ChatPanel } from "./ChatPanel.js";
import { ApprovalPanel } from "./ApprovalPanel.js";
import { ChoicePanel, type ChoicePanelState } from "./ChoicePanel.js";
import { Help } from "./Help.js";
import { History } from "./History.js";
import { InputPanel } from "./InputPanel.js";
import { editorLayout } from "./layout.js";
import { ExportPanel, type ExportFocus, type ExportPanelState } from "./ExportPanel.js";
import { filteredPickerModels, initialModelPicker, ModelPanel, type ModelPickerState } from "./ModelPanel.js";
import { MusicPanel } from "./MusicPanel.js";
import { ProjectsPanel } from "./ProjectsPanel.js";
import { AssetsSidebar, ProjectSidebar } from "./Sidebars.js";
import { Timeline } from "./Timeline.js";
import { chatViewport, inputViewport, moveInputCursorVertically } from "./text-layout.js";
import { clearRetainedTerminalLayer } from "./terminal-layers.js";
import { activePreviewBackend, VideoSurface } from "./VideoSurface.js";

type Overlay = "help" | "history" | "model" | "music" | "export" | "assets" | "projects" | "approval" | "choice" | null;
interface LoaderState { source: string; stage: string }
const LOADER_MARK = "◐";

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
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [approvalAllow, setApprovalAllow] = useState(false);
  const approvalResolver = useRef<((allowed: boolean) => void) | null>(null);
  const [choice, setChoice] = useState<ChoiceRequest | null>(null);
  const [choicePanel, setChoicePanel] = useState<ChoicePanelState>({ selectedIndex: 0, customActive: false, customText: "", customCursor: 0 });
  const choiceResolver = useRef<((answer: string | null) => void) | null>(null);
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const assetPreview = useRef<ChildProcess | null>(null);
  const [overlay, setOverlayState] = useState<Overlay>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [settings, setSettings] = useState<DumbEditorSettings>(() => structuredClone(DEFAULT_SETTINGS));
  const [settingsReady, setSettingsReady] = useState(false);
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

  const busy = loader !== null;
  const previewBackend = useMemo(() => activePreviewBackend(), []);
  const inputMetrics = useMemo(() => inputViewport(input, inputCursor, Math.max(8, terminal.columns - 6)), [input, inputCursor, terminal.columns]);
  const layout = useMemo(() => editorLayout(terminal, media, previewBackend, inputMetrics.rows), [terminal, media, previewBackend, inputMetrics.rows]);
  const suggestions = useMemo(() => commandSuggestions(input), [input]);
  const musicTracks = useMemo(() => musicQuery.trim() ? searchMusicTracks(musicQuery) : listMusicTracks(), [musicQuery]);
  const currentFile = project?.current.filePath;
  const agentModel = settingsReady ? settings.models.openai.text : "editor model";
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
  useEffect(() => () => { musicPreview.current?.dispose(); terminateProcess(assetPreview.current); terminateRunningProcesses(); }, []);
  useEffect(() => {
    void readSettings()
      .then((value) => { setSettings(value); setSettingsReady(true); })
      .catch((error) => { setSettingsReady(true); setStatus(errorMessage(error)); });
  }, []);
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
  const requestApproval = useCallback<RequestApproval>((request) => new Promise<boolean>((resolve) => {
    approvalResolver.current?.(false);
    approvalResolver.current = resolve;
    setApproval(request);
    setApprovalAllow(false);
    setOverlay("approval");
  }), []);
  const resolveApproval = useCallback((allowed: boolean) => {
    const resolve = approvalResolver.current;
    approvalResolver.current = null;
    setApproval(null);
    setApprovalAllow(false);
    setOverlay(null);
    resolve?.(allowed);
  }, []);
  const requestChoice = useCallback<RequestChoice>((request) => new Promise<string | null>((resolve) => {
    choiceResolver.current?.(null);
    choiceResolver.current = resolve;
    setChoice(request);
    setChoicePanel({ selectedIndex: 0, customActive: false, customText: "", customCursor: 0 });
    setOverlay("choice");
  }), []);
  const resolveChoice = useCallback((answer: string | null) => {
    const resolve = choiceResolver.current;
    choiceResolver.current = null;
    setChoice(null);
    setOverlay(null);
    resolve?.(answer);
  }, []);

  const refreshProjectData = useCallback(async (store: ProjectStore) => {
    const workspace = new AgentWorkspace(store.createAgentWorkspace());
    const [nextAssets, nextUsage] = await Promise.all([workspace.assets(), store.usageSummary()]);
    setAssets(nextAssets);
    setUsage(nextUsage);
    setAssetIndex((value) => Math.max(0, Math.min(value, nextAssets.length - 1)));
  }, []);

  const openVideo = useCallback(async (path: string, projectDirectory?: string) => {
    setLoader({ source: "Editor", stage: "Opening video" });
    setPlaying(false);
    try {
      const store = projectDirectory
        ? await ProjectStore.openProject(projectDirectory)
        : await ProjectStore.open(resolve(path));
      setLoader({ source: "Editor", stage: "Reading media details" });
      const nextMedia = await probeMedia(store.current.filePath);
      const history = await store.chatHistory();
      await Promise.all([refreshProjectData(store), store.register()]);
      setProject(store); setRevision((value) => value + 1); setMedia(nextMedia); setMessages(history);
      setSelection({ in: null, out: null }); currentTimeRef.current = 0; setCurrentTime(0);
      setStatus(`Opened ${store.name}`);
      addUiMessage("assistant", `Opened ${store.name} · ${nextMedia.width}x${nextMedia.height} · ${formatTime(nextMedia.duration)}`, "editor");
    } catch (error) { addUiMessage("assistant", errorMessage(error)); setStatus("Open failed"); }
    finally { setLoader(null); }
  }, [addUiMessage, refreshProjectData]);

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
  useEffect(() => {
    if (!currentFile || !media?.hasAudio || !playing || layout.playerRows === 0) return;
    let stopped = false;
    const audio: ChildProcess | null = playAudio(currentFile, currentTimeRef.current, volume, (error) => {
      if (!stopped) setStatus(`Audio preview unavailable: ${error.message}`);
    });
    return () => { stopped = true; terminateProcess(audio); };
  }, [currentFile, media, playing, layout.playerRows, volume]);

  const applyEdit = useCallback(async (edit: DirectEdit, request: string, source: LoaderState["source"]) => {
    if (!project) throw new Error("Open a video first with /open <path>.");
    setLoader({ source, stage: "Preparing edit" });
    const result = await executeDirectEdit(project, edit, request, (stage) => setLoader({ source, stage }));
    setMedia(result.media); setRevision((value) => value + 1); movePlayhead(0); setSelection({ in: null, out: null });
    await answer(`${result.version.id} · ${result.version.action}`);
    setStatus(`${source} · complete`);
  }, [answer, movePlayhead, project]);

  const changeVersion = useCallback(async (reference: string) => {
    if (!project) return;
    setLoader({ source: "Editor", stage: "Loading saved version" }); setPlaying(false);
    try {
      const version = await project.revert(reference); const nextMedia = await probeMedia(version.filePath);
      setMedia(nextMedia); setRevision((value) => value + 1); movePlayhead(0);
      await answer(`Now on ${version.id}: ${version.action}`); setStatus(`Current ${version.id}`);
    } catch (error) { await answer(errorMessage(error)); setStatus("Revert failed"); }
    finally { setLoader(null); }
  }, [answer, movePlayhead, project]);

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
    setModelPicker({ step: "models", provider, slot, models: [], query: "", selectedIndex: 0, loading: true, error: null });
    setLoader({ source: "Editor", stage: `Loading ${provider} ${slot} models` });
    try {
      const models = await listProviderModels(provider, slot);
      if (request !== modelRequest.current) return;
      setModelPicker({ step: "models", provider, slot, models, query: "", selectedIndex: 0, loading: false, error: null });
    } catch (error) {
      if (request !== modelRequest.current) return;
      setModelPicker({ step: "models", provider, slot, models: [], query: "", selectedIndex: 0, loading: false, error: errorMessage(error) });
    } finally {
      if (request === modelRequest.current) setLoader(null);
    }
  }, []);

  const chooseModelPickerItem = useCallback(async () => {
    if (modelPicker.loading) return;
    if (modelPicker.step === "provider") {
      setModelPicker({ ...initialModelPicker(), step: "slot", provider: modelPicker.selectedIndex === 0 ? "openai" : "openrouter" });
      return;
    }
    if (modelPicker.step === "slot") {
      const slots = modelPicker.provider === "openai" ? OPENAI_SLOTS : OPENROUTER_SLOTS;
      const slot = slots[modelPicker.selectedIndex] ?? "text";
      await loadModelChoices(modelPicker.provider ?? "openai", slot);
      return;
    }
    if (!modelPicker.provider) return;
    if (modelPicker.error) { await loadModelChoices(modelPicker.provider, modelPicker.slot); return; }
    const selected = filteredPickerModels(modelPicker)[modelPicker.selectedIndex];
    if (!selected) return;
    setLoader({ source: "Editor", stage: "Saving model default" });
    try {
      const next = await setDefaultModel(modelPicker.provider, modelPicker.slot, selected.id);
      setSettings(next);
      setOverlay(null);
      setStatus(`${selected.id} selected`);
      await answer(`Default ${modelPicker.provider} ${modelPicker.slot} model set to ${selected.id}.`);
    } catch (error) {
      setModelPicker((current) => ({ ...current, error: errorMessage(error) }));
    } finally {
      setLoader(null);
    }
  }, [answer, loadModelChoices, modelPicker]);

  const backModelPicker = useCallback(() => {
    modelRequest.current += 1;
    setLoader(null);
    if (modelPicker.step === "provider") { setOverlay(null); return; }
    if (modelPicker.step === "slot") {
      setModelPicker(initialModelPicker());
      return;
    }
    setModelPicker({ ...initialModelPicker(), step: "slot", provider: modelPicker.provider });
  }, [modelPicker]);

  const handleCommand = useCallback(async (line: string) => {
    const space = line.indexOf(" ");
    const command = (space === -1 ? line : line.slice(0, space)).toLowerCase();
    const argument = unquoteArgument(space === -1 ? "" : line.slice(space + 1).trim());
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
    if (command === "/harness-model") {
      if (!argument) { await answer(`Claude harness model: ${settings.agent.claudeModel}`); return; }
      const next = await setClaudeHarnessModel(argument);
      setSettings(next);
      await answer(`Claude harness model set to ${next.agent.claudeModel}.`);
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
  }, [answer, applyEdit, changeVersion, exit, media, openAssetBrowser, openExportPanel, openModelPicker, openMusicBrowser, openProjectsBrowser, openVideo, project, selection, settings.agent.claudeModel, settings.agent.permissionMode, toggleChatFocus]);

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
    if (!project || !media) { await answer("Open a video first with /open <path>."); return; }

    setPlaying(false); setLoader({ source: agentModel, stage: "Understanding your request" });
    try {
      await project.nameFromFirstRequest(request);
      await project.register();
      await project.addChat("user", request);
      const before = project.current.id;
      const result = await runEditorAgent({
        request, store: project, media, currentTime: currentTimeRef.current, selection,
        requestApproval, requestChoice,
        onCost: (kind, costUsd) => setUsage((current) => ({
          totalUsd: current.totalUsd + costUsd,
          lunaUsd: current.lunaUsd + (kind === "luna" ? costUsd : 0),
          assetUsd: current.assetUsd + (kind === "asset" ? costUsd : 0),
          harnessUsd: current.harnessUsd + (kind === "harness" ? costUsd : 0),
          entries: current.entries + 1,
        })),
        onStage: (stage) => setLoader(stage.startsWith("SANDBOX · ")
          ? { source: "Sandbox", stage: stage.slice("SANDBOX · ".length) }
          : { source: agentModel, stage }),
      });
      await refreshProjectData(project);
      if (result.versionId !== before) {
        setMedia(result.media); setRevision((value) => value + 1); movePlayhead(0); setSelection({ in: null, out: null });
      }
      setLoader({ source: agentModel, stage: "Writing response" });
      await answer(result.message, result.model); setStatus(`${result.model} · ${result.toolCalls} tools`);
    } catch (error) { await answer(errorMessage(error)); setStatus(`${agentModel} request failed`); }
    finally { setLoader(null); }
  }, [addUiMessage, agentModel, answer, busy, handleCommand, input, media, movePlayhead, project, refreshProjectData, requestApproval, requestChoice, selection, suggestionIndex, suggestions]);

  useInput((character, key) => {
    if (key.ctrl && character === "c") { exit(); return; }
    if (character.includes("\u001B[I") || character.includes("\u001B[O")) return;
    if (overlay === "approval") {
      if (key.escape) { resolveApproval(false); return; }
      if (key.leftArrow || key.rightArrow || key.tab) { setApprovalAllow((value) => !value); return; }
      if (key.return) { resolveApproval(approvalAllow); return; }
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
        if (key.backspace) {
          setChoicePanel((current) => current.customCursor === 0 ? current : {
            ...current,
            customText: current.customText.slice(0, current.customCursor - 1) + current.customText.slice(current.customCursor),
            customCursor: current.customCursor - 1,
          });
          return;
        }
        if (key.delete) {
          setChoicePanel((current) => ({ ...current, customText: current.customText.slice(0, current.customCursor) + current.customText.slice(current.customCursor + 1) }));
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
      if (key.escape || (key.shift && character.toLowerCase() === "a")) { closeAssetBrowser(); return; }
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
      if (key.backspace) {
        setExportPanel((current) => current.cursor === 0 ? current : {
          ...current,
          destination: current.destination.slice(0, current.cursor - 1) + current.destination.slice(current.cursor),
          cursor: current.cursor - 1,
        });
        return;
      }
      if (key.delete) {
        setExportPanel((current) => ({ ...current, destination: current.destination.slice(0, current.cursor) + current.destination.slice(current.cursor + 1) }));
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
      if (key.delete) { void clearMusicSelection().then(() => { setSelectedMusicId(null); setStatus("Background music selection cleared"); }); return; }
      if (key.ctrl && character === "u") { setMusicQuery(""); setMusicIndex(0); return; }
      if (key.backspace) { setMusicQuery((value) => value.slice(0, -1)); setMusicIndex(0); return; }
      if (character && !key.ctrl && !key.meta && !key.tab) { setMusicQuery((value) => value + character.replace(/[\r\n]+/g, " ")); setMusicIndex(0); }
      return;
    }
    if (overlay === "model") {
      if (key.escape || key.leftArrow) { backModelPicker(); return; }
      if (!modelOverlayReady) return;
      if (modelPicker.loading || busy) return;
      if (key.upArrow || key.downArrow || key.tab) {
        setModelPicker((current) => {
          const count = current.step === "provider" ? 2 : current.step === "slot"
            ? (current.provider === "openai" ? OPENAI_SLOTS.length : OPENROUTER_SLOTS.length)
            : filteredPickerModels(current).length;
          if (count === 0) return current;
          const direction = key.upArrow ? -1 : 1;
          return { ...current, selectedIndex: (current.selectedIndex + direction + count) % count };
        });
        return;
      }
      if (key.return || key.rightArrow) { void chooseModelPickerItem(); return; }
      if (modelPicker.step === "models") {
        if (key.backspace || key.delete) {
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
      else { setInput(""); setInputCursor(0); }
      return;
    }
    if (key.pageUp) { setChatScrollRows((value) => value + chatPageRows); return; }
    if (key.pageDown) { setChatScrollRows((value) => Math.max(0, value - chatPageRows)); return; }
    if (busy) return;
    if (key.shift && character.toLowerCase() === "a") {
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
    if (key.backspace) { if (inputCursor > 0) { setInput((value) => value.slice(0, inputCursor - 1) + value.slice(inputCursor)); setInputCursor((value) => value - 1); } return; }
    if (key.delete) { if (inputCursor < input.length) setInput((value) => value.slice(0, inputCursor) + value.slice(inputCursor + 1)); return; }
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
      <Box justifyContent="space-between"><Text bold color="magenta">DumbEditor</Text><Text dimColor wrap="truncate-end">{project ? `${project.name} · ${project.current.id}` : "No video"}</Text></Box>
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
          : overlay === "approval" && approval ? <ApprovalPanel request={approval} allowSelected={approvalAllow}
              width={terminal.columns - 2} height={layout.playerRows} />
          : overlay === "choice" && choice ? <ChoicePanel request={choice} state={choicePanel}
              width={terminal.columns - 2} height={layout.playerRows} />
          : <>
            {layout.leftSidebarColumns > 0 && <ProjectSidebar versions={sidebarVersions} currentId={project?.current.id ?? ""}
              projectName={project?.name ?? "No project"}
              model={settings.models.openai.text} permissionMode={settings.agent.permissionMode} usage={usage} versionLimit={project?.versionLimit ?? 5}
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
      {loader ? <Box height={3} minHeight={3} borderStyle="round" borderColor="yellow" paddingX={1} overflow="hidden">
          <Text color={loader.source === "Sandbox" ? "cyan" : "yellow"} wrap="truncate-end">{LOADER_MARK} {loader.source === "Sandbox" ? "⬡ SANDBOX" : loader.source} · {loader.stage}</Text>
        </Box>
        : overlay ? <Box height={3} minHeight={3} borderStyle="round" borderColor={overlay === "approval" ? "yellow" : "gray"} paddingX={1} overflow="hidden">
            <Text color={overlay === "approval" ? "yellow" : "cyan"} wrap="truncate-end">{overlayHint(overlay)}</Text>
          </Box>
        : <InputPanel value={input} cursor={inputCursor} width={terminal.columns - 2} busy={busy} />}
      <Box height={1} minHeight={1} overflow="hidden">
        <Text dimColor wrap="truncate-end">{loader
          ? `${loader.source} is working · ${agentModel} ${formatUsd(usage.lunaUsd)} · Harness ${formatUsd(usage.harnessUsd)} · Assets ${formatUsd(usage.assetUsd)} · Total ${formatUsd(usage.totalUsd)}`
          : `${status} · ${agentModel} ${formatUsd(usage.lunaUsd)} · Harness ${formatUsd(usage.harnessUsd)} · Assets ${formatUsd(usage.assetUsd)} · Total ${formatUsd(usage.totalUsd)} · Enter to send · Ctrl+C to quit`}</Text>
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
