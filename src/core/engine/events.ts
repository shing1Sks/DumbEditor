import type { Risk } from "../actions/types.js";

export type ApprovalDecision = "once" | "session" | "deny";

/** Everything a client needs to show the agent working. The UI never talks to pi directly. */
export type EngineEvent =
  | { type: "run_start"; runId: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; summary: string; risk: Risk }
  | { type: "tool_progress"; callId: string; stage: string; fraction?: number }
  | { type: "tool_end"; callId: string; ok: boolean; summary: string; versionId?: string }
  | { type: "approval_request"; id: string; kind: "action" | "budget"; callId?: string; name?: string; summary: string; risk: Risk | "budget"; args?: unknown }
  | { type: "choice_request"; id: string; question: string; options: string[]; allowCustom: boolean }
  | { type: "steer_queued"; text: string }
  | { type: "usage"; runCostUsd: number; estimated: boolean }
  | { type: "compaction"; phase: "start" | "end"; tokensBefore?: number; tokensAfter?: number }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "run_end"; reason: "done" | "aborted" | "error" | "budget"; message: string };
