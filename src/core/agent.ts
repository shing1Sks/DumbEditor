import { copyFile, lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { AgentResult, ChatMessage, MediaInfo, VersionEntry } from "../types.js";
import { probeMedia } from "./media.js";
import { runProcess } from "./process.js";
import { ProjectStore } from "./project.js";

interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface CompletionPayload {
  choices?: Array<{ message?: OpenRouterMessage }>;
  model?: string;
  error?: { message?: string };
}

export async function executeAgentEdit(options: {
  store: ProjectStore;
  request: string;
  history: ChatMessage[];
}): Promise<{ result: AgentResult; version: VersionEntry; media: MediaInfo }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("This edit needs the agent, but OPENROUTER_API_KEY is not configured. Direct cuts, trims, speed, mute, and crop still work.");
  }

  const workspace = options.store.createAgentWorkspace();
  await mkdir(workspace, { recursive: true });
  const inputName = `input${extname(options.store.current.filePath) || ".mp4"}`;
  await copyFile(options.store.current.filePath, resolve(workspace, inputName));
  const model = process.env.OPENROUTER_MODEL?.trim() || "~openai/gpt-latest";
  const messages: OpenRouterMessage[] = [
    {
      role: "system",
      content: [
        "You are DumbEditor's video-editing worker. Complete the requested edit by using the provided tools.",
        `The current video is ${inputName}. Work only inside this task workspace.`,
        "Use inspect_media before choosing filters. Use FFmpeg for media changes. You may write SRT, ASS, JSON, text, or JavaScript helper files when useful.",
        "Create a new playable output file; never modify input. Call finish only after the output exists.",
        "Do not claim a visual or audio result you have not created and inspected.",
      ].join("\n"),
    },
    ...options.history.map<OpenRouterMessage>(({ role, content }) => ({ role, content })),
    { role: "user", content: options.request },
  ];

  let finished: AgentResult | null = null;
  for (let turn = 0; turn < 10 && !finished; turn += 1) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/dumbeditor/dumbeditor",
        "X-Title": "DumbEditor",
      },
      body: JSON.stringify({ model, messages, tools: AGENT_TOOLS, tool_choice: "auto" }),
    });
    const rawPayload = await response.text();
    let payload: CompletionPayload;
    try {
      payload = JSON.parse(rawPayload) as CompletionPayload;
    } catch {
      throw new Error(`OpenRouter returned an invalid response (${response.status} ${response.statusText})`);
    }
    if (!response.ok) throw new Error(`OpenRouter: ${payload.error?.message ?? response.statusText}`);
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error("OpenRouter returned no agent message");
    messages.push(message);
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) throw new Error(message.content || "The agent stopped before creating an output");

    for (const call of calls) {
      const toolResult = await runToolSafely(call, workspace, inputName);
      if (toolResult.finished) finished = { ...toolResult.finished, model: payload.model ?? model };
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(toolResult.response) });
      if (finished) break;
    }
  }
  if (!finished) throw new Error("The agent reached its tool-call limit before finishing the edit");

  const agentMedia = await probeMedia(finished.outputPath);
  const outputExtension = extname(finished.outputPath).toLowerCase();
  const destination = options.store.nextOutputPath(outputExtension || ".mp4");
  await copyFile(finished.outputPath, destination);
  const finalMedia = await probeMedia(destination);
  const version = await options.store.commit({
    outputPath: destination,
    action: `Agent: ${finished.summary}`,
    request: options.request,
    duration: finalMedia.duration,
    agent: true,
  });
  return { result: { ...finished, outputPath: destination }, version, media: finalMedia };
}

async function runToolSafely(
  call: ToolCall,
  workspace: string,
  inputName: string,
): Promise<{ response: unknown; finished?: AgentResult }> {
  try {
    return await runTool(call, workspace, inputName);
  } catch (error) {
    return { response: { error: error instanceof Error ? error.message : String(error) } };
  }
}

async function runTool(
  call: ToolCall,
  workspace: string,
  inputName: string,
): Promise<{ response: unknown; finished?: AgentResult }> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return { response: { error: "Tool arguments were not valid JSON" } };
  }

  if (call.function.name === "inspect_media") {
    const path = safePath(workspace, String(args.path ?? inputName));
    return { response: await probeMedia(path) };
  }
  if (call.function.name === "list_files") {
    const entries = await readdir(workspace);
    const files = await Promise.all(entries.map(async (name) => ({ name, bytes: (await stat(resolve(workspace, name))).size })));
    return { response: { files } };
  }
  if (call.function.name === "read_file") {
    const path = safePath(workspace, String(args.path ?? ""));
    return { response: { content: (await readFile(path, "utf8")).slice(0, 100_000) } };
  }
  if (call.function.name === "write_file") {
    const path = safePath(workspace, String(args.path ?? ""));
    const allowed = new Set([".js", ".mjs", ".json", ".txt", ".srt", ".ass", ".csv"]);
    if (!allowed.has(extname(path).toLowerCase())) throw new Error("write_file supports helper, subtitle, and data files only");
    const content = String(args.content ?? "");
    if (Buffer.byteLength(content) > 200_000) throw new Error("Helper file is too large");
    await writeFile(path, content, "utf8");
    return { response: { ok: true, path: basename(path) } };
  }
  if (call.function.name === "run_ffmpeg") {
    if (!Array.isArray(args.arguments) || !args.arguments.every((item) => typeof item === "string")) {
      throw new Error("run_ffmpeg arguments must be an array of strings");
    }
    const ffmpegArgs = args.arguments as string[];
    validateFfmpegArgs(ffmpegArgs, workspace);
    const result = await runProcess("ffmpeg", ["-y", "-v", "warning", ...ffmpegArgs], {
      cwd: workspace,
      timeoutMs: 10 * 60_000,
      maxOutputBytes: 4_000_000,
    });
    return { response: { ok: true, log: result.stderr.slice(-3000) } };
  }
  if (call.function.name === "finish") {
    const outputPath = safePath(workspace, String(args.output_path ?? ""));
    if (resolve(outputPath) === resolve(workspace, inputName)) throw new Error("finish requires a new output file, not the input video");
    const outputStat = await lstat(outputPath);
    if (!outputStat.isFile() || outputStat.isSymbolicLink() || outputStat.size === 0) {
      throw new Error("The finished output must be a non-empty regular file in the task workspace");
    }
    const info = await probeMedia(outputPath);
    const finished: AgentResult = {
      outputPath,
      summary: String(args.summary ?? "Completed custom edit").slice(0, 240),
      model: "",
    };
    return { response: { ok: true, duration: info.duration }, finished };
  }
  return { response: { error: `Unknown tool ${call.function.name}` } };
}

function safePath(workspace: string, value: string): string {
  if (!value || isAbsolute(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new Error("Use a relative path inside the task workspace");
  }
  const path = resolve(workspace, value);
  const rel = relative(resolve(workspace), path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path leaves the task workspace");
  return path;
}

function validateFfmpegArgs(args: string[], workspace: string): void {
  if (args.length === 0 || args.length > 100) throw new Error("Invalid FFmpeg argument count");
  const blockedOptions = new Set([
    "-attach", "-dump_attachment", "-filter_script", "-filter_complex_script",
    "-passlogfile", "-progress", "-report", "-vstats_file",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? "";
    if (value.includes("\0") || blockedOptions.has(value)) throw new Error(`FFmpeg option ${value || "NUL"} is disabled in the agent workspace`);
    if (
      /(?:https?|ftp|sftp|tcp|udp|rtmp|concat|file):/i.test(value)
      || /(?:^|[=:])(?:movie|amovie)=/i.test(value)
      || /(?:^|[=:'"])(?:\.\.[\\/]|[a-z](?::|\\:)[\\/]|\\\\|\/)/i.test(value)
    ) {
      throw new Error("Network and paths outside the task workspace are disabled for FFmpeg");
    }
    if (value === "-i") {
      const candidate = args[index + 1];
      const usesLavfi = args[index - 2] === "-f" && args[index - 1] === "lavfi";
      if (candidate && !usesLavfi) safePath(workspace, candidate);
    }
  }
  const output = args.at(-1);
  if (!output || output.startsWith("-")) throw new Error("FFmpeg arguments must end with an output file");
  safePath(workspace, output);
}

const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "inspect_media",
      description: "Read technical metadata for a media file in the task workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "run_ffmpeg",
      description: "Run FFmpeg with an argument array in the task workspace. Do not include the ffmpeg executable, -y, or log-level flags.",
      parameters: {
        type: "object",
        properties: { arguments: { type: "array", items: { type: "string" } } },
        required: ["arguments"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a helper, subtitle, or data file inside the task workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the task workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files created in the task workspace.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Finish the task with the path to a playable edited output and a short factual summary.",
      parameters: {
        type: "object",
        properties: { output_path: { type: "string" }, summary: { type: "string" } },
        required: ["output_path", "summary"],
      },
    },
  },
] as const;
