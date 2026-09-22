import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { basename, resolve } from "node:path";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import Spinner from "ink-spinner";
import type { ChildProcess } from "node:child_process";
import type { ChatMessage, MediaInfo, Selection } from "../types.js";
import { executeAgentEdit } from "../core/agent.js";
import { executeDirectEdit } from "../core/editor.js";
import { extractFrame, playAudio, previewSize, probeMedia, streamPreview } from "../core/media.js";
import { parseDirectEdit } from "../core/parse-edit.js";
import { ProjectStore } from "../core/project.js";
import { terminateRunningProcesses } from "../core/process.js";
import { routeRequest } from "../core/router.js";
import { formatTime } from "../core/time.js";
import { Help } from "./Help.js";
import { History } from "./History.js";
import { Timeline } from "./Timeline.js";

type Overlay = "help" | "history" | null;

export function App({ initialPath }: { initialPath?: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [terminal, setTerminal] = useState({ columns: stdout.columns ?? 100, rows: stdout.rows ?? 36 });
  const [project, setProject] = useState<ProjectStore | null>(null);
  const [revision, setRevision] = useState(0);
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [frame, setFrame] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const currentTimeRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(70);
  const [selection, setSelection] = useState<Selection>({ in: null, out: null });
  const [input, setInput] = useState("");
  const [inputCursor, setInputCursor] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const didOpenInitialPath = useRef(false);

  const size = useMemo(
    () => media ? previewSize(media, Math.min(96, terminal.columns - 4), Math.max(6, terminal.rows - 18)) : { width: 0, height: 0 },
    [media, terminal],
  );
  const currentFile = project?.current.filePath;

  const movePlayhead = useCallback((next: number) => {
    if (!media) return;
    const value = Math.max(0, Math.min(media.duration, next));
    currentTimeRef.current = value;
    setCurrentTime(value);
  }, [media]);

  const addUiMessage = useCallback((role: ChatMessage["role"], content: string) => {
    setMessages((items) => [...items, { role, content, at: new Date().toISOString() }].slice(-30));
  }, []);

  const openVideo = useCallback(async (path: string) => {
    setBusy(true);
    setPlaying(false);
    setStatus("Opening video…");
    try {
      const store = await ProjectStore.open(resolve(path));
      const nextMedia = await probeMedia(store.current.filePath);
      const history = await store.chatHistory();
      setProject(store);
      setRevision((value) => value + 1);
      setMedia(nextMedia);
      setMessages(history.slice(-30));
      setSelection({ in: null, out: null });
      currentTimeRef.current = 0;
      setCurrentTime(0);
      setFrame("");
      setStatus(`Opened ${basename(path)}`);
      addUiMessage("assistant", `Opened ${basename(path)} · ${nextMedia.width}x${nextMedia.height} · ${formatTime(nextMedia.duration)}`);
    } catch (error) {
      addUiMessage("assistant", errorMessage(error));
      setStatus("Open failed");
    } finally {
      setBusy(false);
    }
  }, [addUiMessage]);

  useEffect(() => () => terminateRunningProcesses(), []);

  useEffect(() => {
    const onResize = () => setTerminal({ columns: stdout.columns ?? 100, rows: stdout.rows ?? 36 });
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  useEffect(() => {
    if (didOpenInitialPath.current) return;
    didOpenInitialPath.current = true;
    if (initialPath) void openVideo(initialPath);
    else addUiMessage("assistant", "Drop in a video with /open <path>, or relaunch as: dumbeditor video.mp4");
  }, [initialPath, openVideo, addUiMessage]);

  useEffect(() => {
    if (!currentFile || !media || playing || size.width === 0) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void extractFrame(currentFile, currentTime, size, controller.signal)
        .then((value) => { if (!controller.signal.aborted) setFrame(value); })
        .catch((error) => { if (!controller.signal.aborted) setStatus(errorMessage(error)); });
    }, 60);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [currentFile, currentTime, media, playing, size]);

  useEffect(() => {
    if (!currentFile || !media || !playing || size.width === 0) return;
    let stopped = false;
    const start = currentTimeRef.current >= media.duration - 0.05 ? 0 : currentTimeRef.current;
    if (start === 0) movePlayhead(0);
    const preview = streamPreview({
      filePath: currentFile,
      start,
      size,
      onFrame: (nextFrame, time) => {
        if (stopped) return;
        setFrame(nextFrame);
        currentTimeRef.current = Math.min(time, media.duration);
        setCurrentTime(currentTimeRef.current);
      },
      onEnd: () => { if (!stopped) setPlaying(false); },
      onError: (error) => {
        if (!stopped) {
          setStatus(`Preview unavailable: ${error.message}`);
          setPlaying(false);
        }
      },
    });
    return () => {
      stopped = true;
      preview.stop();
    };
  }, [currentFile, media, playing, size, movePlayhead]);

  useEffect(() => {
    if (!currentFile || !media?.hasAudio || !playing || size.width === 0) return;
    let stopped = false;
    const audio: ChildProcess | null = playAudio(currentFile, currentTimeRef.current, volume, (error) => {
      if (!stopped) setStatus(`Audio preview unavailable: ${error.message}`);
    });
    return () => {
      stopped = true;
      audio?.kill();
    };
  }, [currentFile, media, playing, size, volume]);

  const answer = useCallback(async (content: string) => {
    addUiMessage("assistant", content);
    if (project) await project.addChat("assistant", content);
  }, [addUiMessage, project]);

  const handleCommand = useCallback(async (line: string) => {
    const space = line.indexOf(" ");
    const command = (space === -1 ? line : line.slice(0, space)).toLowerCase();
    const argument = unquoteArgument(space === -1 ? "" : line.slice(space + 1).trim());
    if (command === "/quit" || command === "/exit") { exit(); return; }
    if (command === "/help") { setOverlay("help"); return; }
    if (command === "/clear") { setMessages([]); setOverlay(null); return; }
    if (command === "/play") { if (media) setPlaying(true); return; }
    if (command === "/pause") { setPlaying(false); return; }
    if (command === "/open") {
      if (!argument) { await answer("Usage: /open <video path>"); return; }
      await openVideo(argument);
      return;
    }
    if (!project || !media) { await answer("Open a video first with /open <path>."); return; }
    if (command === "/version" || command === "/versions") {
      if (argument && argument.toLowerCase() !== "all") { await answer("Usage: /version [all]"); return; }
      setShowAllHistory(argument.toLowerCase() === "all");
      setOverlay("history");
      return;
    }
    if (command === "/status") {
      await answer(`${project.current.id} · ${media.width}x${media.height} · ${formatTime(media.duration)} · ${project.snapshot.versions.length} versions`);
      return;
    }
    if (command === "/undo") {
      const parent = project.current.parentId;
      if (!parent) { await answer("Already at the original version."); return; }
      await changeVersion(parent);
      return;
    }
    if (command === "/revert") {
      if (!argument) { await answer("Usage: /revert <version id>"); return; }
      await changeVersion(argument);
      return;
    }
    if (command === "/export") {
      if (!argument) { await answer("Usage: /export <output.mp4>"); return; }
      setBusy(true); setStatus("Exporting…");
      try {
        const output = await project.exportCurrent(argument);
        await answer(`Exported ${output}`);
        setStatus("Export complete");
      } catch (error) { await answer(errorMessage(error)); setStatus("Export failed"); }
      finally { setBusy(false); }
      return;
    }
    await answer(`Unknown command ${command}. Use /help.`);

    async function changeVersion(reference: string) {
      setBusy(true); setPlaying(false); setStatus("Changing version…");
      try {
        const version = await project!.revert(reference);
        const nextMedia = await probeMedia(version.filePath);
        setMedia(nextMedia); setRevision((value) => value + 1); movePlayhead(0);
        await answer(`Now on ${version.id}: ${version.action}`);
        setStatus(`Current ${version.id}`);
      } catch (error) { await answer(errorMessage(error)); setStatus("Revert failed"); }
      finally { setBusy(false); }
    }
  }, [answer, exit, media, movePlayhead, openVideo, project]);

  const submit = useCallback(async () => {
    const request = input.trim();
    if (!request || busy) return;
    setInput("");
    setInputCursor(0);
    setOverlay(null);
    addUiMessage("user", request);
    if (request.startsWith("/")) { await handleCommand(request); return; }
    if (!project || !media) { await answer("Open a video first with /open <path>."); return; }

    setBusy(true);
    setPlaying(false);
    try {
      const priorHistory = await project.chatHistory();
      await project.addChat("user", request);
      setStatus("JEV is deciding…");
      const decision = await routeRequest({ request, duration: media.duration, currentTime, selection, history: priorHistory });
      if (decision.confidence < 0.25) {
        throw new Error(`JEV was unsure how to route that request (${Math.round(decision.confidence * 100)}% confidence). Try a more specific edit.`);
      }
      if (decision.route === "explain") {
        await answer("Direct edits: remove ranges, keep/trim a range, speed a range, mute a range, and crop to a size. Mark a range with [ and ], or use explicit timestamps. /help shows every control.");
        setStatus(`JEV · ${decision.model}`);
        return;
      }
      if (decision.route === "agent") {
        setStatus("Agent is editing…");
        const result = await executeAgentEdit({ store: project, request, history: priorHistory });
        setMedia(result.media); setRevision((value) => value + 1); movePlayhead(0);
        await answer(`${result.version.id} · ${result.result.summary}`);
        setStatus(`Agent · ${result.result.model}`);
        return;
      }
      const edit = parseDirectEdit({ route: decision.route, request, duration: media.duration, currentTime, selection });
      setStatus(`Applying ${decision.route}…`);
      const result = await executeDirectEdit(project, edit, request);
      setMedia(result.media); setRevision((value) => value + 1); movePlayhead(0);
      setSelection({ in: null, out: null });
      await answer(`${result.version.id} · ${result.version.action}`);
      setStatus(`JEV · ${decision.model}`);
    } catch (error) {
      await answer(errorMessage(error));
      setStatus("Ready");
    } finally {
      setBusy(false);
    }
  }, [addUiMessage, answer, busy, currentTime, handleCommand, input, media, movePlayhead, project, selection]);

  useInput((character, key) => {
    if (key.ctrl && character === "c") { exit(); return; }
    if (key.escape) {
      if (overlay) setOverlay(null);
      else { setInput(""); setInputCursor(0); }
      return;
    }
    if (busy) return;
    if (key.return) { void submit(); return; }
    if (key.ctrl && character === "a") { setInputCursor(0); return; }
    if (key.ctrl && character === "e") { setInputCursor(input.length); return; }
    if (key.backspace) {
      if (inputCursor > 0) {
        setInput((value) => value.slice(0, inputCursor - 1) + value.slice(inputCursor));
        setInputCursor((value) => value - 1);
      }
      return;
    }
    if (key.delete) {
      if (inputCursor < input.length) setInput((value) => value.slice(0, inputCursor) + value.slice(inputCursor + 1));
      return;
    }
    if (key.leftArrow) {
      if (input.length > 0) setInputCursor((value) => Math.max(0, value - 1));
      else { setPlaying(false); movePlayhead(currentTimeRef.current - 5); }
      return;
    }
    if (key.rightArrow) {
      if (input.length > 0) setInputCursor((value) => Math.min(input.length, value + 1));
      else { setPlaying(false); movePlayhead(currentTimeRef.current + 5); }
      return;
    }
    if (key.upArrow) { setVolume((value) => Math.min(100, value + 5)); return; }
    if (key.downArrow) { setVolume((value) => Math.max(0, value - 5)); return; }
    if (character === " " && input.length === 0) { if (media) setPlaying((value) => !value); return; }
    if (character === "[" && input.length === 0) { setSelection((value) => ({ ...value, in: currentTimeRef.current })); return; }
    if (character === "]" && input.length === 0) { setSelection((value) => ({ ...value, out: currentTimeRef.current })); return; }
    if (character && !key.ctrl && !key.meta && !key.tab) {
      const text = character.replace(/[\r\n]+/g, " ");
      setInput((value) => value.slice(0, inputCursor) + text + value.slice(inputCursor));
      setInputCursor((value) => value + text.length);
    }
  });

  const visibleMessages = messages.slice(-5);
  const versions = project?.history(showAllHistory ? project.snapshot.versions.length : 8) ?? [];
  void revision;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="magenta">DumbEditor</Text>
        <Text dimColor>{project ? `${basename(project.snapshot.sourcePath)} · ${project.current.id}` : "No video"}</Text>
      </Box>

      {overlay === "help" ? <Help /> : overlay === "history" && project ? <History versions={versions} currentId={project.current.id} /> : (
        <>
          <Box justifyContent="center" minHeight={media ? Math.max(3, size.height / 2) : 3}>
            {frame && media ? <Text>{frame}</Text> : <Text dimColor>{busy ? "Preparing preview…" : "No frame loaded"}</Text>}
          </Box>
          {media && <Timeline current={currentTime} duration={media.duration} selection={selection} width={terminal.columns} />}
          <Box justifyContent="space-between">
            <Text dimColor>{playing ? "▶ playing" : "Ⅱ paused"} · volume {volume}%{selection.in !== null ? ` · in ${formatTime(selection.in)}` : ""}{selection.out !== null ? ` · out ${formatTime(selection.out)}` : ""}</Text>
            <Text dimColor>←/→ 5s · [ ] marks · /help</Text>
          </Box>
        </>
      )}

      <Box flexDirection="column" marginTop={1}>
        {visibleMessages.map((message, index) => (
          <Text key={`${message.at}-${index}`} wrap="truncate-end">
            <Text color={message.role === "user" ? "cyan" : "magenta"}>{message.role === "user" ? "you" : "dumb"} › </Text>
            {message.content}
          </Text>
        ))}
      </Box>

      <Box borderStyle="round" borderColor={busy ? "yellow" : "gray"} paddingX={1}>
        <Text color="cyan">› </Text>
        <Text>{input.slice(0, inputCursor)}</Text>
        {!busy && <Text inverse>{input[inputCursor] ?? " "}</Text>}
        <Text>{input.slice(inputCursor + (inputCursor < input.length ? 1 : 0))}</Text>
        {busy && <Text color="yellow"><Spinner type="dots" /> {status}</Text>}
      </Box>
      <Text dimColor>{busy ? status : `${status} · Enter to send · Ctrl+C to quit`}</Text>
    </Box>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unquoteArgument(value: string): string {
  const first = value[0];
  return value.length >= 2 && (first === "'" || first === "\"") && value.at(-1) === first
    ? value.slice(1, -1)
    : value;
}
