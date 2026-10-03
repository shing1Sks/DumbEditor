import type { Engine } from "../../core/engine/engine.js";
import type { EngineEvent } from "../../core/engine/events.js";
import type { ShellState } from "./shell-state.js";

export interface BridgeOptions {
  /** The model name shown on the agent's lines; read each time because the user can change the model. */
  label: () => string;
  /** Called once with each finished answer so it can be saved in the project's chat history. */
  persistAnswer: (text: string) => void;
}

/** Turn the engine's events into state changes. Returns the function that stops listening. */
export function bindEngineEvents(state: ShellState, engine: Pick<Engine, "on">, options: BridgeOptions): () => void {
  return engine.on((event) => apply(state, event, options));
}

function apply(state: ShellState, event: EngineEvent, options: BridgeOptions): void {
  const label = options.label();
  switch (event.type) {
    case "run_start":
      state.setAgentRunning(true);
      state.setLoader({ source: label, stage: "Thinking" });
      break;
    case "text_delta":
      state.appendLive(event.text, label);
      if (state.loader?.stage !== "Writing response") state.setLoader({ source: label, stage: "Writing response" });
      break;
    case "tool_start":
      state.endLive();
      state.addMessage("assistant", `▸ ${event.summary}`, "tool");
      state.setLoader({ source: event.name === "run_sandbox_script" ? "Sandbox" : label, stage: event.summary });
      break;
    case "tool_progress":
      state.setLoader({ source: state.loader?.source ?? label, stage: event.stage });
      break;
    case "tool_end":
      state.addMessage("assistant", `${event.ok ? "✓" : "✗"} ${event.summary}`, "tool");
      break;
    case "approval_request":
      state.openApproval(event);
      break;
    case "choice_request":
      state.openChoice({ id: event.id, question: event.question, options: event.options, allowCustom: event.allowCustom });
      break;
    case "steer_queued":
      state.setStatus("Queued · the agent will read it after its current step");
      break;
    case "steer_dropped":
      state.restoreComposerText(event.texts.join(" "));
      state.addMessage("assistant", "The agent stopped before it read your queued message. It is back in the input box.", "editor");
      break;
    case "compaction":
      if (event.phase === "start") state.setLoader({ source: state.loader?.source ?? label, stage: "Compacting conversation" });
      else if (event.tokensBefore !== undefined) state.addMessage("assistant", `Compacted earlier conversation (${event.tokensBefore} → ${event.tokensAfter ?? 0} tokens).`, "editor");
      break;
    case "error":
      state.addMessage("assistant", event.message, "error");
      break;
    case "run_end": {
      const streamed = state.endLive();
      state.setAgentRunning(false);
      state.setLoader(null);
      state.clearPrompts();
      if (event.reason === "done" && event.message) {
        if (streamed === null || streamed.trim() !== event.message.trim()) state.addMessage("assistant", event.message, label);
        options.persistAnswer(event.message);
      }
      if (event.reason === "aborted") state.addMessage("assistant", "Stopped.", "editor");
      if (event.reason === "budget") state.addMessage("assistant", "Stopped at the spend limit. Raise it with /budget.", "editor");
      state.setStatus(event.reason === "done" ? "Done" : event.reason === "error" ? "Request failed" : "Stopped");
      break;
    }
    default:
      break;
  }
}
