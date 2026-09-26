import { query, type CanUseTool, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { AgentWorkspace } from "./agent-workspace.js";
import type { RequestApproval } from "./approval.js";
import type { AgentPermissionMode } from "./settings.js";

export interface ClaudeHarnessResult {
  result: string;
  model: string;
  costUsd: number;
  sessionId: string;
  files: string[];
}

export async function runClaudeHarness(options: {
  task: string;
  model: string;
  maxBudgetUsd: number;
  maxTurns: number;
  effort: "low" | "medium" | "high";
  permissionMode: AgentPermissionMode;
  requestApproval?: RequestApproval;
  workspace: AgentWorkspace;
  activeVideoPath: string;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
}): Promise<ClaudeHarnessResult> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error("Claude harness needs an Anthropic API key. Run dumbeditor setup.");
  await options.workspace.initialize();
  const before = new Set(await options.workspace.listFiles());
  const permissionMode: PermissionMode = options.permissionMode === "auto" ? "auto" : "default";
  const canUseTool: CanUseTool | undefined = options.permissionMode === "ask" ? async (toolName, input, details) => {
    const allowed = await options.requestApproval?.({
      category: "tool",
      title: details.title ?? `Claude wants to use ${toolName}`,
      description: details.description ?? details.decisionReason ?? "Review this coding harness action before it runs.",
      provider: "Anthropic Claude Agent SDK",
      model: options.model,
      parameters: compactInput(input),
    }) ?? false;
    return allowed
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "The user denied this tool call." };
  } : undefined;

  options.onStage?.(`HARNESS · ${options.model} is working`);
  const session = query({
    prompt: options.task,
    options: {
      cwd: options.workspace.filesDirectory,
      model: options.model,
      effort: options.effort,
      maxTurns: options.maxTurns,
      maxBudgetUsd: options.maxBudgetUsd,
      permissionMode,
      permissionPrompts: options.permissionMode === "auto" ? "none" : "host",
      tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
      disallowedTools: ["WebSearch", "WebFetch"],
      settingSources: [],
      settings: {
        includeGitInstructions: false,
        permissions: {
          blockReadsOutsideWorkingDirectories: true,
          disableBypassPermissionsMode: "disable",
        },
      },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: options.permissionMode === "auto",
        allowUnsandboxedCommands: false,
        network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false },
        filesystem: {
          allowRead: [options.workspace.root, options.activeVideoPath],
          allowWrite: [options.workspace.filesDirectory],
        },
        credentials: {
          envVars: [
            "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GITHUB_TOKEN",
            "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
          ].map((name) => ({ name, mode: "deny" as const })),
        },
      },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: [
          "You are a specialist inside DumbEditor, an agent-first terminal video editor.",
          `Your writable project workspace is ${options.workspace.filesDirectory}.`,
          `The active video is read-only at ${options.activeVideoPath}.`,
          "Write scripts, notes, subtitles, or media outputs only inside the project workspace.",
          "Do not modify or delete the active video. Do not access credentials or unrelated user files.",
          "Use FFmpeg or FFprobe when useful. Finish with a concise account of files created and checks run.",
        ].join(" "),
      },
      ...(canUseTool ? { canUseTool } : {}),
      ...(options.signal ? { abortController: abortController(options.signal) } : {}),
    },
  });

  let finalResult = "";
  let costUsd = 0;
  let sessionId = "";
  for await (const message of session) {
    if (message.type === "assistant") options.onStage?.(`HARNESS · ${options.model} is using its workspace`);
    if (message.type !== "result") continue;
    costUsd = message.total_cost_usd;
    sessionId = message.session_id;
    if (message.subtype === "success") finalResult = message.result;
    else throw new Error(message.errors.join("; ") || `Claude harness stopped: ${message.subtype}`);
  }
  if (!finalResult) throw new Error("Claude harness finished without a result.");
  const files = (await options.workspace.listFiles()).filter((file) => !before.has(file));
  return { result: finalResult, model: options.model, costUsd, sessionId, files };
}

function compactInput(input: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(input);
  if (encoded.length <= 2_000) return input;
  return { summary: `${encoded.slice(0, 1_900)}…` };
}

function abortController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  return controller;
}
