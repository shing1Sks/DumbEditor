import { join } from "node:path";
import type { ActionRegistry } from "../core/actions/index.js";
import { loadAgentSkills } from "../core/agent-skills.js";
import { Engine } from "../core/engine/engine.js";
import { createEditorModels, fetchOpenRouterModelInfo, isCatalogModel } from "../core/pi/models.js";
import { SessionStore } from "../core/session/session-store.js";
import type { DumbEditorSettings } from "../core/settings.js";
import type { EditorState } from "../core/state/editor-state.js";
import type { ChatMessage } from "../types.js";

export type EditorModels = ReturnType<typeof createEditorModels>;

/** Build the agent for an open project, or null (with a reason in `report`) when it cannot start. */
export async function createAgentEngine(args: {
  state: EditorState;
  registry: ActionRegistry;
  getSettings: () => DumbEditorSettings;
  models: { current: EditorModels | null };
  chatSeed: readonly ChatMessage[];
  report: (message: string) => void;
}): Promise<Engine | null> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  args.models.current ??= createEditorModels({ apiKey });
  const modelId = args.getSettings().models.openrouter.text;
  // Models pi's catalog does not know yet still work: take their real limits and prices from OpenRouter.
  const modelInfo = isCatalogModel(args.models.current, modelId) ? undefined : await fetchOpenRouterModelInfo(modelId);
  try {
    const created = await Engine.tryCreate({
      state: args.state, registry: args.registry, models: args.models.current, modelId, ...(modelInfo ? { modelInfo } : {}),
      session: new SessionStore(join(args.state.store.snapshot.projectDir, "agent", "session.jsonl")),
      getSettings: args.getSettings, skills: await loadAgentSkills(), chatSeed: args.chatSeed,
    });
    if (created.error !== undefined) args.report(`The agent could not start for this project: ${created.error}. Slash commands still work.`);
    return created.engine;
  } catch (error) {
    args.report(`The agent could not start for this project: ${error instanceof Error ? error.message : String(error)}. Slash commands still work.`);
    return null;
  }
}
