import { randomUUID } from "node:crypto";
import type { ChatMessage, MediaInfo, Selection } from "../types.js";
import type { ModelProvider } from "./settings.js";

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
  auditsProject?: boolean;
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
  estimated: boolean;
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
    cost?: number;
  };
}

type InputItem = Record<string, unknown>;

export async function runLunaAgent(options: {
  provider?: ModelProvider;
  model: string;
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
  const provider = options.provider ?? "openai";
  const apiKey = (provider === "openrouter" ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY)?.trim();
  const providerName = provider === "openrouter" ? "OpenRouter" : "OpenAI";
  if (!apiKey) throw new Error(`${providerName} API key is missing. Run dumbeditor setup.`);
  const request = options.request.trim();
  if (!request) throw new Error("Agent request cannot be empty.");
  const runId = randomUUID();
  const toolMap = new Map(options.tools.map((tool) => [tool.name, tool]));
  const input: InputItem[] = conversationItems(options.history, request, editorState(options));
  let toolCalls = 0;
  let mutations = 0;
  let costUsd = 0;
  let auditedSinceMutation = true;

  let round = 0;
  while (true) {
    options.onStage?.(round === 0 ? "planning the edit" : "reviewing tool results");
    const response = await fetch(provider === "openrouter" ? "https://openrouter.ai/api/v1/responses" : "https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        reasoning: { effort: "medium" },
        store: false,
        ...(provider === "openai" ? {
          include: ["reasoning.encrypted_content"],
          context_management: [{ type: "compaction", compact_threshold: 800_000 }],
        } : { session_id: runId }),
        parallel_tool_calls: false,
        tool_choice: "auto",
        instructions: agentInstructions(runId, options.model),
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
    if (!response.ok) throw new Error(`${providerName} agent request failed: ${payload.error?.message ?? `HTTP ${response.status}`}`);
    if (payload.usage) {
      const reportedCost = provider === "openrouter"
        ? await openRouterResponseCost(payload, response, apiKey, options.signal)
        : undefined;
      const usage = calculateLunaUsage(payload.usage, options.model, provider, reportedCost);
      costUsd += usage.costUsd;
      await options.onUsage?.(usage);
    }
    const output = payload.output ?? [];
    round += 1;
    await options.onLedger?.("response", output);
    input.push(...output as InputItem[]);
    const calls = output.filter(isFunctionCall);
    if (calls.length === 0) {
      if (mutations > 0 && !auditedSinceMutation) {
        input.push({ role: "developer", content: [{ type: "input_text", text: "Before finishing, visually audit the current rendered version with inspect_video_frames. Sample the edited ranges and enough surrounding frames to catch timing, layout, or rendering mistakes. If the audit finds a problem, correct it and audit again." }] });
        continue;
      }
      const message = responseText(payload);
      if (!message) throw new Error(`${options.model} finished without an edit summary or response.`);
      return { message, model: options.model, toolCalls, mutations, costUsd };
    }

    const toolOutputs: InputItem[] = [];
    for (const call of calls) {
      toolCalls += 1;
      const tool = toolMap.get(call.name);
      let result: AgentToolResult;
      if (!tool) result = { ok: false, message: `Unknown tool: ${call.name}` };
      else {
        if (tool.mutatesProject) {
          mutations += 1;
          auditedSinceMutation = false;
        }
        options.onStage?.(humanize(call.name));
        result = await runTool(tool, call.arguments);
        if (tool.auditsProject && result.ok) auditedSinceMutation = true;
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
}

export function calculateLunaUsage(
  usage: NonNullable<ResponsePayload["usage"]>,
  model = "gpt-6-luna",
  provider: ModelProvider = "openai",
  reportedCost?: number,
): LunaUsage {
  const inputTokens = positive(usage.input_tokens);
  const cachedInputTokens = Math.min(inputTokens, positive(usage.input_tokens_details?.cached_tokens));
  const cacheWriteTokens = Math.min(inputTokens - cachedInputTokens, positive(usage.input_tokens_details?.cache_write_tokens));
  const ordinaryInputTokens = Math.max(0, inputTokens - cachedInputTokens - cacheWriteTokens);
  const outputTokens = positive(usage.output_tokens);
  const longContext = inputTokens > 272_000;
  const base = modelPrices(model);
  const perMillion = longContext
    ? { input: base.input * 2, cached: base.cached * 2, cacheWrite: base.cacheWrite * 2, output: base.output * 1.5 }
    : base;
  const estimatedCostUsd = (
    ordinaryInputTokens * perMillion.input
    + cachedInputTokens * perMillion.cached
    + cacheWriteTokens * perMillion.cacheWrite
    + outputTokens * perMillion.output
  ) / 1_000_000;
  const hasReportedCost = provider === "openrouter" && Number.isFinite(reportedCost) && Number(reportedCost) >= 0;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    costUsd: hasReportedCost ? Number(reportedCost) : estimatedCostUsd,
    estimated: provider === "openrouter" && !hasReportedCost,
  };
}

async function openRouterResponseCost(
  payload: ResponsePayload,
  response: Response,
  apiKey: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  if (Number.isFinite(payload.usage?.cost) && Number(payload.usage?.cost) >= 0) return Number(payload.usage?.cost);
  const generationId = response.headers.get("x-generation-id")?.trim();
  if (!generationId) return undefined;
  try {
    const metadataResponse = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!metadataResponse.ok) return undefined;
    const metadata = await metadataResponse.json().catch(() => ({})) as { data?: { total_cost?: number; usage?: number } };
    const cost = metadata.data?.total_cost ?? metadata.data?.usage;
    return Number.isFinite(cost) && Number(cost) >= 0 ? Number(cost) : undefined;
  } catch {
    return undefined;
  }
}

function modelPrices(model: string): { input: number; cached: number; cacheWrite: number; output: number } {
  const prices: Record<string, { input: number; output: number }> = {
    "gpt-6-luna": { input: 0.10, output: 0.50 },
    "gpt-6-sol": { input: 2, output: 10 },
    "gpt-6-astra": { input: 10, output: 50 },
  };
  const selected = prices[model] ?? prices["gpt-6-luna"]!;
  return { input: selected.input, cached: selected.input * 0.1, cacheWrite: selected.input * 1.25, output: selected.output };
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
    items.push({
      role: message.role,
      content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content }],
    });
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

function agentInstructions(runId: string, model: string): string {
  return [
    `You are ${model}, the main DumbEditor video-editing agent.`,
    "Use the supplied tools to complete the user's request; you may call several tools in sequence.",
    "Inspect available state, generated assets, and tool results before claiming that work is complete.",
    "Prefer deterministic local editing tools. Generate paid assets only when the request actually needs them.",
    "When the user asks to add or generate subtitles and the video has audio, call transcribe_and_add_subtitles; do not ask them to provide a transcript first.",
    "When no specialized edit tool fits, inspect the available general workspace and rendering tools and devise a method before saying the edit is unavailable.",
    "After every rendered mutation, inspect frames from the current output around the changed ranges before you finish. The harness enforces a final visual audit.",
    "You may delegate unusually complex scripting or media-pipeline work to the optional Claude coding harness. In ask mode, model switches and sensitive tools pause for user approval; in auto mode the configured policy decides.",
    "When several reasonable creative directions would benefit from a user decision, call present_choices instead of printing a list. Continue using the selected or custom answer returned by that tool.",
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
