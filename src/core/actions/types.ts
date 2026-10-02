import type { ChoiceRequest } from "../choice.js";
import type { DumbEditorSettings } from "../settings.js";
import type { EditorState } from "../state/editor-state.js";

export type Risk = "read" | "edit" | "spend" | "code";

export interface ActionProgress {
  stage: string;
  fraction?: number;
}

export interface ActionContext {
  state: EditorState;
  settings: DumbEditorSettings;
  signal: AbortSignal;
  /** Text of the user request that triggered the action; recorded on versions it commits. */
  request: string;
  progress(update: ActionProgress): void;
  /** Ask the user to pick one option. Resolves null when the user cancels or the client cannot ask. */
  requestChoice(request: ChoiceRequest): Promise<string | null>;
}

export interface ActionImage {
  mimeType: string;
  /** Base64 data without a data: prefix. */
  data: string;
}

export interface ActionResult {
  /** What the model reads. */
  text: string;
  data?: Record<string, unknown>;
  images?: ActionImage[];
  /** Set when the action committed a version or switched the active version. */
  versionId?: string;
}

export interface Action<Args = Record<string, unknown>> {
  /** snake_case; also the agent tool name. */
  name: string;
  description: string;
  /** Raw JSON Schema; every property required, additionalProperties false. */
  schema: Record<string, unknown>;
  risk: Risk | ((args: Args) => Risk);
  /** True when the action visually inspects the active version, which satisfies the frame-audit rule. */
  audits?: boolean;
  /** One-line summary for the UI and approval prompts. */
  describe?(args: Args): string;
  run(args: Args, ctx: ActionContext): Promise<ActionResult>;
}
