import { createEditActions } from "./edit.js";
import { createInteractionActions } from "./interaction.js";
import { createMediaActions } from "./media.js";
import { ActionRegistry } from "./registry.js";
import { createVersionActions } from "./versions.js";
import { createWorkspaceActions } from "./workspace.js";

export { directEditCall } from "./edit.js";
export { ActionRegistry } from "./registry.js";
export type { Action, ActionContext, ActionImage, ActionProgress, ActionResult, Risk } from "./types.js";

/** The registry used by both slash commands and the agent. */
export function createEditorRegistry(): ActionRegistry {
  const registry = new ActionRegistry();
  for (const action of [
    ...createInteractionActions(),
    ...createEditActions(),
    ...createMediaActions(),
    ...createVersionActions(),
    ...createWorkspaceActions(),
  ]) registry.register(action);
  return registry;
}
