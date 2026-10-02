/**
 * Context compaction for DumbEditor, operating on plain `AgentMessage[]`.
 *
 * VENDORED AND ADAPTED from pi-coding-agent's compaction
 * (https://github.com/earendil-works/pi, packages/coding-agent/src/core/compaction/compaction.ts
 * and utils.ts), MIT License.
 *
 *   MIT License
 *   Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright notice and this
 * permission notice shall be included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. (Full text: pi's LICENSE file.)
 *
 * Changes from upstream:
 *  - no session classes / entries / extensions; works on a plain message array and returns data.
 *  - summarizer goes through an injected `streamFn` (no global `completeSimple` from pi-ai/compat).
 *  - summary checkpoint gains a "## Visual findings" section (image blocks are dropped when the
 *    conversation is serialized to text, so whatever a frame showed must be written down).
 *  - serialization marks dropped images with `[image omitted]` so the summarizer knows where they were.
 *  - the summary is a plain `user` message (no custom message role / convertToLlm needed).
 *  - split-turn handling is simplified: everything before the cut goes into ONE summary call.
 *  - file-operation tracking (read/write/edit tool names) is dropped; DumbEditor has different tools.
 *  - token estimation comes from pi-ai (`@earendil-works/pi-ai/utils/estimate`).
 */
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  contentText,
  getCurrentSystemMessage,
  type Message,
  type Model,
  normalizeContext,
  type RetryPolicy,
  retryAssistantCall,
  type SimpleStreamOptions,
  type SystemMessage,
  type TranscriptContext,
  uuidv7,
} from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";

export { calculateContextTokens, estimateContextTokens };

// ============================================================================
// Prompts (pi's structured checkpoint + Visual findings)
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const VISUAL_FINDINGS_SECTION = `## Visual findings
- [Images, video frames and screenshots are NOT included in the conversation above; each place where one was inspected is marked "[image omitted]". For every inspected frame/image, record AS TEXT what it showed: which clip/timestamp it came from, what was visible (subjects, on-screen text, framing, colors, quality problems), and any decision it led to. This section is the ONLY surviving record of what was seen.]
- [Or "(none)" if no images were inspected]`;

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

${VISUAL_FINDINGS_SECTION}

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- PRESERVE every existing entry in "Visual findings" and ADD entries for newly inspected images/frames
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

${VISUAL_FINDINGS_SECTION}

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

// ============================================================================
// Serialization (pi utils.ts, plus image markers)
// ============================================================================

/** Maximum characters for a tool result in serialized summaries (pi: 2000). */
export const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

function imageMarker(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const images = content.filter((b) => b?.type === "image");
  if (images.length === 0) return "";
  const kinds = [...new Set(images.map((b) => b.mimeType))].join(", ");
  return `[${images.length} image${images.length > 1 ? "s" : ""} omitted: ${kinds}]`;
}

/**
 * Serialize LLM messages to text for summarization (so the model does not treat it as a conversation
 * to continue). Tool results are truncated; image blocks are replaced by `[image omitted]` markers
 * (the base64 data never reaches the summarizer). System messages are skipped.
 */
export function serializeConversation(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = [contentText(msg.content, ""), imageMarker(msg.content)].filter(Boolean).join(" ");
      if (text) parts.push(`[User]: ${text}`);
    } else if (msg.role === "assistant") {
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];
      for (const block of msg.content) {
        if (block.type === "thinking") {
          thinkingParts.push(block.thinking);
        } else if (block.type === "toolCall") {
          const args = block.arguments as Record<string, unknown>;
          const argsStr = Object.entries(args)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ");
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }
      if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
      if (msg.content.some((block) => block.type === "text")) parts.push(`[Assistant]: ${contentText(msg.content)}`);
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
    } else if (msg.role === "toolResult") {
      const text = contentText(msg.content, "");
      const marker = imageMarker(msg.content);
      const body = [text ? truncateForSummary(text, TOOL_RESULT_MAX_CHARS) : "", marker].filter(Boolean).join(" ");
      if (body) parts.push(`[Tool result]: ${body}`);
    }
  }
  return parts.join("\n\n");
}

// ============================================================================
// Token accounting / thresholds
// ============================================================================

export interface ShouldCompactOptions {
  /** Compact when estimated context tokens exceed `contextWindow * thresholdRatio`. Default 0.6. */
  thresholdRatio?: number;
}

/**
 * Real usage from the last valid assistant message (non-aborted, non-error, usage > 0) plus a
 * chars/4 estimate for everything after it; if no assistant usage applies, estimates everything.
 *
 * pi-ai's `estimateContextTokens` ignores an assistant's usage when a LATER-timestamped message precedes it
 * in the array (e.g. a fresh compaction summary): stale pre-compaction usage must not retrigger compaction.
 */
export function shouldCompact(messages: readonly AgentMessage[], contextWindow: number, opts: ShouldCompactOptions = {}): boolean {
  if (!(contextWindow > 0)) return false;
  const ratio = opts.thresholdRatio ?? 0.6;
  return estimateContextTokens(messages as Message[]).tokens > contextWindow * ratio;
}

// ============================================================================
// Cut point
// ============================================================================

function isCutPoint(message: AgentMessage): boolean {
  return message.role === "user" || message.role === "assistant"; // never "toolResult", never "system"
}

/** Index of the first non-system message (where the conversation starts). */
function firstConversationIndex(messages: readonly AgentMessage[]): number {
  const i = messages.findIndex((m) => m.role !== "system");
  return i === -1 ? messages.length : i;
}

/**
 * Index of the first message to KEEP. Everything before it (except system messages) gets summarized.
 *
 * Walk backwards from the newest message accumulating estimated sizes; when the budget
 * (`keepRecentTokens`) is reached at message i, cut at the closest user/assistant message at or after i
 * (pi's rule). A tool result is never a cut point, so an assistant message's tool calls always stay
 * with their results: cutting AT the assistant message keeps both, cutting AFTER its results drops both.
 *
 * Returns the first conversation index (= nothing to summarize) when the whole conversation fits the budget.
 */
export function findCutIndex(messages: readonly AgentMessage[], keepRecentTokens = 20_000): number {
  const start = firstConversationIndex(messages);
  const cutPoints: number[] = [];
  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (message && isCutPoint(message)) cutPoints.push(i);
  }
  if (cutPoints.length === 0) return start;

  let accumulated = 0;
  for (let i = messages.length - 1; i >= start; i--) {
    accumulated += estimateMessageTokens(messages[i] as Message);
    if (accumulated >= keepRecentTokens) {
      return cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1] ?? start;
    }
  }
  return start;
}

// ============================================================================
// Summarization
// ============================================================================

/** The summarizer call: `streamFn` (preferred; e.g. createStreamFn) or any completeSimple-compatible fn. */
export type CompleteFn = (model: Model<any>, context: TranscriptContext, options: SimpleStreamOptions) => Promise<AssistantMessage>;

export interface CompactOptions {
  model: Model<any>;
  /** One of `streamFn` / `complete` is required. */
  streamFn?: StreamFn;
  complete?: CompleteFn;
  /** Default 20000. */
  keepRecentTokens?: number;
  /** Output budget basis: maxTokens = min(0.8 * reserveTokens, model.maxTokens). Default 16384 (pi). */
  reserveTokens?: number;
  signal?: AbortSignal;
  /** Summary text from an earlier compaction. Auto-detected from a leading summary message if omitted. */
  previousSummary?: string;
  /** Extra instruction appended to the prompt ("Additional focus: ..."). */
  customInstructions?: string;
  /** Routing id for the summary request (a fresh uuidv7 when omitted, like pi). */
  sessionId?: string;
  apiKey?: string;
  retry?: RetryPolicy;
}

export interface CompactionResult {
  /** Plain `user` message; timestamp = now so stale pre-compaction usage is ignored by estimates. */
  summaryMessage: AgentMessage;
  /** Messages from the cut onward, WITHOUT system messages. */
  keptMessages: AgentMessage[];
  tokensBefore: number;
  /** Replayed head (prompt + sections + tools) of the original transcript, to put in front. */
  systemMessage?: SystemMessage;
  /** Ready to use: [systemMessage?, summaryMessage, ...keptMessages]. */
  messages: AgentMessage[];
  /** The raw summary text (without the wrapper prefix) for storage / `previousSummary`. */
  summary: string;
  /** Usage of the summarizer call itself (bill it). */
  usage: AssistantMessage["usage"];
  /** Provider response id of the summarizer call, to look up its real cost. */
  responseId?: string;
}

export class NothingToCompactError extends Error {
  constructor() {
    super("Nothing to compact: the conversation fits within keepRecentTokens");
    this.name = "NothingToCompactError";
  }
}

export function isSummaryMessage(message: AgentMessage): boolean {
  if (message.role !== "user") return false;
  const text = typeof message.content === "string" ? message.content : contentText(message.content);
  return text.startsWith(COMPACTION_SUMMARY_PREFIX);
}

function extractSummary(message: AgentMessage): string {
  const content = (message as any).content;
  const raw: string = typeof content === "string" ? content : contentText(content);
  const body = raw.slice(COMPACTION_SUMMARY_PREFIX.length);
  return body.endsWith(COMPACTION_SUMMARY_SUFFIX) ? body.slice(0, -COMPACTION_SUMMARY_SUFFIX.length) : body;
}

export function createSummaryMessage(summary: string, timestamp = Date.now()): AgentMessage {
  return { role: "user", content: [{ type: "text", text: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX }], timestamp };
}

function buildSummarizationContext(promptText: string): TranscriptContext {
  return normalizeContext({
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
  });
}

export async function compact(messages: readonly AgentMessage[], opts: CompactOptions): Promise<CompactionResult> {
  if (!opts.streamFn && !opts.complete) throw new Error("compact(): provide `streamFn` or `complete`");
  const keepRecentTokens = opts.keepRecentTokens ?? 20_000;
  const tokensBefore = estimateContextTokens(messages as Message[]).tokens;

  const start = firstConversationIndex(messages);
  const cut = findCutIndex(messages, keepRecentTokens);

  // A leading summary message from an earlier compaction becomes `previousSummary`.
  let previousSummary = opts.previousSummary;
  let historyStart = start;
  if (messages[start] && isSummaryMessage(messages[start]) && cut > start) {
    previousSummary ??= extractSummary(messages[start]);
    historyStart = start + 1;
  }
  const toSummarize = messages.slice(historyStart, cut).filter((m) => m.role !== "system");
  if (cut <= start || toSummarize.length === 0) throw new NothingToCompactError();
  const keptMessages = messages.slice(cut).filter((m) => m.role !== "system");

  const reserveTokens = opts.reserveTokens ?? 16_384;
  const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), opts.model.maxTokens > 0 ? opts.model.maxTokens : Number.POSITIVE_INFINITY);

  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (opts.customInstructions) basePrompt = `${basePrompt}\n\nAdditional focus: ${opts.customInstructions}`;
  let promptText = `<conversation>\n${serializeConversation(toSummarize as Message[])}\n</conversation>\n\n`;
  if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  promptText += basePrompt;

  // No cache writes for a one-off call (pi), but keep a routing id.
  const requestOptions: SimpleStreamOptions = {
    maxTokens,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    cacheRetention: "none",
    sessionId: opts.sessionId ?? uuidv7(),
  };
  const context = buildSummarizationContext(promptText);
  const produce = async (): Promise<AssistantMessage> =>
    opts.streamFn ? (await opts.streamFn(opts.model, context, requestOptions)).result() : opts.complete!(opts.model, context, requestOptions);
  const response = await retryAssistantCall(produce, opts.retry, opts.signal);

  if (response.stopReason === "aborted") throw new Error("Summarization aborted");
  if (response.stopReason === "error") throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
  if (response.stopReason === "length") throw new Error("Summarization failed: generation hit the token cap and the summary is incomplete");
  if (response.content.some((block) => block.type === "toolCall")) throw new Error("Summarization attempted to call a tool");
  const summary = contentText(response.content).trim();
  if (!summary) throw new Error("Summarization failed: empty summary");

  // Newer than every kept message so pi-ai ignores their (pre-compaction) usage in estimates.
  const newest = Math.max(Date.now(), ...keptMessages.map((m) => m.timestamp + 1));
  const summaryMessage = createSummaryMessage(summary, newest);
  const systemMessage = getCurrentSystemMessage(messages);
  return {
    summaryMessage,
    keptMessages,
    tokensBefore,
    ...(systemMessage ? { systemMessage } : {}),
    messages: [...(systemMessage ? [systemMessage] : []), summaryMessage, ...keptMessages],
    summary,
    usage: response.usage,
    ...(response.responseId ? { responseId: response.responseId } : {}),
  };
}

