/**
 * Append an <editor_state> user message ONLY when the editor's revision counter changed.
 *
 * Which hook goes where (verified in engine-hooks.test.ts):
 *  - `prepareNextTurn` runs between turns of one run (after turn_end, only when the loop continues).
 *    Returned `messages` are appended WITH lifecycle events, so they land in `agent.state.messages`
 *    (persisted transcript) right after the tool results. It is NOT called before the FIRST request
 *    of a run, so use `wrapPrompt` for that one.
 *  - `prepareRequest` runs before every request (incl. the first) but anything it adds to `context` is
 *    request-local: no events, NOT written to `agent.state.messages`. Fine for ephemeral hints,
 *    wrong for state you want in the saved transcript.
 */
import type { AgentLoopTurnUpdate, AgentMessage } from "@earendil-works/pi-agent-core";

export interface EditorSnapshot {
  revision: number;
  /** Serialized timeline/selection, whatever the model should see. */
  body: string;
}

const STATE_RE = /^<editor_state revision="(\d+)">/;

export function renderEditorState(snapshot: EditorSnapshot): string {
  return `<editor_state revision="${snapshot.revision}">\n${snapshot.body}\n</editor_state>`;
}

export function revisionOfMessage(message: AgentMessage): number | undefined {
  if (message.role !== "user") return undefined;
  const text = typeof message.content === "string" ? message.content : message.content.find((b) => b.type === "text")?.text;
  const match = text ? STATE_RE.exec(text) : null;
  return match ? Number(match[1]) : undefined;
}

export function createEditorStateSync(getSnapshot: () => EditorSnapshot, initialLastSent?: number) {
  let lastSent = initialLastSent;

  const pending = (): AgentMessage | undefined => {
    const snapshot = getSnapshot();
    if (snapshot.revision === lastSent) return undefined;
    lastSent = snapshot.revision;
    return { role: "user", content: renderEditorState(snapshot), timestamp: Date.now() };
  };

  return {
    /** Agent option `prepareNextTurn`. */
    prepareNextTurn: (): AgentLoopTurnUpdate | undefined => {
      const message = pending();
      return message ? { messages: [message] } : undefined;
    },
    /** Use instead of `agent.prompt(text)`: prepends the state message when the revision changed. */
    wrapPrompt: (text: string): AgentMessage[] => {
      const state = pending();
      const user: AgentMessage = { role: "user", content: text, timestamp: Date.now() };
      return state ? [state, user] : [user];
    },
    /** After loading a saved transcript: remember the last revision the model has already seen. */
    syncFromTranscript(messages: readonly AgentMessage[]) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
      const revision = message ? revisionOfMessage(message) : undefined;
        if (revision !== undefined) {
          lastSent = revision;
          return;
        }
      }
      lastSent = undefined;
    },
    get lastSent() {
      return lastSent;
    },
  };
}
