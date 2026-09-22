import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { basename, resolve } from "node:path";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { ChildProcess } from "node:child_process";
import type { ChatMessage, DirectEdit, MediaInfo, Selection } from "../types.js";
import { commandSuggestions, parseEditCommand } from "../core/commands.js";
import { executeDirectEdit } from "../core/editor.js";
import { askLuna } from "../core/luna.js";
import { playAudio, probeMedia } from "../core/media.js";
import { ProjectStore } from "../core/project.js";
import { terminateProcess, terminateRunningProcesses } from "../core/process.js";
import { formatTime } from "../core/time.js";
import { Help } from "./Help.js";
import { History } from "./History.js";
import { editorLayout } from "./layout.js";
import { Timeline } from "./Timeline.js";
import { activePreviewBackend, VideoSurface } from "./VideoSurface.js";

type Overlay = "help" | "history" | null;
interface LoaderState { source: "Luna" | "Command" | "Editor"; stage: string }
const SPINNER = ["◐", "◓", "◑", "◒"];

export function App({ initialPath }: { initialPath?: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
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
  const [loader, setLoader] = useState<LoaderState | null>(null);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [status, setStatus] = useState("Ready");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const didOpenInitialPath = useRef(false);

  const busy = loader !== null;
  const previewBackend = useMemo(() => activePreviewBackend(), []);
  const layout = useMemo(() => editorLayout(terminal, media, previewBackend), [terminal, media, previewBackend]);
  const suggestions = useMemo(() => commandSuggestions(input), [input]);
  const currentFile = project?.current.filePath;

  useEffect(() => {
    if (!busy) { setSpinnerFrame(0); return; }
    const timer = setInterval(() => setSpinnerFrame((value) => (value + 1) % SPINNER.length), 120);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => { setSuggestionIndex(0); }, [input]);
  useEffect(() => () => terminateRunningProcesses(), []);
  useEffect(() => {
    const onResize = () => setTerminal({ columns: stdout.columns ?? 100, rows: stdout.rows ?? 36 });
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

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
  const addUiMessage = useCallback((role: ChatMessage["role"], content: string) => {
    setMessages((items) => [...items, { role, content, at: new Date().toISOString() }].slice(-50));
  }, []);
  const answer = useCallback(async (content: string) => {
    addUiMessage("assistant", content);
    if (project) await project.addChat("assistant", content);
  }, [addUiMessage, project]);

  const openVideo = useCallback(async (path: string) => {
    setLoader({ source: "Editor", stage: "Opening video" });
    setPlaying(false);
    try {
      const store = await ProjectStore.open(resolve(path));
      setLoader({ source: "Editor", stage: "Reading media details" });
      const nextMedia = await probeMedia(store.current.filePath);
      const history = await store.chatHistory();
      setProject(store); setRevision((value) => value + 1); setMedia(nextMedia); setMessages(history.slice(-50));
      setSelection({ in: null, out: null }); currentTimeRef.current = 0; setCurrentTime(0);
      setStatus(`Opened ${basename(path)}`);
      addUiMessage("assistant", `Opened ${basename(path)} · ${nextMedia.width}x${nextMedia.height} · ${formatTime(nextMedia.duration)}`);
    } catch (error) { addUiMessage("assistant", errorMessage(error)); setStatus("Open failed"); }
    finally { setLoader(null); }
  }, [addUiMessage]);

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

  const handleCommand = useCallback(async (line: string) => {
    const space = line.indexOf(" ");
    const command = (space === -1 ? line : line.slice(0, space)).toLowerCase();
    const argument = unquoteArgument(space === -1 ? "" : line.slice(space + 1).trim());
    if (command === "/quit" || command === "/exit") { exit(); return; }
    if (command === "/help") { setOverlay("help"); return; }
    if (command === "/clear") { setMessages([]); setOverlay(null); return; }
    if (command === "/play") { if (media) setPlaying(true); return; }
    if (command === "/pause") { setCurrentTime(currentTimeRef.current); setPlaying(false); return; }
    if (command === "/open") { if (!argument) { await answer("Usage: /open <VIDEO PATH>"); return; } await openVideo(argument); return; }
    if (!project || !media) { await answer("Open a video first with /open <path>."); return; }

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
    if (command === "/status") { await answer(`${project.current.id} · ${media.width}x${media.height} · ${formatTime(media.duration)} · ${project.snapshot.versions.length} versions`); return; }
    if (command === "/undo") {
      const parent = project.current.parentId;
      if (!parent) { await answer("Already at the original version."); return; }
      await changeVersion(parent); return;
    }
    if (command === "/revert") { if (!argument) { await answer("Usage: /revert <VERSION>"); return; } await changeVersion(argument); return; }
    if (command === "/export") {
      if (!argument) { await answer("Usage: /export <OUTPUT PATH>"); return; }
      setLoader({ source: "Editor", stage: "Exporting current version" });
      try { const output = await project.exportCurrent(argument); await answer(`Exported ${output}`); setStatus("Export complete"); }
      catch (error) { await answer(errorMessage(error)); setStatus("Export failed"); }
      finally { setLoader(null); }
      return;
    }
    await answer(`Unknown command ${command}. Type / to see commands.`);
  }, [answer, applyEdit, changeVersion, exit, media, openVideo, project, selection]);

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

    setPlaying(false); setLoader({ source: "Luna", stage: "Understanding your request" });
    try {
      const priorHistory = await project.chatHistory(); await project.addChat("user", request);
      const decision = await askLuna({ request, duration: media.duration, currentTime: currentTimeRef.current, selection, history: priorHistory });
      if (decision.kind === "message") {
        setLoader({ source: "Luna", stage: "Writing response" }); await answer(decision.message); setStatus(`Luna · ${decision.model}`);
      } else { await applyEdit(decision.edit, request, "Luna"); setStatus(`Luna · ${decision.model} · complete`); }
    } catch (error) { await answer(errorMessage(error)); setStatus("Luna request failed"); }
    finally { setLoader(null); }
  }, [addUiMessage, answer, applyEdit, busy, handleCommand, input, media, project, selection, suggestionIndex, suggestions]);

  useInput((character, key) => {
    if (key.ctrl && character === "c") { exit(); return; }
    if (key.escape) { if (overlay) setOverlay(null); else { setInput(""); setInputCursor(0); } return; }
    if (busy) return;
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
    if (key.upArrow) { if (suggestions.length > 0) setSuggestionIndex((value) => (value - 1 + suggestions.length) % suggestions.length); else setVolume((value) => Math.min(100, value + 5)); return; }
    if (key.downArrow) { if (suggestions.length > 0) setSuggestionIndex((value) => (value + 1) % suggestions.length); else setVolume((value) => Math.max(0, value - 5)); return; }
    if (character === " " && input.length === 0) { if (media) { if (playing) setCurrentTime(currentTimeRef.current); setPlaying((value) => !value); } return; }
    if (character === "[" && input.length === 0) { setSelection((value) => ({ ...value, in: currentTimeRef.current })); return; }
    if (character === "]" && input.length === 0) { setSelection((value) => ({ ...value, out: currentTimeRef.current })); return; }
    if (character && !key.ctrl && !key.meta && !key.tab) {
      const text = character.replace(/[\r\n]+/g, " ");
      setInput((value) => value.slice(0, inputCursor) + text + value.slice(inputCursor)); setInputCursor((value) => value + text.length);
    }
  });

  const visibleMessages = messages.slice(-layout.chatRows);
  const versions = project?.history(showAllHistory ? project.snapshot.versions.length : 8) ?? [];
  void revision;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between"><Text bold color="magenta">DumbEditor</Text><Text dimColor>{project ? `${basename(project.snapshot.sourcePath)} · ${project.current.id}` : "No video"}</Text></Box>
      <Box height={layout.playerRows} minHeight={layout.playerRows} flexDirection="column">
        {overlay === "help" ? <Help /> : overlay === "history" && project ? <History versions={versions} currentId={project.current.id} /> : (
          <VideoSurface {...(currentFile ? { filePath: currentFile } : {})} media={media} playing={playing} time={currentTime}
            columns={terminal.columns - 2} rows={layout.playerRows} topRow={2} selection={selection}
            onTime={updatePreviewTime} onEnd={() => setPlaying(false)} onError={(error) => { setStatus(`Preview unavailable: ${error.message}`); setPlaying(false); }} />
        )}
      </Box>
      <Box height={1} minHeight={1}>{media ? <Timeline current={currentTime} duration={media.duration} selection={selection} width={terminal.columns} /> : <Text> </Text>}</Box>
      <Box height={1} minHeight={1} justifyContent="space-between">
        <Text dimColor>{playing ? "▶ playing" : "Ⅱ paused"} · volume {volume}%{selection.in !== null ? ` · in ${formatTime(selection.in)}` : ""}{selection.out !== null ? ` · out ${formatTime(selection.out)}` : ""}</Text>
        <Text dimColor>{previewBackend.toUpperCase()} · ←/→ 5s · [ ] marks · / commands</Text>
      </Box>
      <Box flexDirection="column" height={layout.chatRows} minHeight={layout.chatRows}>
        {suggestions.length > 0 ? suggestions.slice(0, layout.chatRows).map((command, index) => (
          <Text key={command.name} {...(index === suggestionIndex ? { color: "cyan" as const, inverse: true } : {})} wrap="truncate-end">
            {index === suggestionIndex ? "› " : "  "}{command.usage}  <Text dimColor>{command.description}</Text>
          </Text>
        )) : visibleMessages.map((message, index) => (
          <Text key={`${message.at}-${index}`} wrap="truncate-end"><Text color={message.role === "user" ? "cyan" : "magenta"}>{message.role === "user" ? "you" : "dumb"} › </Text>{message.content}</Text>
        ))}
      </Box>
      <Box borderStyle="round" borderColor={busy ? "yellow" : "gray"} paddingX={1}>
        {loader ? <Text color="yellow">{SPINNER[spinnerFrame]} {loader.source} · {loader.stage}</Text> : <><Text color="cyan">› </Text><Text>{input.slice(0, inputCursor)}</Text><Text inverse>{input[inputCursor] ?? " "}</Text><Text>{input.slice(inputCursor + (inputCursor < input.length ? 1 : 0))}</Text></>}
      </Box>
      <Text dimColor>{loader ? `${loader.source} is working · please wait` : `${status} · GPT-6 Luna · Enter to send · Ctrl+C to quit`}</Text>
    </Box>
  );
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function unquoteArgument(value: string): string {
  const first = value[0];
  return value.length >= 2 && (first === "'" || first === "\"") && value.at(-1) === first ? value.slice(1, -1) : value;
}
