# DumbEditor agent core: design

Date: 2026-10-02
Status: draft for review
Scope: step 2 of the DumbEditor practical-version plan (step 1 was the macOS input hotfix on `fix/mac-input`; step 3 is the new UI shell and preview).

## 1. Intent

DumbEditor's concept is done; the goal now is to make it practical for people who already use Claude Code or Codex, with the same ease.

Today the agent and the terminal UI are two isolated worlds:

- The agent is a black box to the user. The UI shows one stage label; nothing streams, tool calls and FFmpeg progress are invisible, and the answer arrives only when the run ends (`src/core/luna-agent.ts:100-174`, `src/ui/App.tsx:535`).
- The user cannot touch the agent mid-run. No cancel (`App.tsx:516-519`; Esc only clears the input, Ctrl+C quits the app), no steering, and typing is blocked while it works (`App.tsx:778-791`).
- The agent barely sees the user's world. Editor state is injected once at run start and goes stale (`agent-runtime.ts:470-473`). It has no tools for versions, undo, revert or branching, which only slash commands can do. Earlier turns' tool calls and frames are not replayed (`luna-agent.ts:257-267`; `context.jsonl` is written but never read).
- Claude is bolted on as a one-shot sub-agent with none of the editor's tools (`src/core/claude-harness.ts`).

**Success** means:

1. The user and the agent act on one shared, live editor state through one set of actions.
2. Everything the agent does streams into the UI as it happens.
3. The user can cancel or steer the agent at any moment.
4. The agent knows the playhead, marks, selection and versions on every turn, so "cut here" works.
5. Long sessions survive through compaction, and sessions resume after a restart.
6. Any tool-capable OpenRouter model works. OpenRouter is the only agent provider.

## 2. Scope

In scope: the core (actions, editor state, engine, event stream, session store), the tool-surface changes in section 8, a thin adapter so the current Ink UI shows streaming, steering, cancel and approvals, a Node 22.19 minimum, and CI updates.

Out of scope, each its own later project:

- The new UI shell, renderer and tiered preview (step 3).
- A non-destructive edit list. Each edit still re-encodes the previous render (`editor.ts:167`, `advanced-editor.ts:289`, `custom-render.ts:35`), so quality degrades over chained edits.
- Other agent providers, subscription sign-in, running DumbEditor as an MCP server.
- Moving transcription and speech off their current providers. They keep working as they do now; consolidating them onto OpenRouter is a separate follow-up.

## 3. Decision: pi as the agent loop

The loop is `@earendil-works/pi-agent-core` with `@earendil-works/pi-ai` (both 1.0.0, MIT), pinned to exact versions. pi gives streaming events, `abort()`, `steer()` and `followUp()` queues, tool results that carry images, a per-tool-call approval hook (`beforeToolCall`), `finishTurn` and `prepareNextTurn` hooks, and an OpenRouter provider with provider-routing options.

Rejected alternatives:

- **pi's `AgentSession` with only our tools.** About 116 MB installed, pulls in pi's TUI, MCP and extension system, has the most API churn, and routes approvals and state injection through its extension API.
- **Keeping our own loop.** No Node bump, but streaming, steering and cancel would be hand-built.

pi sits behind the engine only (section 5), so it can be swapped without touching actions or UI.

Known pi gaps this design covers: its compaction is not usable outside `pi-coding-agent` and its default trigger almost never fires on 1M-context models (section 7); it prices tokens from a catalog instead of OpenRouter's real cost (section 7); it defaults to `maxRetries: 0` and has no mid-stream retry in the `Agent` loop (section 9); its OpenRouter catalog is a static snapshot (section 5).

## 4. Architecture

The core has no UI dependency. The current Ink UI and the future step 3 UI are both clients of the same core.

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| Actions | One registry of everything the editor can do. Slash commands and agent tools call the same action. | FFmpeg, version store |
| Editor state | Single live store: project, version tree, playhead, marks, selection, assets, cost. UI and agent both read it; actions write it. | project files |
| Engine | Wraps pi's `Agent`. Builds the OpenRouter model, retries, approvals, frame-audit rule, compaction, per-turn state injection. | pi, Actions, Editor state |
| Event stream | One normalized stream the UI subscribes to. The UI never talks to pi directly. | Engine |
| Session store | Append-only JSONL per project for resume. | project dir |

Data flow: the user types or presses a key. A slash command calls an action directly. Plain text goes to the engine as a user message, or as a steering message if a run is active. The agent calls actions as tools. Everything appears in the event stream as it happens. Esc aborts the run through an `AbortSignal` passed to every action, which kills any FFmpeg child.

New files live under `src/core/` (`actions/`, `state/`, `engine/`, `session/`). Existing modules (`editor.ts`, `advanced-editor.ts`, `custom-render.ts`, `export.ts`, `transcription.ts`, `asset-generation.ts`, `music*.ts`, `agent-workspace.ts`, `sandbox.ts`, `project.ts`, `usage.ts`) keep their logic and are wrapped, not rewritten.

## 5. Interfaces

### 5.1 Actions

```ts
type Risk = "read" | "edit" | "spend" | "code";

interface ActionContext {
  state: EditorState;          // live store, section 5.2
  signal: AbortSignal;         // aborted by Esc; actions must kill child processes
  progress(update: { stage: string; fraction?: number; note?: string }): void;
}

interface ActionResult {
  text: string;                                   // what the model reads
  images?: { mimeType: string; data: string }[];  // base64, e.g. inspected frames
  versionId?: string;                             // set when the action committed a version
}

interface Action<Args> {
  name: string;
  description: string;
  schema: JsonSchema;          // wrapped with Type.Unsafe for pi's TypeBox tools
  risk: Risk;
  describe(args: Args): string;   // one-line summary shown in the UI and approval prompts
  run(args: Args, ctx: ActionContext): Promise<ActionResult>;
}
```

- Slash commands (`commands.ts`) parse their arguments and call `registry.run(name, args)`. The agent's tools are generated from the same registry. This guarantees one validation path and one version commit path.
- The 23 hand-written tool schemas in `agent-runtime.ts` move into action definitions. The existing rule that every field is required with no extra fields (`agent-runtime.ts:559-565`) is kept.
- The model-facing tool list excludes actions that make no sense for an agent (for example `/quit`, `/clear`).

### 5.2 Editor state

```ts
interface EditorSnapshot {
  project: { id: string; name: string; sourcePath: string } | null;
  versions: { id: string; parentId: string | null; label: string; active: boolean; pinned: boolean }[];
  media: { duration: number; width: number; height: number; fps: number; hasAudio: boolean } | null;
  playhead: number;
  selection: { in: number | null; out: number | null };
  assets: { id: string; kind: string; label: string }[];
  cost: { agent: number; assets: number; total: number };
  revision: number;            // increments on every change
}
```

The store exposes `snapshot()`, `subscribe(listener)`, and mutators used by actions and the UI (`setPlayhead`, `setSelection`, version commit/revert). The playhead is pushed from the UI during playback at a low rate (about 4 Hz) so state injection is cheap and never triggers per-frame work.

### 5.3 Engine and event stream

```ts
type EngineEvent =
  | { type: "run_start"; runId: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; summary: string; risk: Risk }
  | { type: "tool_progress"; callId: string; stage: string; fraction?: number }
  | { type: "tool_end"; callId: string; ok: boolean; summary: string; versionId?: string }
  | { type: "approval_request"; id: string; callId: string; summary: string; risk: Risk }
  | { type: "choice_request"; id: string; question: string; options: string[] }
  | { type: "steer_queued"; text: string }
  | { type: "usage"; runCost: number; totalCost: number; estimated: boolean }
  | { type: "compaction"; phase: "start" | "end"; tokensBefore?: number; tokensAfter?: number }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "run_end"; reason: "done" | "aborted" | "error" | "budget" };

interface Engine {
  submit(text: string): void;                 // starts a run, or queues steering if one is active
  abort(): void;
  compact(): Promise<void>;
  resolveApproval(id: string, decision: "once" | "session" | "deny"): void;
  resolveChoice(id: string, answer: string): void;
  on(listener: (event: EngineEvent) => void): () => void;
}
```

### 5.4 Model construction

`modelFor(id)` returns a pi `Model` for an OpenRouter id. Known ids come from pi's catalog. Unknown or new ids are built as a literal (`api: "openai-completions"`, base URL OpenRouter, `compat`), because pi's `getModel` returns `undefined` for them. Every model gets `compat.openRouterRouting = { require_parameters: true }` so a provider that does not support tools or images is never selected. Ids beginning with `anthropic/` use pi's `anthropic-messages` path against OpenRouter, as pi does by default. Only models that advertise tool calling and image input are offered as the base agent, matching the current picker (`ModelPanel.tsx`), because pi silently drops images for other models and the frame audit depends on them.

## 6. Run lifecycle

- **Steering.** Typing while a run is active queues the message (`steer_queued`, shown dimmed in chat). pi delivers it after the current tool batch. Tools run one at a time (`toolExecution: "sequential"`), matching today's `parallel_tool_calls: false`.
- **Abort.** Esc calls `engine.abort()`. The signal reaches every action. pi pads unanswered tool calls with "No result provided"; the session store rewrites those as "cancelled by user" so the model knows what did not happen. Ctrl+C aborts a running agent and quits when idle.
- **Approvals** (`beforeToolCall`). By risk: `read` and `edit` never ask (every edit is an undoable version). `spend` (paid asset generation, one-run model overrides) and `code` (custom FFmpeg graphs, sandbox scripts) ask in `ask` mode with Allow once, Allow for this session, or Deny. `auto` mode asks for nothing. Today custom FFmpeg, sandbox scripts, default paid generation and music downloads never ask (`agent-runtime.ts:262-273, 315-323, 622-634`).
- **Frame-audit rule** (`finishTurn`). If a version was committed since the last frame inspection, steer an audit nudge and continue. Capped at two nudges per run, replacing today's unbounded nudge (`luna-agent.ts:141-143`).
- **State injection** (`prepareNextTurn`). Before a turn, if `state.revision` changed since the last injection, append an `<editor_state>` user message with playhead, marks, selection, active version, duration and a short version list. It is never placed in the system prompt, so prompt caching holds.
- **Spend ceiling.** Default $5 per run. When reached, the run pauses and asks to continue (`run_end: "budget"` if declined). `/budget <usd>` changes it. This is a new limit; the README currently promises no cap and is updated.
- **Skills.** The prompt lists packaged skill names and descriptions; a `read_skill` tool loads a body on demand. Today all four are pasted in full on every request (`agent-skills.ts`, `luna-agent.ts:301`).

## 7. Compaction and cost

**Compaction.** Vendored and adapted from `pi-coding-agent` (`src/core/compaction/`, MIT, with attribution kept in the file header and `THIRD_PARTY.md`). About 350 lines are reused: the summarizer (`generateSummaryWithUsage`), `serializeConversation` and the summary system prompt, the three checkpoint prompts, and the cut-point walk, rewritten over plain `AgentMessage[]` instead of pi's session entries. pi-ai's `estimateContextTokens`, `calculateContextTokens` and `isContextOverflow` are used directly.

- Trigger: auto-compaction between turns when context tokens exceed 60% of the model's context window (own threshold, since pi's reserve-based default almost never fires on 1M models, pi issue #9904). Also `/compact` on demand.
- Keeps roughly the most recent 20k tokens; older messages are summarized into a structured checkpoint (Goal, Constraints, Progress, Key Decisions, Next Steps, Critical Context) plus a **Visual findings** section. Image blocks are dropped when summarizing, so the summarizer is prompted to record what the frames showed as text.
- Cut points fall only at user or assistant messages, never at a tool result.
- The summary call runs with cache retention off.

**Cost.** Per-request cost is read from OpenRouter's `usage.cost` in the streamed chunk via pi's `onProviderStreamEvent`, not from pi's catalog price multiplication (which can be 2-3x off, pi issues #8940, #9980). When the cost field is missing, the catalog estimate is used and marked `~` (`usage.estimated: true`). Costs feed the existing ledger (`usage.ts`) and the spend ceiling. For `anthropic/*` ids pi uses OpenRouter's Anthropic-compatible path; whether its stream carries `cost` was not verified, so those requests fall back to the estimate until verified during implementation.

## 8. Tool surface changes

- Removed: `delegate_to_claude_harness`, `claude-harness.ts`, and the `@anthropic-ai/claude-agent-sdk` dependency. `@anthropic-ai/sandbox-runtime` and `run_sandbox_script` stay.
- Added: `get_editor_state`, `list_versions`, `revert_to`, `branch_from`, `compare_frames` (side-by-side contact sheet across two versions).
- `revert_to` and `branch_from` call the same actions as `/revert` and the version store, so user and agent share one path.
- Versions referenced by the active session are pinned: retention pruning (`project.ts:301-319`) skips them, so version ids the agent has seen never vanish. The default retention of five is unchanged for unpinned versions.

## 9. Session store, errors and retries

**Session store.** `agent/session.jsonl` in the project directory replaces the write-only `context.jsonl`. One JSON object per line: `message` (a pi `AgentMessage`), `compaction` (summary, first kept id, token counts), `state` (revision marker), `cancelled` (call ids). Append-only; a truncated final line is ignored on load. `chat.jsonl` remains the readable UI transcript, now driven from engine events. A project from before this change starts its first session seeded with its recent `chat.jsonl` text messages, matching today's behavior. Fork is deferred.

**Retries.** The `Agent` loop forwards only a subset of stream options and pi defaults to `maxRetries: 0`. A `streamFn` wrapper sets `maxRetries: 3` (exponential backoff honoring `retry-after`, via pi-ai's `retryAssistantCall`), `cacheRetention: "short"` and the routing options.

**Errors.**

- Provider failure after retries: `error` event, run ends with `reason: "error"`, history intact, the user can say "continue". Errors are no longer saved as assistant replies (`App.tsx:535`).
- Tool failure: returned to the model as an error result including the FFmpeg stderr tail, as today.
- Aborted render: nothing partial is committed; renders go to a temp file, are validated with ffprobe, then become a version (existing behavior).
- Empty or malformed tool call (pi issue #10299): treated as a tool error and the run continues. A per-turn timeout is the watchdog.

## 10. Current UI adapter

`App.tsx` subscribes to the event stream and shows streamed text and thinking, tool start/progress/end lines, queued steering, approvals (Allow once / session / Deny), cost, and compaction notices. Enter while a run is active steers; Esc aborts; Ctrl+C aborts then quits. The old `runLunaAgent` path and the `busy`-blocks-typing behavior (`App.tsx:778-791`) are deleted. This is deliberately minimal: step 3 rebuilds the UI on the same event stream.

## 11. Dependencies and platform

- Minimum Node moves to **22.19** (every pi package declares `>=22.19.0`, ESM only; Node 20 reached end of life in April 2026). Update `engines` in `package.json`, the Node version in `.github/workflows/ci.yml`, and the README requirements.
- Add `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` at exact versions, plus `typebox` as pi requires. Expect about 89 MB more in `node_modules`, mostly provider SDKs pi-ai depends on.
- Remove `@anthropic-ai/claude-agent-sdk`.
- pi-agent-core and pi-ai have no native code; Windows and macOS are supported. Not tested on Node 20.

## 12. Testing

A scripted fake model (a `streamFn` returning canned events) makes the loop deterministic. Tests cover: steering delivered after the tool batch; abort killing the FFmpeg child and recording "cancelled"; the audit nudge cap; state injected only when `revision` changed; compaction firing and the summary containing visual findings; the approval flow for each risk level; `usage.cost` capture and estimate fallback; retries; the spend ceiling; session resume including a truncated final line; empty tool call handling. A parity test checks that a slash command and the corresponding agent tool produce the identical version for the same arguments. Existing synthetic-media FFmpeg tests stay. One opt-in live smoke test runs only when `OPENROUTER_API_KEY` is set. No provider credits are spent by default. CI runs the full suite on Linux and runs the new tests on Windows and macOS as well (today macOS and Windows only run `--help` and `--version`).

## 13. Migration order

Each step ships on its own with tests green.

1. Branch `core/agent-engine` (stacked on `fix/mac-input` if that is not merged). Node 22.19 bump, pi added at pinned versions.
2. Extract the actions registry; slash commands route through it. No behavior change.
3. Editor state store and version pinning.
4. Engine on pi with event stream, session store and vendored compaction; replace the old loop.
5. New tools (`get_editor_state`, `list_versions`, `revert_to`, `branch_from`, `compare_frames`, `read_skill`); remove the Claude harness and its SDK.
6. Ink adapter for streaming, steering, cancel and approvals; delete the old loop.
7. README and packaged skills updated, including the new spend ceiling and keys.

## 14. Risks

- pi 1.0.0 is days old and removed whole subsystems in that release; mitigated by exact pinning and keeping pi behind the engine.
- The Node 22.19 minimum excludes users still on Node 20.
- Compaction forgets frames; the summary must carry visual findings as text.
- Several pi issues are open (#10330 auto-compaction not starting and #10289 abort during compaction in `AgentSession`, which this design avoids by owning the compaction call; #9306 and #9986 abort leaving unanswered tool calls, handled by the cancelled-call rewrite).
- Anthropic-path cost reporting through OpenRouter is unverified (section 7).
