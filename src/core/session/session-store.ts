import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

type SessionLine =
  | { type: "message"; message: AgentMessage }
  | { type: "compaction"; summaryMessage: AgentMessage; keptCount: number; tokensBefore: number; at: string }
  | { type: "replace"; messages: AgentMessage[]; at: string };

/**
 * Append-only JSONL transcript of one project's agent session. System messages are never stored: the
 * prompt and tool declarations are rebuilt from code on every launch, so prompt updates apply to old projects.
 */
export class SessionStore {
  constructor(readonly path: string) {}

  /** Replay the file into the message list the agent should continue from. Unreadable lines are skipped. */
  async load(): Promise<AgentMessage[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let messages: AgentMessage[] = [];
    for (const text of raw.split(/\r?\n/)) {
      const line = parseLine(text);
      if (!line) continue;
      if (line.type === "message") messages.push(line.message);
      else if (line.type === "replace") messages = line.messages.filter(isStorable);
      else messages = [line.summaryMessage, ...(line.keptCount > 0 ? messages.slice(-line.keptCount) : [])];
    }
    return messages;
  }

  async appendMessage(message: AgentMessage): Promise<void> {
    if (!isStorable(message)) return;
    await this.append({ type: "message", message });
  }

  /** After compaction the transcript is the summary plus the newest `keptCount` messages. */
  async appendCompaction(entry: { summaryMessage: AgentMessage; keptCount: number; tokensBefore: number }): Promise<void> {
    await this.append({ type: "compaction", ...entry, at: new Date().toISOString() });
  }

  /** Replace the whole transcript, used when a cancelled run's unanswered tool calls are closed. */
  async appendReplace(messages: readonly AgentMessage[]): Promise<void> {
    await this.append({ type: "replace", messages: messages.filter(isStorable), at: new Date().toISOString() });
  }

  private async append(line: SessionLine): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(line)}\n`, "utf8");
  }
}

function isStorable(message: AgentMessage): boolean {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function parseLine(text: string): SessionLine | null {
  if (!text.trim()) return null;
  try {
    const value = JSON.parse(text) as Partial<SessionLine> & Record<string, unknown>;
    if (value.type === "message" && isMessage(value.message)) return { type: "message", message: value.message };
    if (value.type === "replace" && Array.isArray(value.messages)) return { type: "replace", messages: value.messages.filter(isMessage), at: String(value.at ?? "") };
    if (value.type === "compaction" && isMessage(value.summaryMessage) && typeof value.keptCount === "number") {
      return { type: "compaction", summaryMessage: value.summaryMessage, keptCount: value.keptCount, tokensBefore: Number(value.tokensBefore ?? 0), at: String(value.at ?? "") };
    }
    return null;
  } catch {
    return null;
  }
}

function isMessage(value: unknown): value is AgentMessage {
  return typeof value === "object" && value !== null && typeof (value as { role?: unknown }).role === "string";
}
