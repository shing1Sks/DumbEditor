import { randomUUID } from "node:crypto";
import {
  Agent,
  type AgentEvent,
  type AgentLoopTurnUpdate,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  type AgentTurnContext,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type PrepareNextTurnContext,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Message, Model, Models, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ChatMessage } from "../../types.js";
import type { ActionRegistry } from "../actions/registry.js";
import type { Action, ActionContext, ActionProgress, ActionResult, Risk } from "../actions/types.js";
import type { AgentSkill } from "../agent-skills.js";
import type { ChoiceRequest } from "../choice.js";
import { createCostTracker, type CostTracker } from "../pi/cost.js";
import { compact, estimateContextTokens, NothingToCompactError, shouldCompact, type CompactionResult } from "../pi/compaction.js";
import { createEditorStateSync } from "../pi/editor-state-sync.js";
import { createStreamFn, EDITOR_STREAM_DEFAULTS, openRouterModel, type OpenRouterModelInfo } from "../pi/models.js";
import { toolFromJsonSchema } from "../pi/tools.js";
import type { SessionStore } from "../session/session-store.js";
import type { DumbEditorSettings } from "../settings.js";
import type { EditorState } from "../state/editor-state.js";
import { formatUsd } from "../usage.js";
import type { ApprovalDecision, EngineEvent } from "./events.js";
import { AUDIT_NUDGE, agentSystemPrompt } from "./prompt.js";

/** Compact when the transcript passes this share of the model's context window. */
export const COMPACTION_THRESHOLD = 0.6;
/** Tokens of the newest conversation kept verbatim when compacting. */
export const KEEP_RECENT_TOKENS = 20_000;
const MAX_AUDIT_NUDGES = 2;
const MAX_TOOL_TEXT = 50_000;
const DEFAULT_STALL_MS = 5 * 60_000;

export interface EngineOptions {
  state: EditorState;
  registry: ActionRegistry;
  session: SessionStore;
  models: Models;
  /** OpenRouter model id used for the agent. */
  modelId: string;
  /** Read on every run so /permissions and /budget apply immediately. */
  getSettings: () => DumbEditorSettings;
  skills?: readonly AgentSkill[];
  /** Recent project chat, used to seed a project that has no agent session yet. */
  chatSeed?: readonly ChatMessage[];
  /** Milliseconds a model response may stay silent before the run is stopped. */
  stallMs?: number;
  /** Tokens of newest conversation kept verbatim when compacting. */
  keepRecentTokens?: number;
  /** OpenRouter's list entry for `modelId`, for models pi's catalog does not know yet (context window, prices, reasoning). */
  modelInfo?: OpenRouterModelInfo;
  /** Test seams: a prebuilt model, stream function and cost source (for example pi's faux provider). */
  model?: Model<Api>;
  streamFn?: StreamFn;
  tracker?: CostTracker;
}

interface ToolDetails {
  summary: string;
  versionId?: string;
}

interface RunState {
  id: string;
  request: string;
  controller: AbortController;
  /** The project's total spend when the run began; everything recorded since then belongs to this run. */
  startUsageUsd: number;
  ceilingUsd: number;
  nudges: number;
  mutatedSinceAudit: boolean;
  abortRequested: boolean;
  budgetStopped: boolean;
  failed: boolean;
  /** Newest assistant message of this run; compaction can replace the transcript mid-run. */
  lastAssistant?: AssistantMessage;
  stallTimer?: NodeJS.Timeout;
}

/**
 * The agent for one open project. It owns the pi Agent and turns everything the agent does into
 * EngineEvents; clients call submit/abort/resolve* and never see pi.
 */
export class Engine {
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private readonly agent: Agent;
  private readonly model: Model<Api>;
  private readonly tracker: CostTracker;
  private readonly compactionTracker = createCostTracker();
  private readonly compactionStreamFn: StreamFn;
  private readonly sync;
  private readonly approvals = new Map<string, (decision: ApprovalDecision) => void>();
  private readonly choices = new Map<string, (answer: string | null) => void>();
  private readonly sessionAllowed = new Set<string>();
  private run: RunState | null = null;
  private compacting = false;

  static async create(options: EngineOptions): Promise<Engine> {
    let messages = await options.session.load();
    if (messages.length === 0 && options.chatSeed && options.chatSeed.length > 0) {
      const seed = seedMessage(options.chatSeed);
      if (seed) {
        messages = [seed];
        await options.session.appendMessage(seed);
      }
    }
    return new Engine(options, messages);
  }

  /** Like `create`, but explains a failure (for example an unreadable session file) instead of throwing. */
  static async tryCreate(options: EngineOptions): Promise<{ engine: Engine; error?: undefined } | { engine: null; error: string }> {
    try {
      return { engine: await Engine.create(options) };
    } catch (error) {
      return { engine: null, error: errorText(error) };
    }
  }

  private constructor(private readonly options: EngineOptions, messages: AgentMessage[]) {
    this.model = options.model ?? openRouterModel(options.models, options.modelId, options.modelInfo ? { info: options.modelInfo } : {});
    this.tracker = options.tracker ?? createCostTracker();
    const streamFn = options.streamFn
      ?? createStreamFn(options.models, { ...EDITOR_STREAM_DEFAULTS, onProviderStreamEvent: this.tracker.onProviderStreamEvent });
    this.compactionStreamFn = options.streamFn
      ?? createStreamFn(options.models, { ...EDITOR_STREAM_DEFAULTS, onProviderStreamEvent: this.compactionTracker.onProviderStreamEvent });
    this.sync = createEditorStateSync(() => options.state.describe());
    this.agent = new Agent({
      initialState: {
        systemPrompt: agentSystemPrompt(options.skills ?? []),
        model: this.model,
        thinkingLevel: this.model.reasoning ? "medium" : "off",
        tools: options.registry.list().map((action) => this.toolFor(action)),
        messages,
      },
      streamFn,
      sessionId: randomUUID(),
      toolExecution: "sequential",
      steeringMode: "all",
      beforeToolCall: (context, signal) => this.beforeToolCall(context, signal),
      finishTurn: (turn, signal) => this.finishTurn(turn, signal),
      prepareNextTurnWithContext: (turn, signal) => this.prepareNextTurn(turn, signal),
    });
    this.agent.subscribe((event) => this.onAgentEvent(event));
  }

  get running(): boolean {
    return this.run !== null;
  }

  on(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Start a run, or queue the text as steering when one is already active. */
  submit(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.compacting) {
      this.emit({ type: "error", message: "Context compaction is running. Try again in a moment.", retryable: true });
      return;
    }
    if (this.run) {
      this.agent.steer({ role: "user", content: trimmed, timestamp: Date.now() });
      this.emit({ type: "steer_queued", text: trimmed });
      return;
    }
    void this.execute(trimmed);
  }

  abort(): void {
    const run = this.run;
    if (!run) return;
    run.abortRequested = true;
    run.controller.abort();
    this.agent.abort();
    for (const resolve of this.approvals.values()) resolve("deny");
    this.approvals.clear();
    for (const resolve of this.choices.values()) resolve(null);
    this.choices.clear();
  }

  resolveApproval(id: string, decision: ApprovalDecision): void {
    const resolve = this.approvals.get(id);
    this.approvals.delete(id);
    resolve?.(decision);
  }

  resolveChoice(id: string, answer: string | null): void {
    const resolve = this.choices.get(id);
    this.choices.delete(id);
    resolve?.(answer);
  }

  /** Summarize older conversation now. Returns false when there was nothing to compact. */
  async compact(): Promise<boolean> {
    if (this.run) throw new Error("Wait for the current run to finish before compacting.");
    if (this.compacting) return false;
    this.compacting = true;
    try {
      const result = await this.compactTranscript(this.agent.state.messages);
      if (!result) return false;
      this.agent.state.messages = result.messages;
      return true;
    } finally {
      this.compacting = false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------------------------

  private async execute(text: string): Promise<void> {
    const settings = this.options.getSettings();
    const run: RunState = {
      id: randomUUID(),
      request: text,
      controller: new AbortController(),
      startUsageUsd: this.options.state.usage.totalUsd,
      ceilingUsd: ceilingOf(settings),
      nudges: 0,
      mutatedSinceAudit: false,
      abortRequested: false,
      budgetStopped: false,
      failed: false,
    };
    this.run = run;
    this.emit({ type: "run_start", runId: run.id });
    try {
      if (shouldCompact(this.agent.state.messages, this.model.contextWindow, { thresholdRatio: COMPACTION_THRESHOLD })) {
        const result = await this.compactTranscript(this.agent.state.messages, run.controller.signal);
        if (result) this.agent.state.messages = result.messages;
      }
      if (!run.controller.signal.aborted) {
        await this.pinVersion(this.options.state.store.current.id);
        await this.agent.prompt(this.sync.wrapPrompt(text));
      }
    } catch (error) {
      run.failed = true;
      this.emit({ type: "error", message: errorText(error), retryable: true });
    } finally {
      await this.finishRun(run);
    }
  }

  private async finishRun(run: RunState): Promise<void> {
    if (run.stallTimer) clearTimeout(run.stallTimer);
    const leftover = this.takeLeftoverSteering();
    try {
      await this.closeUnansweredToolCalls();
    } catch (error) {
      this.emit({ type: "error", message: `Could not save the cancelled run: ${errorText(error)}`, retryable: false });
    }
    const last = run.lastAssistant;
    let reason: "done" | "aborted" | "error" | "budget" = "done";
    if (run.budgetStopped) reason = "budget";
    else if (run.abortRequested) reason = "aborted";
    else if (run.failed) reason = "error";
    else if (last?.stopReason === "aborted") reason = "aborted";
    else if (last?.stopReason === "error") {
      reason = "error";
      this.emit({ type: "error", message: last.errorMessage ?? "The model request failed.", retryable: true });
    }
    this.run = null;
    if (reason !== "done" && leftover.length > 0) this.emit({ type: "steer_dropped", texts: leftover });
    this.emit({ type: "run_end", reason, message: reason === "done" && last ? textOf(last) : "" });
    // Text typed after the loop's last steering check would otherwise vanish: run it as a follow-up.
    if (reason === "done" && leftover.length > 0) this.submit(leftover.join("\n\n"));
  }

  /** Empty the steering queue, returning what the user typed (audit reminders are dropped). */
  private takeLeftoverSteering(): string[] {
    const texts = this.agent.peekQueuedMessages()
      .map((message) => message.role === "user" && typeof message.content === "string" ? message.content : "")
      .filter((text) => text !== "" && !text.startsWith("[system]"));
    this.agent.clearAllQueues();
    return texts;
  }

  /**
   * After an abort in sequential mode, a tool call can be left without a result. Close each one with a
   * "Cancelled" result so the saved transcript stays valid and the model knows what did not happen.
   */
  private async closeUnansweredToolCalls(): Promise<void> {
    const messages = this.agent.state.messages;
    let callIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant" && (message as AssistantMessage).content.some((block) => block.type === "toolCall")) {
        callIndex = index;
        break;
      }
    }
    if (callIndex < 0) return;
    const answered = new Set<string>();
    let insertAt = callIndex + 1;
    for (let index = callIndex + 1; index < messages.length; index += 1) {
      const message = messages[index];
      if (message?.role !== "toolResult") break;
      answered.add((message as ToolResultMessage).toolCallId);
      insertAt = index + 1;
    }
    const missing = (messages[callIndex] as AssistantMessage).content
      .filter((block): block is ToolCall => block.type === "toolCall" && !answered.has(block.id));
    if (missing.length === 0) return;
    const synthetic: ToolResultMessage[] = missing.map((call) => ({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "Cancelled by user before this tool ran." }],
      isError: true,
      timestamp: Date.now(),
    }));
    const next = [...messages.slice(0, insertAt), ...synthetic, ...messages.slice(insertAt)];
    this.agent.state.messages = next;
    await this.options.session.appendReplace(next);
  }

  // ---------------------------------------------------------------------------------------------
  // pi hooks
  // ---------------------------------------------------------------------------------------------

  private async onAgentEvent(event: AgentEvent): Promise<void> {
    const run = this.run;
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        if (run) this.armStallTimer(run);
        break;
      case "message_start":
        if (run && event.message.role === "assistant") this.armStallTimer(run);
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (run) this.armStallTimer(run);
        if (update.type === "text_delta") this.emit({ type: "text_delta", text: update.delta });
        else if (update.type === "thinking_delta") this.emit({ type: "thinking_delta", text: update.delta });
        break;
      }
      case "message_end":
        if (run && event.message.role === "assistant") {
          if (run.stallTimer) clearTimeout(run.stallTimer);
          run.lastAssistant = event.message as AssistantMessage;
        }
        await this.options.session.appendMessage(event.message);
        break;
      case "turn_end":
        if (run && event.message.role === "assistant") await this.recordTurnCost(run, event.message as AssistantMessage);
        break;
      case "tool_execution_start":
        this.emit({
          type: "tool_start", callId: event.toolCallId, name: event.toolName,
          summary: this.safeDescribe(event.toolName, event.args), risk: this.safeRisk(event.toolName, event.args),
        });
        break;
      case "tool_execution_update": {
        const details = (event.partialResult as { details?: { stage?: string; fraction?: number } } | undefined)?.details;
        if (details?.stage) {
          this.emit({
            type: "tool_progress", callId: event.toolCallId, stage: details.stage,
            ...(typeof details.fraction === "number" ? { fraction: details.fraction } : {}),
          });
        }
        break;
      }
      case "tool_execution_end": {
        const details = (event.result as AgentToolResult<ToolDetails> | undefined)?.details;
        const versionId = details?.versionId;
        if (run && !event.isError) {
          if (versionId) run.mutatedSinceAudit = true;
          if (this.options.registry.get(event.toolName)?.audits) run.mutatedSinceAudit = false;
        }
        this.emit({
          type: "tool_end", callId: event.toolCallId, ok: !event.isError,
          summary: details?.summary ?? textOfResult(event.result), ...(versionId ? { versionId } : {}),
        });
        break;
      }
      default:
        break;
    }
  }

  private armStallTimer(run: RunState): void {
    if (run.stallTimer) clearTimeout(run.stallTimer);
    run.stallTimer = setTimeout(() => {
      run.failed = true;
      this.emit({ type: "error", message: "The model stopped responding, so the run was stopped.", retryable: true });
      run.controller.abort();
      this.agent.abort();
    }, this.options.stallMs ?? DEFAULT_STALL_MS);
    run.stallTimer.unref();
  }

  private async recordTurnCost(run: RunState, message: AssistantMessage): Promise<void> {
    const cost = this.tracker.takeCost(message);
    if (!cost || (cost.costUsd === 0 && message.usage.totalTokens === 0)) return;
    await this.options.state.recordUsage({
      kind: "agent", provider: "openrouter", model: this.options.modelId, label: run.request.slice(0, 160),
      costUsd: cost.costUsd, estimated: cost.estimated,
      inputTokens: message.usage.input, cachedInputTokens: message.usage.cacheRead,
      cacheWriteTokens: message.usage.cacheWrite, outputTokens: message.usage.output,
    });
    this.emit({ type: "usage", runCostUsd: this.spentThisRun(run), estimated: cost.estimated });
  }

  private async beforeToolCall(context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> {
    const name = context.toolCall.name;
    const risk = this.safeRisk(name, context.args);
    if (risk === "read" || risk === "edit") return undefined;
    // Paid actions count toward the run's limit, so check it before each one, whatever the permission mode.
    if (risk === "spend" && this.run && !(await this.withinBudget(this.run, signal))) {
      return { block: true, reason: "The run stopped at its spend limit." };
    }
    if (this.options.getSettings().agent.permissionMode === "auto" || this.sessionAllowed.has(name)) return undefined;
    const decision = await this.askApproval({
      kind: "action", callId: context.toolCall.id, name,
      summary: this.safeDescribe(name, context.args), risk, args: context.args,
    }, signal);
    if (decision === "deny") return { block: true, reason: "The user denied this action. Do not retry it; adapt or explain." };
    if (decision === "session") this.sessionAllowed.add(name);
    return undefined;
  }

  /** Nudge the model to audit its output before it stops, at most twice per run. */
  private async finishTurn(turn: AgentTurnContext, signal?: AbortSignal): Promise<undefined> {
    const run = this.run;
    if (!run || turn.message.stopReason !== "stop" || signal?.aborted) return undefined;
    if (run.mutatedSinceAudit && run.nudges < MAX_AUDIT_NUDGES) {
      run.nudges += 1;
      this.agent.steer({ role: "user", content: AUDIT_NUDGE, timestamp: Date.now() });
    }
    return undefined;
  }

  private async prepareNextTurn(turn: PrepareNextTurnContext, signal?: AbortSignal): Promise<AgentLoopTurnUpdate | undefined> {
    const run = this.run;
    if (run && !(await this.withinBudget(run, signal))) return undefined;
    const update: AgentLoopTurnUpdate = {};
    if (shouldCompact(turn.context.messages, this.model.contextWindow, { thresholdRatio: COMPACTION_THRESHOLD })) {
      const result = await this.compactTranscript(turn.context.messages, signal);
      if (result) {
        this.agent.state.messages = result.messages;
        update.context = { ...turn.context, messages: [...result.messages] };
      }
    }
    const state = this.sync.prepareNextTurn();
    if (state?.messages) update.messages = state.messages;
    return update.context || update.messages ? update : undefined;
  }

  private async withinBudget(run: RunState, signal?: AbortSignal): Promise<boolean> {
    const spent = this.spentThisRun(run);
    if (spent < run.ceilingUsd) return true;
    const decision = await this.askApproval({
      kind: "budget", risk: "budget",
      summary: `This run has spent ${formatUsd(spent)}, over its ${formatUsd(run.ceilingUsd)} limit. Continue?`,
    }, signal);
    if (decision === "deny") {
      run.budgetStopped = true;
      this.agent.abort();
      return false;
    }
    run.ceilingUsd += ceilingOf(this.options.getSettings());
    return true;
  }

  /** Model turns, compaction and paid actions all land in the project's usage ledger, so one number covers them. */
  private spentThisRun(run: RunState): number {
    return Math.max(0, this.options.state.usage.totalUsd - run.startUsageUsd);
  }

  /** Versions the agent has seen are kept past retention so it can still compare with or revert to them. */
  private async pinVersion(id: string): Promise<void> {
    await this.options.state.store.pinVersion(id);
  }

  private async compactTranscript(messages: readonly AgentMessage[], signal?: AbortSignal): Promise<CompactionResult | undefined> {
    this.emit({ type: "compaction", phase: "start" });
    try {
      const result = await compact(messages, {
        model: this.model, streamFn: this.compactionStreamFn, keepRecentTokens: this.options.keepRecentTokens ?? KEEP_RECENT_TOKENS,
        ...(signal ? { signal } : {}),
      });
      const cost = this.compactionTracker.takeCost({ usage: result.usage, ...(result.responseId ? { responseId: result.responseId } : {}) });
      if (cost) {
        await this.options.state.recordUsage({
          kind: "agent", provider: "openrouter", model: this.options.modelId, label: "Context compaction",
          costUsd: cost.costUsd, estimated: cost.estimated,
          inputTokens: result.usage.input, cachedInputTokens: result.usage.cacheRead,
          cacheWriteTokens: result.usage.cacheWrite, outputTokens: result.usage.output,
        });
      }
      await this.options.session.appendCompaction({
        summaryMessage: result.summaryMessage, keptCount: result.keptMessages.length, tokensBefore: result.tokensBefore,
      });
      // The newest editor state may have been summarized away; send it again on the next turn.
      this.sync.syncFromTranscript([]);
      this.emit({
        type: "compaction", phase: "end", tokensBefore: result.tokensBefore,
        tokensAfter: estimateContextTokens(result.messages as Message[]).tokens,
      });
      return result;
    } catch (error) {
      if (!(error instanceof NothingToCompactError)) {
        this.emit({ type: "error", message: `Context compaction failed: ${errorText(error)}`, retryable: true });
      }
      this.emit({ type: "compaction", phase: "end" });
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Tools, approvals, choices
  // ---------------------------------------------------------------------------------------------

  private toolFor(action: Action<any>): AgentTool<any> {
    return toolFromJsonSchema<Record<string, unknown>, ToolDetails>({
      name: action.name,
      description: action.description,
      jsonSchema: action.schema,
      strict: true,
      execute: async (_callId, args, signal, onUpdate) => {
        const progress = (update: ActionProgress) => onUpdate?.({
          content: [{ type: "text", text: update.stage }],
          details: { summary: update.stage, stage: update.stage, ...(update.fraction === undefined ? {} : { fraction: update.fraction }) } as ToolDetails,
        });
        const result = await this.options.registry.run(action.name, args, this.contextFor(signal, progress));
        if (result.versionId) await this.pinVersion(result.versionId);
        return toToolResult(result);
      },
    });
  }

  private contextFor(signal: AbortSignal | undefined, progress: (update: ActionProgress) => void): ActionContext {
    return {
      state: this.options.state,
      settings: this.options.getSettings(),
      signal: signal ?? this.run?.controller.signal ?? new AbortController().signal,
      request: this.run?.request ?? "",
      progress,
      requestChoice: (request) => this.askChoice(request, signal),
    };
  }

  private askApproval(request: Omit<Extract<EngineEvent, { type: "approval_request" }>, "type" | "id">, signal?: AbortSignal): Promise<ApprovalDecision> {
    const id = randomUUID();
    return new Promise<ApprovalDecision>((resolve) => {
      if (signal?.aborted) { resolve("deny"); return; }
      this.approvals.set(id, resolve);
      signal?.addEventListener("abort", () => { this.approvals.delete(id); resolve("deny"); }, { once: true });
      this.emit({ type: "approval_request", id, ...request });
    });
  }

  private askChoice(request: ChoiceRequest, signal?: AbortSignal): Promise<string | null> {
    const id = randomUUID();
    return new Promise<string | null>((resolve) => {
      if (signal?.aborted) { resolve(null); return; }
      this.choices.set(id, resolve);
      signal?.addEventListener("abort", () => { this.choices.delete(id); resolve(null); }, { once: true });
      this.emit({ type: "choice_request", id, question: request.question, options: request.options, allowCustom: request.allowCustom });
    });
  }

  private safeRisk(name: string, args: unknown): Risk {
    try { return this.options.registry.riskOf(name, args); } catch { return "read"; }
  }

  private safeDescribe(name: string, args: unknown): string {
    try { return this.options.registry.describe(name, args); } catch { return name; }
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function toToolResult(result: ActionResult): AgentToolResult<ToolDetails> {
  let text = result.data ? `${result.text}\n${JSON.stringify(result.data)}` : result.text;
  if (text.length > MAX_TOOL_TEXT) text = `${text.slice(0, MAX_TOOL_TEXT)}\n[... ${text.length - MAX_TOOL_TEXT} more characters truncated]`;
  const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
  for (const image of result.images ?? []) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  return { content, details: { summary: result.text.slice(0, 200), ...(result.versionId ? { versionId: result.versionId } : {}) } };
}

function ceilingOf(settings: DumbEditorSettings): number {
  return settings.agent.spendCeilingUsd > 0 ? settings.agent.spendCeilingUsd : Number.POSITIVE_INFINITY;
}

function textOf(message: AssistantMessage): string {
  return message.content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("").trim();
}

function textOfResult(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
  return content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("").slice(0, 200);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One user message carrying recent chat, so a project from before agent sessions keeps its context. */
export function seedMessage(chat: readonly ChatMessage[]): AgentMessage | undefined {
  const lines: string[] = [];
  let budget = 8_000;
  for (const message of chat.slice(-20).reverse()) {
    const line = `[${message.role === "user" ? "User" : "Assistant"}]: ${message.content.slice(0, 600)}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.unshift(line);
  }
  if (lines.length === 0) return undefined;
  return { role: "user", content: `<previous_conversation>\n${lines.join("\n")}\n</previous_conversation>`, timestamp: Date.now() };
}
