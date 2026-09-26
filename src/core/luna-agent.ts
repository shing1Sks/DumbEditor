import { randomUUID } from "node:crypto";
import type { ChatMessage, MediaInfo, Selection } from "../types.js";

export interface AgentToolResult {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
  /** Additional multimodal context to send back to Luna after the tool result. */
  inputItems?: Array<Record<string, unknown>>;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutatesProject?: boolean;
  run: (argumentsValue: Record<string, unknown>) => Promise<AgentToolResult>;
}

export interface LunaAgentResult {
  message: string;
  model: string;
  toolCalls: number;
  mutations: number;
  costUsd: number;
}

export interface LunaUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface FunctionCallItem {
  type: "function_call";
  name: string;
  arguments: string;
  call_id: string;
}

interface MessageItem {
  type: "message";
  content?: Array<{ type?: string; text?: string }>;
}

interface ResponsePayload {
  id?: string;
  output?: Array<FunctionCallItem | MessageItem | Record<string, unknown>>;
  output_text?: string;
  error?: { message?: string };
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens?: number;
  };
}

type InputItem = Record<string, unknown>;

const MAIN_MODEL = "gpt-6-luna";
const MAX_ROUNDS = 12;
const MAX_TOOL_CALLS = 24;
const MAX_MUTATIONS = 8;

export async function runLunaAgent(options: {
  request: string;
  media: MediaInfo;
  currentVersionId: string;
  currentTime: number;
  selection: Selection;
  history: ChatMessage[];
  tools: AgentTool[];
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  onLedger?: (direction: "response" | "tool", items: unknown[]) => Promise<void>;
  onUsage?: (usage: LunaUsage) => Promise<void>;
}): Promise<LunaAgentResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OpenAI API key is missing. Run dumbeditor setup.");
  const request = options.request.trim();
  if (!request) throw new Error("Agent request cannot be empty.");
  const runId = randomUUID();
  const toolMap = new Map(options.tools.map((tool) => [tool.name, tool]));
  const input: InputItem[] = conversationItems(options.history, request, editorState(options));
  let toolCalls = 0;
  let mutations = 0;
  let costUsd = 0;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    options.onStage?.(round === 0 ? "Luna is planning the edit" : "Luna is reviewing tool results");
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MAIN_MODEL,
        reasoning: { effort: "medium" },
        store: false,
        include: ["reasoning.encrypted_content"],
        context_management: [{ type: "compaction", compact_threshold: 800_000 }],
        max_output_tokens: 16_000,
        parallel_tool_calls: false,
        tool_choice: "auto",
        instructions: agentInstructions(runId),
        input,
        tools: options.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          strict: true,
          parameters: tool.parameters,
        })),
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const payload = await response.json().catch(() => ({})) as ResponsePayload;
    if (!response.ok) throw new Error(`OpenAI agent request failed: ${payload.error?.message ?? `HTTP ${response.status}`}`);
    if (payload.usage) {
      const usage = calculateLunaUsage(payload.usage);
      costUsd += usage.costUsd;
      await options.onUsage?.(usage);
    }
    const output = payload.output ?? [];
    await options.onLedger?.("response", output);
    input.push(...output as InputItem[]);
    const calls = output.filter(isFunctionCall);
    if (calls.length === 0) {
      const message = responseText(payload);
      if (!message) throw new Error("Luna finished without an edit summary or response.");
      return { message, model: MAIN_MODEL, toolCalls, mutations, costUsd };
    }

    const toolOutputs: InputItem[] = [];
    for (const call of calls) {
      toolCalls += 1;
      if (toolCalls > MAX_TOOL_CALLS) throw new Error("Luna exceeded the tool-call limit for one request.");
      const tool = toolMap.get(call.name);
      let result: AgentToolResult;
      if (!tool) result = { ok: false, message: `Unknown tool: ${call.name}` };
      else {
        if (tool.mutatesProject) {
          mutations += 1;
          if (mutations > MAX_MUTATIONS) throw new Error("Luna exceeded the edit limit for one request.");
        }
        options.onStage?.(`Luna · ${humanize(call.name)}`);
        result = await runTool(tool, call.arguments);
      }
      toolOutputs.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify({ ok: result.ok, message: result.message, ...(result.data ? { data: result.data } : {}) }),
      });
      if (result.inputItems) toolOutputs.push(...result.inputItems);
    }
    await options.onLedger?.("tool", toolOutputs);
    input.push(...toolOutputs);
  }
  throw new Error("Luna reached the reasoning-round limit before finishing the request.");
}

export function calculateLunaUsage(usage: NonNullable<ResponsePayload["usage"]>): LunaUsage {
  const inputTokens = positive(usage.input_tokens);
  const cachedInputTokens = Math.min(inputTokens, positive(usage.input_tokens_details?.cached_tokens));
  const cacheWriteTokens = Math.min(inputTokens - cachedInputTokens, positive(usage.input_tokens_details?.cache_write_tokens));
  const ordinaryInputTokens = Math.max(0, inputTokens - cachedInputTokens - cacheWriteTokens);
  const outputTokens = positive(usage.output_tokens);
  const longContext = inputTokens > 272_000;
  const perMillion = longContext
    ? { input: 0.20, cached: 0.02, cacheWrite: 0.25, output: 0.75 }
    : { input: 0.10, cached: 0.01, cacheWrite: 0.125, output: 0.50 };
  const costUsd = (
    ordinaryInputTokens * perMillion.input
    + cachedInputTokens * perMillion.cached
    + cacheWriteTokens * perMillion.cacheWrite
    + outputTokens * perMillion.output
  ) / 1_000_000;
  return { inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, costUsd };
}

function positive(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
}

async function runTool(tool: AgentTool, encodedArguments: string): Promise<AgentToolResult> {
  try {
    const parsed = JSON.parse(encodedArguments) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, message: "Tool arguments must be an object." };
    return await tool.run(parsed as Record<string, unknown>);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function conversationItems(history: ChatMessage[], request: string, state: string): InputItem[] {
  const items: InputItem[] = [{ role: "developer", content: [{ type: "input_text", text: state }] }];
  for (const message of history) {
    items.push({ role: message.role, content: [{ type: "input_text", text: message.content }] });
  }
  items.push({ role: "user", content: [{ type: "input_text", text: request }] });
  return items;
}

function editorState(options: {
  media: MediaInfo;
  currentVersionId: string;
  currentTime: number;
  selection: Selection;
}): string {
  return [
    `Active version: ${options.currentVersionId}`,
    `Video duration: ${options.media.duration.toFixed(3)} seconds`,
    `Video dimensions: ${options.media.width}x${options.media.height}`,
    `Video FPS: ${options.media.fps}`,
    `Audio stream: ${options.media.hasAudio ? "yes" : "no"}`,
    `Playhead: ${options.currentTime.toFixed(3)} seconds`,
    `In mark: ${options.selection.in ?? "unset"}`,
    `Out mark: ${options.selection.out ?? "unset"}`,
  ].join("\n");
}

function agentInstructions(runId: string): string {
  return [
    "You are Luna, the main DumbEditor video-editing agent.",
    "Use the supplied tools to complete the user's request; you may call several tools in sequence.",
    "Inspect available state, generated assets, and tool results before claiming that work is complete.",
    "Prefer deterministic local editing tools. Generate paid assets only when the request actually needs them.",
    "When the user asks to add or generate subtitles and the video has audio, call transcribe_and_add_subtitles; do not ask them to provide a transcript first.",
    "When no specialized edit tool fits, inspect the available general workspace and rendering tools and devise a method before saying the edit is unavailable.",
    "If a tool fails, correct the arguments or explain the exact blocker. Never invent a successful edit.",
    "Keep the final response short and say which version and assets were created.",
    `Agent run: ${runId}`,
  ].join(" ");
}

function isFunctionCall(item: FunctionCallItem | MessageItem | Record<string, unknown>): item is FunctionCallItem {
  return item.type === "function_call"
    && typeof (item as Partial<FunctionCallItem>).name === "string"
    && typeof (item as Partial<FunctionCallItem>).arguments === "string"
    && typeof (item as Partial<FunctionCallItem>).call_id === "string";
}

function responseText(payload: ResponsePayload): string {
  if (payload.output_text?.trim()) return payload.output_text.trim();
  return (payload.output ?? [])
    .flatMap((item) => item.type === "message" ? (item as MessageItem).content ?? [] : [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}
