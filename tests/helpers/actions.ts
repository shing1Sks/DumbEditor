import type { ActionContext } from "../../src/core/actions/types.js";
import { DEFAULT_SETTINGS } from "../../src/core/settings.js";
import type { EditorState } from "../../src/core/state/editor-state.js";

export function actionContext(state: EditorState, signal: AbortSignal = new AbortController().signal): ActionContext {
  return {
    state, settings: structuredClone(DEFAULT_SETTINGS), signal, request: "test request",
    progress: () => undefined, requestChoice: async () => null,
  };
}
