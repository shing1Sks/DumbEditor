# DumbEditor Agent Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DumbEditor's isolated, non-streaming agent with a pi-based engine that works on one shared action layer and live editor state, so the user and the agent act on the same project, everything the agent does streams into the UI, and the user can steer or stop it at any time.

**Architecture:** A UI-free core: an `ActionRegistry` (every edit/inspect/version operation, used by slash commands and agent tools alike), an `EditorState` store (playhead, marks, versions, assets, cost), an `Engine` that wraps pi's `Agent` (OpenRouter only) with approvals, a frame-audit rule, per-turn state injection, compaction and a spend limit, an append-only `SessionStore`, and a normalized `EngineEvent` stream. The existing Ink UI becomes a thin client of the event stream; the full UI rebuild is a separate project.

**Tech Stack:** TypeScript (strict, ESM), Ink 5 (unchanged), `@earendil-works/pi-ai@1.0.0` and `@earendil-works/pi-agent-core@1.0.0` (pinned), `typebox@1.3.27`, `node:test`, FFmpeg.

**Spec:** `docs/superpowers/specs/2026-10-02-agent-core-design.md`. Verified pi behaviour (every pi API call in this plan was compiled and run offline): `docs/superpowers/spikes/pi-1.0/SPIKE-REPORT.md`.

## Working conventions

- Work in `C:\Users\SHREYASH KUMAR SINGH\Desktop\DumbEditor` (Git Bash path `/c/Users/SHREYASH KUMAR SINGH/Desktop/DumbEditor`). Run every command from that folder.
- That folder is owned by a different Windows user, so git refuses it by default. In each Git Bash session define this once instead of changing global git config:

```bash
git() { command git -c safe.directory='*' "$@"; }
```

- Commit messages below carry no attribution trailer; add the one your environment requires. Do not push or publish to npm.
- Every task ends with the whole suite green (`npm test`) and `npx tsc --noEmit` clean. A task may be reviewed and rejected independently of its neighbours.
- Code and tests in this plan were replayed task by task in clean copies of the repository: each task compiled and passed the tests listed for it before the next was applied.

## Deviations from the spec (decided while planning, each reflected in the code below)

1. **Playhead sync.** Spec section 5.2 pushed the playhead at about 4 Hz during playback. Instead the UI mirrors the playhead into `EditorState` whenever it is committed (seek, pause, end) and again right before a message is sent, which is the only time the agent can read it. Playback stays free of per-frame work.
2. **No `branch_from` tool.** Editing after `revert_to` already branches from that version (the version tree uses `parentId`), so a second tool would be a duplicate. `revert_to` covers spec section 8.
3. **Risk can depend on arguments.** `Action.risk` may be a function of the arguments. `generate_asset` is always `spend`; the transcription tools are `edit`/`read` unless the agent overrides the model or passes provider options, which makes them `spend`.
4. **Typed-at-the-end messages.** A message queued after the loop's last steering check is run as a follow-up instead of being dropped (spec section 6 did not say).
5. **Session `replace` entry.** After an abort leaves a tool call unanswered, the corrected transcript is saved as a `replace` line so the saved order stays valid (spec section 9 listed only message/compaction/state/cancelled).
6. **Stall watchdog.** A model response that stays silent for 5 minutes is stopped and reported (spec section 9 named a per-turn timeout without a value).
7. **Action count.** The registry has 31 actions: the 27 old tools minus `delegate_to_claude_harness`, plus `get_editor_state`, `list_versions`, `revert_to`, `compare_frames` and `read_skill`.

## Global Constraints

- Node `>=22.19.0`: `engines.node` in `package.json`, `node-version: 22.19.0` in `.github/workflows/ci.yml`, tsup `target: "node22"`.
- `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` pinned at exactly `1.0.0`, `typebox` at exactly `1.3.27` (no carets); pi is imported only from `src/core/pi/` and `src/core/engine/`.
- OpenRouter is the only agent provider; base-agent models must support tool calling and image input.
- Compaction at 60% of the model's context window; the newest ~20,000 tokens are kept verbatim; the summary has a `## Visual findings` section.
- At most 2 frame-audit nudges per run; per-run spend limit default `$5` (`0` turns it off); provider retries `maxRetries: 3`, `cacheRetention: "short"`.
- Versions the agent has seen are pinned (newest 20); retention for unpinned versions stays at the existing default of 5.
- Tool output sent to the model is capped at 50,000 characters.
- No test spends provider credits. The one live test needs `DUMBEDITOR_LIVE_TEST=1` and `OPENROUTER_API_KEY`.
- Style: 2-space indent, ESM imports with `.js` specifiers, and the repo's strict compiler options (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`).
- `src/core/pi/compaction.ts` is adapted from pi's MIT-licensed compaction: keep the header comment and `THIRD_PARTY.md`.
- Never read, copy or reference the leaked Claude Code source (`tanbiralam/claude-code`).

## Review Focus

These are the inputs most likely to hurt a real user that the spec does not spell out. Each has a test in the task that owns the code.

1. **A huge tool result** (a 1 MB workspace file the agent reads) must not flood the context: it is truncated to 50,000 characters. Test: `caps a huge tool result before it reaches the model` (Task 6).
2. **Malformed tool arguments from the model** (`ranges: "not a list"`) must become an error result the model can fix, not crash or commit anything. Tests: `an invalid tool call becomes an error result and the run carries on` (Task 6), `strict tools reject arguments pi would otherwise coerce` (Task 2).
3. **Stopping at a bad moment**: Esc/Ctrl+C while an approval or choice is pending, or in the middle of a render, must end the run cleanly, leave no half-written version, and leave no tool call without a result. Tests: `aborting while an approval is pending denies it and ends the run`, `abort ends the run, cancels the waiting action and closes unanswered tool calls` (Task 6), `an aborted action commits nothing` (Task 4).
4. **Messages that arrive at the wrong time** (two quick Enters, or text typed as the run ends) must never vanish. Tests: `two quick submissions make one run`, `hands back text typed as a run ended instead of dropping it` (Task 6).
5. **Compaction going wrong** (summarizer error, or a conversation that cannot be cut) must not stop the user's request. Tests: `a failing summarizer is reported and the run still answers`, `refuses to compact a conversation that already fits` (Tasks 6 and 2).
6. **Damaged or old project data**: a truncated last line in `session.jsonl`, and a project that has chat history but no agent session. Tests: `ignores a truncated final line and other unreadable lines` (Task 5), `seeds a project that has chat history but no agent session yet` (Task 6).

## File map

| Path | Status | Responsibility |
| --- | --- | --- |
| `src/core/pi/models.ts` | create | OpenRouter models, routing, retry/caching defaults, abort normalization |
| `src/core/pi/cost.ts` | create | Real per-request cost from OpenRouter's usage chunk |
| `src/core/pi/tools.ts` | create | Raw JSON Schema to pi tool, with strict validation |
| `src/core/pi/compaction.ts` | create | Vendored, adapted pi compaction (summary + cut points) |
| `src/core/pi/editor-state-sync.ts` | create | Inject `<editor_state>` only when it changed |
| `src/core/state/editor-state.ts` | create | Live shared editor state and change notifications |
| `src/core/actions/*.ts` (9 files) | create | The action registry and all 31 actions |
| `src/core/session/session-store.ts` | create | Append-only agent transcript for resume |
| `src/core/engine/{events,prompt,engine}.ts` | create | The agent engine and its event stream |
| `src/core/{project,usage,editor,advanced-editor,agent-skills,settings,config}.ts`, `src/types.ts` | modify | Pinning, agent usage kind, abort support, skills loader, settings, setup |
| `src/ui/{App,ApprovalPanel,Help,ModelPanel}.tsx`, `src/cli.tsx` | modify | UI becomes a client of the engine |
| `src/core/{agent-runtime,luna-agent,claude-harness,approval}.ts`, `tests/luna.test.ts` | delete | Replaced by the engine |
| `tests/*.test.ts`, `tests/helpers/*.ts` | create/modify | Offline tests with pi's fake provider and real FFmpeg |
| `README.md`, `skills/*/SKILL.md`, `THIRD_PARTY.md`, `.github/workflows/ci.yml`, `package.json`, `tsup.config.ts` | modify/create | Docs, notices, Node 22.19, CI |

## Task 1: Branch, dependencies and the Node 22.19 floor

**Files:**
- Modify: `package.json`, `package-lock.json` (by npm), `tsup.config.ts`, `.github/workflows/ci.yml`
- Create: `docs/superpowers/spikes/pi-1.0/SPIKE-REPORT.md` (already written; committed here)

**Interfaces:**
- Produces: a branch `core/agent-engine` stacked on `fix/mac-input` with pi installed and the Node floor raised. Nothing imports pi yet.

- [ ] **Step 1: Make sure the macOS hotfix and the design documents are committed**

The branch must start clean. From `fix/mac-input`:

```bash
git() { command git -c safe.directory='*' "$@"; }
git switch fix/mac-input
git status --short
```

If `git status` lists the hotfix files (`src/ui/keys.ts`, `tests/keys.test.ts`, changes in `src/ui/*.tsx`, `src/cli.tsx`, `README.md`, `package.json`), commit them, then the documents:

```bash
git add src tests README.md package.json
git commit -m "fix: make input, focus, shutdown and audio behave on macOS and Linux"
git add docs/superpowers
git commit -m "docs: agent core spec, plan and pi spike report"
git status --short
```

Expected: the last `git status --short` prints nothing.

- [ ] **Step 2: Create the working branch and check Node**

```bash
git switch -c core/agent-engine
node --version
```

Expected: `node --version` prints `v22.19.0` or newer. If it prints an older version, stop and upgrade Node first; pi will not run on it.

- [ ] **Step 3: Install pi at pinned versions**

```bash
npm install --save-exact @earendil-works/pi-ai@1.0.0 @earendil-works/pi-agent-core@1.0.0 typebox@1.3.27
```

Expected: `package.json` gains the three dependencies with no `^`, and `package-lock.json` changes.

- [ ] **Step 4: Raise the Node floor and the build target**

Apply this change to `package.json`:

```diff
--- a/package.json
+++ b/package.json
@@ -46,14 +46,17 @@
     "access": "public"
   },
   "engines": {
-    "node": ">=20.11.0"
+    "node": ">=22.19.0"
   },
   "dependencies": {
     "@anthropic-ai/claude-agent-sdk": "^0.3.276",
     "@anthropic-ai/sandbox-runtime": "^0.0.77",
+    "@earendil-works/pi-agent-core": "1.0.0",
+    "@earendil-works/pi-ai": "1.0.0",
     "dotenv": "^16.4.7",
     "ink": "^5.2.1",
-    "react": "^18.3.1"
+    "react": "^18.3.1",
+    "typebox": "1.3.27"
   },
   "devDependencies": {
     "@types/node": "^22.10.0",
```

(The dependency lines are what npm wrote in Step 3; the change you still make by hand is `engines.node`.)

Apply this change to `tsup.config.ts`:

```diff
--- a/tsup.config.ts
+++ b/tsup.config.ts
@@ -4,7 +4,7 @@
   entry: ["src/cli.tsx"],
   format: ["esm"],
   platform: "node",
-  target: "node20",
+  target: "node22",
   clean: true,
   dts: false,
   sourcemap: true,
```

Apply this change to `.github/workflows/ci.yml`:

```diff
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -14,7 +14,7 @@
       - uses: actions/checkout@v7
       - uses: actions/setup-node@v7
         with:
-          node-version: 20.11.0
+          node-version: 22.19.0
           cache: npm
       - name: Install FFmpeg
         run: sudo apt-get update && sudo apt-get install -y ffmpeg
@@ -31,7 +31,7 @@
       - uses: actions/checkout@v7
       - uses: actions/setup-node@v7
         with:
-          node-version: 20.11.0
+          node-version: 22.19.0
           cache: npm
       - run: npm ci
       - run: npm run check
```

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit
```

Expected: no output (nothing imports pi yet; this proves the install did not break the build).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsup.config.ts .github/workflows/ci.yml
git commit -m "build: require Node 22.19 and add pinned pi packages"
```

## Task 2: pi layer: models, cost, tools, compaction, state injection

**Files:**
- Create: `src/core/pi/models.ts`, `src/core/pi/cost.ts`, `src/core/pi/tools.ts`, `src/core/pi/compaction.ts`, `src/core/pi/editor-state-sync.ts`, `THIRD_PARTY.md`
- Create (tests): `tests/helpers/faux.ts`, `tests/pi-layer.test.ts`, `tests/compaction.test.ts`
- Modify: `package.json` (`files`, `test` script)

**Interfaces:**
- Produces (all in `src/core/pi/`):
  - `createEditorModels(opts: { apiKey: string }): MutableModels` and `openRouterModel(models: Models, id: string, opts?: { baseUrl?: string; routing?: OpenRouterRouting }): Model<Api>` (always sets `compat.openRouterRouting.require_parameters`; builds a literal for ids pi's catalog lacks).
  - `createStreamFn(models: Models, defaults?: StreamDefaults): StreamFn`, `EDITOR_STREAM_DEFAULTS` (`maxRetries: 3`, `cacheRetention: "short"`), `mergeStreamOptions(defaults, options)`.
  - `createCostTracker(): CostTracker` with `onProviderStreamEvent`, `takeCost(message: Pick<AssistantMessage, "responseId" | "usage">): RequestCost | undefined`, `pendingCount()`.
  - `toolFromJsonSchema<TArgs, TDetails>(def): AgentTool<TUnsafe<TArgs>, TDetails>` (`strict: true` rejects what pi would coerce).
  - `shouldCompact(messages, contextWindow, { thresholdRatio? }): boolean`, `findCutIndex(messages, keepRecentTokens?): number`, `compact(messages, opts): Promise<CompactionResult>`, `NothingToCompactError`, `isSummaryMessage`, `serializeConversation`, `estimateContextTokens`.
  - `createEditorStateSync(getSnapshot: () => { revision: number; body: string })` returning `{ prepareNextTurn, wrapPrompt(text), syncFromTranscript(messages), lastSent }`.
- Produces (tests): `makeFaux()`, `call(name, args, id)`, `toolUse(...calls)`, `say(text)`, `deferred()` in `tests/helpers/faux.ts`.

- [ ] **Step 1: Write the tests and the fake-provider helper**

Create `tests/helpers/faux.ts`:

```typescript
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type RegisterFauxProviderOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";

/** pi's scripted fake provider plus a Models collection that serves it. No network. */
export function makeFaux(options: RegisterFauxProviderOptions = {}) {
  const faux = fauxProvider(options);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() };
}

export const call = (name: string, args: ToolCall["arguments"], id: string): ToolCall => fauxToolCall(name, args, { id });

/** An assistant message that calls tools. */
export const toolUse = (...calls: ToolCall[]): AssistantMessage => fauxAssistantMessage(calls, { stopReason: "toolUse" });

export const say = (text: string): AssistantMessage => fauxAssistantMessage(text);

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
```

Create `tests/pi-layer.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, validateToolArguments, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createCostTracker } from "../src/core/pi/cost.js";
import { createEditorModels, createStreamFn, mergeStreamOptions, openRouterModel } from "../src/core/pi/models.js";
import { toolFromJsonSchema } from "../src/core/pi/tools.js";
import { makeFaux } from "./helpers/faux.js";

const prompt = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });

test("builds OpenRouter models that require provider support for the request, without touching the catalog", () => {
  const models = createEditorModels({ apiKey: "test-key" });
  const known = models.getModels("openrouter").find((model) => model.api === "openai-completions");
  assert.ok(known);
  const catalog = models.getModel("openrouter", known.id);
  const built = openRouterModel(models, known.id);
  assert.notEqual(built, catalog);
  assert.equal((built.compat as { openRouterRouting?: { require_parameters?: boolean } }).openRouterRouting?.require_parameters, true);
  assert.equal((catalog?.compat as { openRouterRouting?: unknown } | undefined)?.openRouterRouting, undefined);
});

test("builds a literal for an OpenRouter model id the catalog does not know", () => {
  const models = createEditorModels({ apiKey: "test-key" });
  const built = openRouterModel(models, "vendor/brand-new-model");
  assert.equal(built.id, "vendor/brand-new-model");
  assert.equal(built.provider, "openrouter");
  assert.equal(built.api, "openai-completions");
  assert.ok(built.input.includes("image"));
  assert.equal((built.compat as { openRouterRouting?: { require_parameters?: boolean } }).openRouterRouting?.require_parameters, true);
});

test("merges stream options: undefined never clobbers a default, headers merge, callbacks chain", async () => {
  const calls: string[] = [];
  const merged = mergeStreamOptions(
    { maxRetries: 3, cacheRetention: "short", headers: { a: "1" }, onProviderStreamEvent: () => { calls.push("default"); } },
    // The Agent really does pass explicit undefined values, which the option types do not model.
    { sessionId: undefined, maxRetries: undefined, headers: { b: "2" }, onProviderStreamEvent: () => { calls.push("call"); } } as unknown as SimpleStreamOptions,
  );
  assert.equal(merged.maxRetries, 3);
  assert.equal(merged.cacheRetention, "short");
  assert.deepEqual(merged.headers, { a: "1", b: "2" });
  await merged.onProviderStreamEvent?.({}, undefined as never);
  assert.deepEqual(calls, ["default", "call"]);
});

test("reports an already-aborted request as aborted without calling the model", async () => {
  const { faux, models, model } = makeFaux();
  const controller = new AbortController();
  controller.abort();
  const stream = await createStreamFn(models)(model, prompt, { signal: controller.signal });
  const message = await stream.result();
  assert.equal(message.stopReason, "aborted");
  assert.equal(faux.state.callCount, 0);
});

test("captures OpenRouter's real cost from the final usage chunk and falls back to the catalog estimate", () => {
  const tracker = createCostTracker();
  tracker.onProviderStreamEvent({ id: "gen-1", choices: [], usage: { prompt_tokens: 10, cost: 0.0123, is_byok: false } }, undefined as never);
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
  assert.deepEqual(tracker.takeCost({ responseId: "gen-1", usage }), { costUsd: 0.0123, estimated: false, source: "openrouter", byok: false });
  assert.equal(tracker.pendingCount(), 0);
  assert.deepEqual(tracker.takeCost({ responseId: "gen-2", usage }), { costUsd: 0.5, estimated: true, source: "catalog-estimate" });
});

test("strict tools reject arguments pi would otherwise coerce", () => {
  const schema = { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false };
  const execute = async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} });
  const lenient = toolFromJsonSchema({ name: "t", description: "t", jsonSchema: schema, execute });
  const strict = toolFromJsonSchema({ name: "t", description: "t", jsonSchema: schema, strict: true, execute });
  const toolCall = (args: Record<string, number | null>) => ({ type: "toolCall" as const, id: "1", name: "t", arguments: args });
  assert.equal(validateToolArguments(lenient, toolCall({ count: null })).count, 0, "pi coerces null to 0 by default");
  assert.throws(() => strict.prepareArguments?.({ count: null }), /Invalid arguments for tool "t"/);
  assert.deepEqual(strict.prepareArguments?.({ count: 2 }), { count: 2 });
});
```

Create `tests/compaction.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  COMPACTION_SUMMARY_PREFIX, compact, findCutIndex, isSummaryMessage, NothingToCompactError, serializeConversation, shouldCompact,
} from "../src/core/pi/compaction.js";
import { createStreamFn } from "../src/core/pi/models.js";
import { makeFaux, say } from "./helpers/faux.js";

let clock = 1_000;
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: clock++ });
const usageOf = (total: number): AssistantMessage["usage"] => ({
  input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const assistant = (content: AssistantMessage["content"], total = 0): AgentMessage => ({
  role: "assistant", content, api: "x", provider: "p", model: "m", usage: usageOf(total), stopReason: "stop", timestamp: clock++,
});
const toolCall = (id: string) => ({ type: "toolCall" as const, id, name: "tool", arguments: { id } });
const toolResult = (id: string, content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>): AgentMessage => ({
  role: "toolResult", toolCallId: id, toolName: "tool", content, isError: false, timestamp: clock++,
});
const chars = (count: number) => "x".repeat(count);

test("compacts when real usage passes the threshold of the context window", () => {
  const messages = [user("a"), assistant([{ type: "text", text: "b" }], 60_000)];
  assert.equal(shouldCompact(messages, 100_000), false, "exactly at 60% is not over");
  assert.equal(shouldCompact([user("a"), assistant([{ type: "text", text: "b" }], 60_001)], 100_000), true);
  assert.equal(shouldCompact([user("a"), assistant([{ type: "text", text: "b" }], 60_001)], 100_000, { thresholdRatio: 0.9 }), false);
  assert.equal(shouldCompact(messages, 0), false, "unknown context window never compacts");
});

test("never cuts at a tool result or between a tool call and its result", () => {
  const messages: AgentMessage[] = [];
  for (let turn = 0; turn < 40; turn += 1) {
    messages.push(user(chars(400)));
    messages.push(assistant([toolCall(`c${turn}`)]));
    messages.push(toolResult(`c${turn}`, [{ type: "text", text: chars(400) }]));
    messages.push(assistant([{ type: "text", text: chars(400) }]));
  }
  for (const budget of [50, 300, 1_000, 2_500, 6_000]) {
    const cut = findCutIndex(messages, budget);
    const role = messages[cut]?.role;
    assert.ok(role === "user" || role === "assistant", `cut at ${cut} landed on ${role}`);
    const kept = messages.slice(cut);
    const calls = new Set(kept.flatMap((message) => message.role === "assistant" ? (message as AssistantMessage).content.filter((block) => block.type === "toolCall").map((block) => (block as { id: string }).id) : []));
    for (const message of kept) {
      if (message.role === "toolResult") assert.ok(calls.has(message.toolCallId), `kept result ${message.toolCallId} lost its call`);
    }
  }
});

test("serialization marks images instead of embedding them and truncates long tool results", () => {
  const text = serializeConversation([
    user("look at this"),
    toolResult("c1", [{ type: "text", text: chars(5_000) }, { type: "image", data: "AAAABBBB", mimeType: "image/jpeg" }]),
  ] as Message[]);
  assert.ok(!text.includes("AAAABBBB"));
  assert.match(text, /\[1 image omitted: image\/jpeg\]/);
  assert.match(text, /\[\.\.\. 3000 more characters truncated\]/);
});

test("summarizes older messages once, records visual findings, and resumes as [summary, ...recent]", async () => {
  const { faux, models, model } = makeFaux();
  let request = "";
  faux.setResponses([(context) => {
    request = JSON.stringify(context.messages);
    return say("## Goal\nEdit the intro\n\n## Visual findings\n- frame at 1.0s showed a blue title card");
  }]);
  const messages: AgentMessage[] = [{ role: "system", content: "prompt", timestamp: 0 } as AgentMessage];
  for (let turn = 0; turn < 10; turn += 1) {
    messages.push(user(`request ${turn} ${chars(800)}`));
    messages.push(assistant([toolCall(`c${turn}`)]));
    messages.push(toolResult(`c${turn}`, [{ type: "text", text: "ok" }, { type: "image", data: "ZmFrZS1pbWFnZQ==", mimeType: "image/jpeg" }]));
    messages.push(assistant([{ type: "text", text: `done ${turn}` }]));
  }
  const result = await compact(messages, { model, streamFn: createStreamFn(models), keepRecentTokens: 700 });
  assert.equal(faux.state.callCount, 1);
  assert.match(request, /Visual findings/);
  assert.match(request, /\[1 image omitted: image\/jpeg\]/);
  assert.ok(!request.includes("ZmFrZS1pbWFnZQ=="), "image data must never reach the summarizer");
  assert.equal(result.messages[0]?.role, "system");
  assert.ok(isSummaryMessage(result.messages[1] as AgentMessage));
  assert.match(JSON.stringify(result.messages[1]), /frame at 1\.0s showed a blue title card/);
  assert.ok(JSON.stringify(result.messages[1]).includes(COMPACTION_SUMMARY_PREFIX.trim().slice(0, 20)));
  assert.equal(result.messages.length, 2 + result.keptMessages.length);
  assert.ok(result.keptMessages.length > 0 && result.keptMessages.length < messages.length - 1);
  assert.ok((result.summaryMessage.timestamp ?? 0) > Math.max(...result.keptMessages.map((message) => message.timestamp)));
});

test("refuses to compact a conversation that already fits", async () => {
  const { models, model } = makeFaux();
  await assert.rejects(
    compact([user("hi"), assistant([{ type: "text", text: "hello" }])], { model, streamFn: createStreamFn(models) }),
    NothingToCompactError,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL with `error TS2307: Cannot find module '../src/core/pi/models.js'` (and the same for `cost`, `tools`, `compaction`).

- [ ] **Step 3: Write the implementation**

Create `src/core/pi/models.ts`:

```typescript
/**
 * Model wiring for DumbEditor: OpenRouter as the sole provider.
 *
 * Verified against @earendil-works/pi-ai 1.0.0 (see SPIKE-REPORT.md).
 */
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type AuthContext,
  createAssistantMessageEventStream,
  createModels,
  type Model,
  type Models,
  type MutableModels,
  type SimpleStreamOptions,
  type OpenRouterRouting,
} from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { StreamFn } from "@earendil-works/pi-agent-core";

export const OPENROUTER_PROVIDER_ID = "openrouter";
export const OPENROUTER_OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
/** The catalog's anthropic/* entries use the Anthropic SDK, which appends /v1/messages itself. */
export const OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api";

const API_KEY_ENV = "OPENROUTER_API_KEY";

/**
 * A MutableModels with only the OpenRouter provider, authenticated with a key passed in code.
 *
 * How the key is supplied (all verified in tests/models.test.ts):
 *  - `createModels({ authContext })`: the provider's `envApiKeyAuth("...", ["OPENROUTER_API_KEY"])`
 *    reads env vars through `authContext.env(name)`. We replace the default context (which reads
 *    process.env) with one that answers only for our key. process.env is never consulted/mutated.
 *  - Alternatives that also work: a `CredentialStore` seeded with `{type:"api_key", key}`, or a
 *    per-request `apiKey` option (which the Agent sets from `getApiKey(provider)` / `config.apiKey`).
 */
export function createEditorModels(opts: { apiKey: string }): MutableModels {
  const authContext: AuthContext = {
    env: async (name) => (name === API_KEY_ENV ? opts.apiKey : undefined),
    fileExists: async () => false,
  };
  const models = createModels({ authContext });
  models.setProvider(openrouterProvider());
  return models;
}

export interface OpenRouterModelOptions {
  /** Override the base URL (used by tests to point at a local fake server). */
  baseUrl?: string;
  /** Extra routing prefs merged over `{ require_parameters: true }`. */
  routing?: OpenRouterRouting;
}

/** Placeholder literal for an OpenRouter model id that is not in pi's generated catalog yet. */
function unknownOpenRouterModel(id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: OPENROUTER_PROVIDER_ID,
    baseUrl: OPENROUTER_OPENAI_BASE_URL,
    reasoning: false,
    input: ["text", "image"],
    // $/million tokens. Unknown pricing: zero. Real cost comes from OpenRouter (see cost.ts).
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    // Same compat the catalog gives openai-completions models on OpenRouter.
    compat: { thinkingFormat: "openrouter", sendSessionAffinityHeaders: true },
  };
}

/**
 * Catalog model if known, else a literal. In BOTH cases returns a fresh object with
 * `compat.openRouterRouting.require_parameters = true`; the shared catalog object is never mutated
 * (the catalog's `compat` object is shared too, so it is copied as well).
 *
 * CAVEAT (verified in source): `openRouterRouting` is only read by the openai-completions adapter
 * (`params.provider = model.compat.openRouterRouting`). The catalog's `anthropic/*` models
 * (api "anthropic-messages") ignore it. Use `withOpenRouterRoutingPayload` for those if you need it.
 */
export function openRouterModel(models: Models, id: string, opts: OpenRouterModelOptions = {}): Model<Api> {
  const base: Model<Api> = models.getModel(OPENROUTER_PROVIDER_ID, id) ?? unknownOpenRouterModel(id);
  const compat = (base.compat ?? {}) as Record<string, unknown>;
  const previousRouting = (compat.openRouterRouting ?? {}) as OpenRouterRouting;
  return {
    ...base,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    compat: {
      ...compat,
      openRouterRouting: { ...previousRouting, require_parameters: true, ...opts.routing },
    },
  } as Model<Api>;
}

/** True when the catalog knows this id (so `openRouterModel` returns catalog data, not a literal). */
export function isCatalogModel(models: Models, id: string): boolean {
  return models.getModel(OPENROUTER_PROVIDER_ID, id) !== undefined;
}

type OnPayload = NonNullable<SimpleStreamOptions["onPayload"]>;

/**
 * `onPayload` hook that adds `provider: { require_parameters: true, ... }` to the request body of
 * models that go through the anthropic-messages adapter (where compat.openRouterRouting is ignored).
 * UNVERIFIED against the live OpenRouter /messages endpoint (no network in the spike): only the
 * payload mutation is tested. Opt in only after confirming OpenRouter accepts `provider` there.
 */
export function withOpenRouterRoutingPayload(routing: OpenRouterRouting = { require_parameters: true }): OnPayload {
  return (payload, model) => {
    if (model.api !== "anthropic-messages" || typeof payload !== "object" || payload === null) return undefined;
    return { ...(payload as Record<string, unknown>), provider: routing };
  };
}

/** Options we may default. Everything in SimpleStreamOptions is allowed; these are the ones that matter. */
export type StreamDefaults = Partial<SimpleStreamOptions>;

export const EDITOR_STREAM_DEFAULTS: StreamDefaults = { maxRetries: 3, cacheRetention: "short" };

function chain<A extends unknown[]>(
  first: ((...args: A) => unknown) | undefined,
  second: ((...args: A) => unknown) | undefined,
): ((...args: A) => Promise<void>) | undefined {
  if (!first) return second as undefined | ((...args: A) => Promise<void>);
  if (!second) return first as (...args: A) => Promise<void>;
  return async (...args: A) => {
    await first(...args);
    await second(...args);
  };
}

/**
 * Merge request options: per-call values win, but `undefined` never clobbers a default
 * (the Agent always passes keys like `sessionId: undefined`, `onPayload: undefined`, ...).
 * `headers` are shallow-merged and the three callbacks are chained (defaults first).
 */
export function mergeStreamOptions(defaults: StreamDefaults, options: SimpleStreamOptions | undefined): SimpleStreamOptions {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value !== undefined) merged[key] = value;
  }
  if (defaults.headers && options?.headers) merged.headers = { ...defaults.headers, ...options.headers };

  if (defaults.onProviderStreamEvent || options?.onProviderStreamEvent) {
    merged.onProviderStreamEvent = chain(defaults.onProviderStreamEvent, options?.onProviderStreamEvent);
  }
  if (defaults.onResponse || options?.onResponse) {
    merged.onResponse = chain(defaults.onResponse, options?.onResponse);
  }
  if (defaults.onPayload || options?.onPayload) {
    const a = defaults.onPayload;
    const b = options?.onPayload;
    merged.onPayload = async (payload: unknown, model: Model<Api>) => {
      const afterA = a ? ((await a(payload, model)) ?? payload) : payload;
      const afterB = b ? ((await b(afterA, model)) ?? afterA) : afterA;
      return afterB === payload ? undefined : afterB;
    };
  }
  return merged as SimpleStreamOptions;
}

function abortedMessage(model: Model<Api>, base?: AssistantMessage): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...base,
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    timestamp: Date.now(),
  };
}

/**
 * GOTCHA (verified): `Models.streamSimple` resolves auth first, and auth resolution throws
 * AbortError when the signal is already aborted. `lazyStream` then reports stopReason "error"
 * ("This operation was aborted") instead of "aborted". The Agent loop ALWAYS makes one more request
 * after an abort during a tool batch (it does not check the signal before requesting), so without this
 * normalization every abort-during-tools run would end as an "error". Mid-stream aborts inside the
 * adapters are already reported as "aborted".
 */
export function normalizeAbort(model: Model<Api>, source: AssistantMessageEventStream, signal: AbortSignal | undefined): AssistantMessageEventStream {
  if (!signal) return source;
  const out = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        if (event.type === "error" && event.reason === "error" && signal.aborted) {
          const message = abortedMessage(model, event.error);
          out.push({ type: "error", reason: "aborted", error: message });
          out.end(message);
          return;
        }
        out.push(event);
      }
      out.end(await source.result());
    } catch (error) {
      // Contract: a StreamFn must not reject; encode it in the stream.
      const message: AssistantMessage = { ...abortedMessage(model), stopReason: signal.aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error) };
      out.push({ type: "error", reason: message.stopReason as "aborted" | "error", error: message });
      out.end(message);
    }
  })();
  return out;
}

/**
 * StreamFn for `new Agent({ streamFn })` and for the compaction summarizer.
 * `Agent` forwards only: apiKey, signal, reasoning, sessionId, onPayload, onResponse,
 * onProviderStreamEvent, transport, thinkingBudgets, maxRetryDelayMs. Everything else
 * (maxRetries, cacheRetention, timeoutMs, maxTokens, headers, metadata, temperature, fetch, env...)
 * can only reach the provider through this wrapper.
 */
export function createStreamFn(models: Models, defaults: StreamDefaults = EDITOR_STREAM_DEFAULTS): StreamFn {
  return (model, context, options) => {
    if (options?.signal?.aborted) {
      const message = abortedMessage(model);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: "aborted", error: message });
      stream.end(message);
      return stream;
    }
    return normalizeAbort(model, models.streamSimple(model, context, mergeStreamOptions(defaults, options)), options?.signal);
  };
}
```

Create `src/core/pi/cost.ts`:

```typescript
/**
 * Capture OpenRouter's real per-request cost.
 *
 * What `onProviderStreamEvent(data, model)` receives (verified in
 * pi-ai/src/api/openai-completions.ts and anthropic-messages.ts, and end-to-end against a local fake
 * server in cost.test.ts):
 *
 *  - openai-completions (every non-anthropic OpenRouter model): `data` is the RAW parsed
 *    `ChatCompletionChunk` object, passed before pi normalizes anything:
 *        openai-completions.ts:554   `await options?.onProviderStreamEvent?.(chunk, model);`
 *    pi's own `parseChunkUsage` (openai-completions.ts:1511) IGNORES `usage.cost`, so this hook is
 *    the only place the OpenRouter-reported cost is visible. OpenRouter puts it on the final usage
 *    chunk: `{ id, model, choices: [], usage: { prompt_tokens, completion_tokens, total_tokens,
 *    cost, is_byok, cost_details: { upstream_inference_cost, ... }, ... } }`. (That OpenRouter
 *    wire shape is from OpenRouter's docs/knowledge, NOT verified against the live API here.)
 *
 *  - anthropic-messages (the catalog's anthropic/* models): `data` is the raw Anthropic
 *    `RawMessageStreamEvent` (anthropic-messages.ts:664). `message_start.message.id` is the response
 *    id; `message_delta.usage` carries token counts. Whether OpenRouter's Anthropic-compatible
 *    endpoint adds `usage.cost` there CANNOT be verified without network; this module looks for a
 *    numeric `usage.cost` on `message_start.message` / `message_delta` and otherwise falls back.
 *
 * The cost is matched to an assistant message by `message.responseId`
 * (chat: `chunk.id` -> openai-completions.ts:558; anthropic: `message_start.message.id` -> :666).
 */
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

export interface RequestCost {
  costUsd: number;
  /** true when this is pi's catalog-price estimate (`usage.cost.total`), not OpenRouter's number. */
  estimated: boolean;
  source: "openrouter" | "catalog-estimate";
  /** OpenRouter BYOK flag, when reported. For BYOK, `costUsd` is what OpenRouter charged (fee only). */
  byok?: boolean;
  /** `usage.cost_details.upstream_inference_cost`, when reported. */
  upstreamCostUsd?: number;
}

export interface CostTracker {
  /** Pass as `onProviderStreamEvent` (Agent option / StreamFn defaults). */
  onProviderStreamEvent: (data: unknown, model: Model<Api>) => void;
  /**
   * Cost for a finished assistant message. Prefers the OpenRouter-reported cost captured for
   * `message.responseId` (and forgets it); otherwise returns `message.usage.cost.total` with
   * `estimated: true`. Returns undefined only when the message has neither (no usage at all).
   */
  takeCost(message: Pick<AssistantMessage, "responseId" | "usage">): RequestCost | undefined;
  /** Number of captured-but-not-yet-taken OpenRouter costs (for leak checks). */
  pendingCount(): number;
}

interface Captured {
  costUsd: number;
  byok?: boolean;
  upstreamCostUsd?: number;
}

const MAX_PENDING = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readUsageCost(usage: unknown): Captured | undefined {
  if (!isRecord(usage)) return undefined;
  const costUsd = finiteNumber(usage.cost);
  if (costUsd === undefined) return undefined;
  const details = isRecord(usage.cost_details) ? usage.cost_details : undefined;
  const upstream = finiteNumber(details?.upstream_inference_cost);
  return {
    costUsd,
    ...(typeof usage.is_byok === "boolean" ? { byok: usage.is_byok } : {}),
    ...(upstream !== undefined ? { upstreamCostUsd: upstream } : {}),
  };
}

export function createCostTracker(): CostTracker {
  const captured = new Map<string, Captured>();
  // anthropic-messages events do not repeat the response id after message_start.
  // NOTE: this makes the anthropic path lane-scoped: use one tracker per sequential request lane.
  let currentAnthropicId: string | undefined;

  const remember = (id: string | undefined, value: Captured) => {
    if (!id) return;
    captured.set(id, value);
    while (captured.size > MAX_PENDING) captured.delete(captured.keys().next().value as string);
  };

  return {
    onProviderStreamEvent(data) {
      if (!isRecord(data)) return;
      // Anthropic raw stream events
      if (data.type === "message_start" && isRecord(data.message)) {
        currentAnthropicId = typeof data.message.id === "string" ? data.message.id : undefined;
        const cost = readUsageCost(data.message.usage);
        if (cost) remember(currentAnthropicId, cost);
        return;
      }
      if (data.type === "message_delta") {
        const cost = readUsageCost(data.usage);
        if (cost) remember(currentAnthropicId, cost);
        return;
      }
      // OpenAI-compatible chat completion chunk (OpenRouter): usage.cost on the final chunk.
      const cost = readUsageCost(data.usage);
      if (cost && typeof data.id === "string") remember(data.id, cost);
    },

    takeCost(message) {
      const id = message.responseId;
      const real = id ? captured.get(id) : undefined;
      if (id && real) {
        captured.delete(id);
        return { ...real, estimated: false, source: "openrouter" };
      }
      const total = message.usage?.cost?.total;
      if (typeof total !== "number") return undefined;
      return { costUsd: total, estimated: true, source: "catalog-estimate" };
    },

    pendingCount: () => captured.size,
  };
}
```

Create `src/core/pi/tools.ts`:

```typescript
/**
 * Build an AgentTool from an existing hand-written raw JSON Schema.
 *
 * `Type.Unsafe(raw)` returns the raw schema object unchanged (JSON.stringify equals the input), typed
 * as TUnsafe<TArgs>. pi then validates tool-call arguments against it with typebox (Compile + Check).
 *
 * GOTCHA (verified): before checking, pi runs `Value.Convert` + its own JSON-schema coercion on the
 * arguments, so validation is LENIENT: "12" -> 12 for integers, 7 -> "7" for strings, and `null` for a
 * NON-nullable required string/integer is silently coerced to "" / 0 and passes. Nullable unions such
 * as {type:["integer","null"]} keep `null` as null. Pass `strict: true` to reject anything that does
 * not match the raw schema exactly (checked in `prepareArguments`, i.e. before coercion).
 */
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type TUnsafe, Type } from "typebox";
import { Compile } from "typebox/compile";

export interface JsonSchemaToolDef<TArgs, TDetails> {
  name: string;
  label?: string;
  description: string;
  /** The hand-written JSON Schema (type: "object", required, additionalProperties: false, ...). */
  jsonSchema: Record<string, unknown>;
  strict?: boolean;
  executionMode?: "sequential" | "parallel";
  execute: (
    toolCallId: string,
    args: TArgs,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
  ) => Promise<AgentToolResult<TDetails>>;
}

export function toolFromJsonSchema<TArgs = Record<string, unknown>, TDetails = unknown>(
  def: JsonSchemaToolDef<TArgs, TDetails>,
): AgentTool<TUnsafe<TArgs>, TDetails> {
  const parameters = Type.Unsafe<TArgs>(def.jsonSchema);
  const strictValidator = def.strict ? Compile(parameters) : undefined;
  return {
    name: def.name,
    label: def.label ?? def.name,
    description: def.description,
    parameters,
    ...(def.executionMode ? { executionMode: def.executionMode } : {}),
    ...(strictValidator
      ? {
          prepareArguments: (args: unknown) => {
            if (strictValidator.Check(args)) return args as TArgs;
            const errors = [...strictValidator.Errors(args)]
              .map((e) => `  - ${e.instancePath || "root"}: ${e.message}`)
              .join("\n");
            throw new Error(`Invalid arguments for tool "${def.name}":\n${errors}`);
          },
        }
      : {}),
    execute: def.execute,
  };
}
```

`compaction.ts` is adapted from pi's MIT-licensed compaction (see its header):

Create `src/core/pi/compaction.ts`:

```typescript
/**
 * Context compaction for DumbEditor, operating on plain `AgentMessage[]`.
 *
 * VENDORED AND ADAPTED from pi-coding-agent's compaction
 * (https://github.com/earendil-works/pi, packages/coding-agent/src/core/compaction/compaction.ts
 * and utils.ts), MIT License.
 *
 *   MIT License
 *   Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright notice and this
 * permission notice shall be included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. (Full text: pi's LICENSE file.)
 *
 * Changes from upstream:
 *  - no session classes / entries / extensions; works on a plain message array and returns data.
 *  - summarizer goes through an injected `streamFn` (no global `completeSimple` from pi-ai/compat).
 *  - summary checkpoint gains a "## Visual findings" section (image blocks are dropped when the
 *    conversation is serialized to text, so whatever a frame showed must be written down).
 *  - serialization marks dropped images with `[image omitted]` so the summarizer knows where they were.
 *  - the summary is a plain `user` message (no custom message role / convertToLlm needed).
 *  - split-turn handling is simplified: everything before the cut goes into ONE summary call.
 *  - file-operation tracking (read/write/edit tool names) is dropped; DumbEditor has different tools.
 *  - token estimation comes from pi-ai (`@earendil-works/pi-ai/utils/estimate`).
 */
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  contentText,
  getCurrentSystemMessage,
  type Message,
  type Model,
  normalizeContext,
  type RetryPolicy,
  retryAssistantCall,
  type SimpleStreamOptions,
  type SystemMessage,
  type TranscriptContext,
  uuidv7,
} from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";

export { calculateContextTokens, estimateContextTokens };

// ============================================================================
// Prompts (pi's structured checkpoint + Visual findings)
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const VISUAL_FINDINGS_SECTION = `## Visual findings
- [Images, video frames and screenshots are NOT included in the conversation above; each place where one was inspected is marked "[image omitted]". For every inspected frame/image, record AS TEXT what it showed: which clip/timestamp it came from, what was visible (subjects, on-screen text, framing, colors, quality problems), and any decision it led to. This section is the ONLY surviving record of what was seen.]
- [Or "(none)" if no images were inspected]`;

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

${VISUAL_FINDINGS_SECTION}

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- PRESERVE every existing entry in "Visual findings" and ADD entries for newly inspected images/frames
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

${VISUAL_FINDINGS_SECTION}

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

// ============================================================================
// Serialization (pi utils.ts, plus image markers)
// ============================================================================

/** Maximum characters for a tool result in serialized summaries (pi: 2000). */
export const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

function imageMarker(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const images = content.filter((b) => b?.type === "image");
  if (images.length === 0) return "";
  const kinds = [...new Set(images.map((b) => b.mimeType))].join(", ");
  return `[${images.length} image${images.length > 1 ? "s" : ""} omitted: ${kinds}]`;
}

/**
 * Serialize LLM messages to text for summarization (so the model does not treat it as a conversation
 * to continue). Tool results are truncated; image blocks are replaced by `[image omitted]` markers
 * (the base64 data never reaches the summarizer). System messages are skipped.
 */
export function serializeConversation(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = [contentText(msg.content, ""), imageMarker(msg.content)].filter(Boolean).join(" ");
      if (text) parts.push(`[User]: ${text}`);
    } else if (msg.role === "assistant") {
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];
      for (const block of msg.content) {
        if (block.type === "thinking") {
          thinkingParts.push(block.thinking);
        } else if (block.type === "toolCall") {
          const args = block.arguments as Record<string, unknown>;
          const argsStr = Object.entries(args)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ");
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }
      if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
      if (msg.content.some((block) => block.type === "text")) parts.push(`[Assistant]: ${contentText(msg.content)}`);
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
    } else if (msg.role === "toolResult") {
      const text = contentText(msg.content, "");
      const marker = imageMarker(msg.content);
      const body = [text ? truncateForSummary(text, TOOL_RESULT_MAX_CHARS) : "", marker].filter(Boolean).join(" ");
      if (body) parts.push(`[Tool result]: ${body}`);
    }
  }
  return parts.join("\n\n");
}

// ============================================================================
// Token accounting / thresholds
// ============================================================================

export interface ShouldCompactOptions {
  /** Compact when estimated context tokens exceed `contextWindow * thresholdRatio`. Default 0.6. */
  thresholdRatio?: number;
}

/**
 * Real usage from the last valid assistant message (non-aborted, non-error, usage > 0) plus a
 * chars/4 estimate for everything after it; if no assistant usage applies, estimates everything.
 *
 * pi-ai's `estimateContextTokens` ignores an assistant's usage when a LATER-timestamped message precedes it
 * in the array (e.g. a fresh compaction summary): stale pre-compaction usage must not retrigger compaction.
 */
export function shouldCompact(messages: readonly AgentMessage[], contextWindow: number, opts: ShouldCompactOptions = {}): boolean {
  if (!(contextWindow > 0)) return false;
  const ratio = opts.thresholdRatio ?? 0.6;
  return estimateContextTokens(messages as Message[]).tokens > contextWindow * ratio;
}

// ============================================================================
// Cut point
// ============================================================================

function isCutPoint(message: AgentMessage): boolean {
  return message.role === "user" || message.role === "assistant"; // never "toolResult", never "system"
}

/** Index of the first non-system message (where the conversation starts). */
function firstConversationIndex(messages: readonly AgentMessage[]): number {
  const i = messages.findIndex((m) => m.role !== "system");
  return i === -1 ? messages.length : i;
}

/**
 * Index of the first message to KEEP. Everything before it (except system messages) gets summarized.
 *
 * Walk backwards from the newest message accumulating estimated sizes; when the budget
 * (`keepRecentTokens`) is reached at message i, cut at the closest user/assistant message at or after i
 * (pi's rule). A tool result is never a cut point, so an assistant message's tool calls always stay
 * with their results: cutting AT the assistant message keeps both, cutting AFTER its results drops both.
 *
 * Returns the first conversation index (= nothing to summarize) when the whole conversation fits the budget.
 */
export function findCutIndex(messages: readonly AgentMessage[], keepRecentTokens = 20_000): number {
  const start = firstConversationIndex(messages);
  const cutPoints: number[] = [];
  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (message && isCutPoint(message)) cutPoints.push(i);
  }
  if (cutPoints.length === 0) return start;

  let accumulated = 0;
  for (let i = messages.length - 1; i >= start; i--) {
    accumulated += estimateMessageTokens(messages[i] as Message);
    if (accumulated >= keepRecentTokens) {
      return cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1] ?? start;
    }
  }
  return start;
}

// ============================================================================
// Summarization
// ============================================================================

/** The summarizer call: `streamFn` (preferred; e.g. createStreamFn) or any completeSimple-compatible fn. */
export type CompleteFn = (model: Model<any>, context: TranscriptContext, options: SimpleStreamOptions) => Promise<AssistantMessage>;

export interface CompactOptions {
  model: Model<any>;
  /** One of `streamFn` / `complete` is required. */
  streamFn?: StreamFn;
  complete?: CompleteFn;
  /** Default 20000. */
  keepRecentTokens?: number;
  /** Output budget basis: maxTokens = min(0.8 * reserveTokens, model.maxTokens). Default 16384 (pi). */
  reserveTokens?: number;
  signal?: AbortSignal;
  /** Summary text from an earlier compaction. Auto-detected from a leading summary message if omitted. */
  previousSummary?: string;
  /** Extra instruction appended to the prompt ("Additional focus: ..."). */
  customInstructions?: string;
  /** Routing id for the summary request (a fresh uuidv7 when omitted, like pi). */
  sessionId?: string;
  apiKey?: string;
  retry?: RetryPolicy;
}

export interface CompactionResult {
  /** Plain `user` message; timestamp = now so stale pre-compaction usage is ignored by estimates. */
  summaryMessage: AgentMessage;
  /** Messages from the cut onward, WITHOUT system messages. */
  keptMessages: AgentMessage[];
  tokensBefore: number;
  /** Replayed head (prompt + sections + tools) of the original transcript, to put in front. */
  systemMessage?: SystemMessage;
  /** Ready to use: [systemMessage?, summaryMessage, ...keptMessages]. */
  messages: AgentMessage[];
  /** The raw summary text (without the wrapper prefix) for storage / `previousSummary`. */
  summary: string;
  /** Usage of the summarizer call itself (bill it). */
  usage: AssistantMessage["usage"];
  /** Provider response id of the summarizer call, to look up its real cost. */
  responseId?: string;
}

export class NothingToCompactError extends Error {
  constructor() {
    super("Nothing to compact: the conversation fits within keepRecentTokens");
    this.name = "NothingToCompactError";
  }
}

export function isSummaryMessage(message: AgentMessage): boolean {
  if (message.role !== "user") return false;
  const text = typeof message.content === "string" ? message.content : contentText(message.content);
  return text.startsWith(COMPACTION_SUMMARY_PREFIX);
}

function extractSummary(message: AgentMessage): string {
  const content = (message as any).content;
  const raw: string = typeof content === "string" ? content : contentText(content);
  const body = raw.slice(COMPACTION_SUMMARY_PREFIX.length);
  return body.endsWith(COMPACTION_SUMMARY_SUFFIX) ? body.slice(0, -COMPACTION_SUMMARY_SUFFIX.length) : body;
}

export function createSummaryMessage(summary: string, timestamp = Date.now()): AgentMessage {
  return { role: "user", content: [{ type: "text", text: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX }], timestamp };
}

function buildSummarizationContext(promptText: string): TranscriptContext {
  return normalizeContext({
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
  });
}

export async function compact(messages: readonly AgentMessage[], opts: CompactOptions): Promise<CompactionResult> {
  if (!opts.streamFn && !opts.complete) throw new Error("compact(): provide `streamFn` or `complete`");
  const keepRecentTokens = opts.keepRecentTokens ?? 20_000;
  const tokensBefore = estimateContextTokens(messages as Message[]).tokens;

  const start = firstConversationIndex(messages);
  const cut = findCutIndex(messages, keepRecentTokens);

  // A leading summary message from an earlier compaction becomes `previousSummary`.
  let previousSummary = opts.previousSummary;
  let historyStart = start;
  if (messages[start] && isSummaryMessage(messages[start]) && cut > start) {
    previousSummary ??= extractSummary(messages[start]);
    historyStart = start + 1;
  }
  const toSummarize = messages.slice(historyStart, cut).filter((m) => m.role !== "system");
  if (cut <= start || toSummarize.length === 0) throw new NothingToCompactError();
  const keptMessages = messages.slice(cut).filter((m) => m.role !== "system");

  const reserveTokens = opts.reserveTokens ?? 16_384;
  const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), opts.model.maxTokens > 0 ? opts.model.maxTokens : Number.POSITIVE_INFINITY);

  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (opts.customInstructions) basePrompt = `${basePrompt}\n\nAdditional focus: ${opts.customInstructions}`;
  let promptText = `<conversation>\n${serializeConversation(toSummarize as Message[])}\n</conversation>\n\n`;
  if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  promptText += basePrompt;

  // No cache writes for a one-off call (pi), but keep a routing id.
  const requestOptions: SimpleStreamOptions = {
    maxTokens,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    cacheRetention: "none",
    sessionId: opts.sessionId ?? uuidv7(),
  };
  const context = buildSummarizationContext(promptText);
  const produce = async (): Promise<AssistantMessage> =>
    opts.streamFn ? (await opts.streamFn(opts.model, context, requestOptions)).result() : opts.complete!(opts.model, context, requestOptions);
  const response = await retryAssistantCall(produce, opts.retry, opts.signal);

  if (response.stopReason === "aborted") throw new Error("Summarization aborted");
  if (response.stopReason === "error") throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
  if (response.stopReason === "length") throw new Error("Summarization failed: generation hit the token cap and the summary is incomplete");
  if (response.content.some((block) => block.type === "toolCall")) throw new Error("Summarization attempted to call a tool");
  const summary = contentText(response.content).trim();
  if (!summary) throw new Error("Summarization failed: empty summary");

  // Newer than every kept message so pi-ai ignores their (pre-compaction) usage in estimates.
  const newest = Math.max(Date.now(), ...keptMessages.map((m) => m.timestamp + 1));
  const summaryMessage = createSummaryMessage(summary, newest);
  const systemMessage = getCurrentSystemMessage(messages);
  return {
    summaryMessage,
    keptMessages,
    tokensBefore,
    ...(systemMessage ? { systemMessage } : {}),
    messages: [...(systemMessage ? [systemMessage] : []), summaryMessage, ...keptMessages],
    summary,
    usage: response.usage,
    ...(response.responseId ? { responseId: response.responseId } : {}),
  };
}

```

Create `src/core/pi/editor-state-sync.ts`:

```typescript
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
```

Create `THIRD_PARTY.md`:

```markdown
# Third-party notices

## pi (earendil-works/pi), compaction

`src/core/pi/compaction.ts` is adapted from the compaction code in `pi-coding-agent`
(`packages/coding-agent/src/core/compaction/compaction.ts` and `utils.ts`) from
https://github.com/earendil-works/pi. It is used under the MIT License:

```
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` packages are installed as
dependencies under the same license.
```

Register the new tests and ship the notice file:

Apply this change to `package.json`:

```diff
--- a/package.json
+++ b/package.json
@@ -10,13 +10,14 @@
     "dist",
     "README.md",
     "skills",
-    "LICENSE"
+    "LICENSE",
+    "THIRD_PARTY.md"
   ],
   "scripts": {
     "build": "tsup",
     "check": "tsc --noEmit",
     "dev": "tsx src/cli.tsx",
-    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/luna.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/transcription.test.js",
+    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/luna.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/transcription.test.js",
     "quality": "npm run check && npm test && npm run build",
     "release:check": "npm run quality && npm pack --dry-run",
     "prepublishOnly": "npm run quality"
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js
```

Expected: 11 passed (6 in `pi-layer`, 5 in `compaction`), 0 failed. Then the whole suite:

```bash
npm test
```

Expected: undefined tests, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/core/pi tests THIRD_PARTY.md package.json
git commit -m "feat: add the pi layer for OpenRouter models, cost, tools, compaction and state injection"
```

## Task 3: Version pinning, usage kind, abort support and the shared editor state

**Files:**
- Create: `src/core/state/editor-state.ts`, `tests/helpers/project.ts`, `tests/editor-state.test.ts`
- Modify: `src/types.ts`, `src/core/project.ts`, `src/core/usage.ts`, `src/core/editor.ts`, `src/core/advanced-editor.ts`, `package.json` (`test` script)

**Interfaces:**
- Consumes: `probeMedia`, `AgentWorkspace`, `ProjectStore`, `summarizeUsage` (existing).
- Produces:
  - `ProjectStore.resolveVersion(reference: string): VersionEntry`, `ProjectStore.pinnedVersionIds: readonly string[]`, `ProjectStore.pinVersion(id: string): Promise<void>` (newest `MAX_PINNED_VERSIONS = 20` stay pinned; pruning never removes pinned versions).
  - `UsageKind` gains `"agent"`; `summarizeUsage().lunaUsd` now sums `agent` and `luna` entries (the field name is kept so existing displays and ledgers keep working).
  - `executeDirectEdit(store, edit, request, onStage?, signal?)` and `executeAdvancedEdit(store, edit, request, onStage?, signal?)`: the new `signal` kills FFmpeg and commits nothing.
  - `class EditorState` (`src/core/state/editor-state.ts`): `static open(store): Promise<EditorState>`; readonly `store`, `workspace`; getters `media`, `playhead`, `selection`, `assets`, `usage`, `revision`; `subscribe(listener): () => void`; `setPlayhead(seconds)`, `setSelection({ in, out })`; `afterVersionChange(): Promise<void>` (re-probe, reset playhead/marks, pin the active version); `revertTo(reference): Promise<VersionEntry>`; `refreshAssets()`; `recordUsage(entry)`; `describe(): { revision: number; body: string }`.
  - `makeProject(): Promise<{ directory, store, state, cleanup() }>` in `tests/helpers/project.ts` (a real 4 s 320x180 video with audio).

- [ ] **Step 1: Write the tests and the project helper**

Create `tests/helpers/project.ts`:

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../src/core/process.js";
import { ProjectStore } from "../../src/core/project.js";
import { EditorState } from "../../src/core/state/editor-state.js";

export interface TestProject {
  directory: string;
  store: ProjectStore;
  state: EditorState;
  cleanup(): Promise<void>;
}

/** A real 4 second 320x180 video with audio, opened as a project in a temp directory. */
export async function makeProject(): Promise<TestProject> {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-core-"));
  const previousConfig = process.env.DUMBEDITOR_CONFIG_DIR;
  process.env.DUMBEDITOR_CONFIG_DIR = join(directory, "config");
  const source = join(directory, "source.mp4");
  await runProcess("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
  ], { timeoutMs: 60_000 });
  const store = await ProjectStore.open(source);
  const state = await EditorState.open(store);
  return {
    directory, store, state,
    async cleanup() {
      if (previousConfig === undefined) delete process.env.DUMBEDITOR_CONFIG_DIR;
      else process.env.DUMBEDITOR_CONFIG_DIR = previousConfig;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
```

Create `tests/editor-state.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { copyFile } from "node:fs/promises";
import { summarizeUsage } from "../src/core/usage.js";
import { makeProject } from "./helpers/project.js";

test("pinned versions survive retention pruning; unpinned ones do not", { timeout: 90_000 }, async () => {
  const project = await makeProject();
  try {
    await project.store.setVersionLimit(1);
    const commit = async () => {
      const output = project.store.nextOutputPath();
      await copyFile(project.store.snapshot.sourcePath, output);
      return project.store.commit({ outputPath: output, action: "copy", request: "test", duration: 4 });
    };
    const first = await commit();
    await project.store.pinVersion(first.id);
    await commit();
    await commit();
    const ids = project.store.snapshot.versions.map((version) => version.id);
    assert.ok(ids.includes("v0001"), "pinned version must be retained");
    assert.ok(!ids.includes("v0002"), "unpinned older version is pruned");
    assert.ok(ids.includes("v0003"), "the active version is retained");
  } finally {
    await project.cleanup();
  }
});

test("pinning keeps only the newest twenty versions and ignores unknown ids", { timeout: 90_000 }, async () => {
  const project = await makeProject();
  try {
    await project.store.pinVersion("v9999");
    assert.deepEqual([...project.store.pinnedVersionIds], []);
    await project.store.setVersionLimit(100);
    for (let index = 0; index < 22; index += 1) {
      const output = project.store.nextOutputPath();
      await copyFile(project.store.snapshot.sourcePath, output);
      const version = await project.store.commit({ outputPath: output, action: "copy", request: "test", duration: 4 });
      await project.store.pinVersion(version.id);
    }
    assert.equal(project.store.pinnedVersionIds.length, 20);
    assert.equal(project.store.pinnedVersionIds.at(-1), "v0022");
    assert.ok(!project.store.pinnedVersionIds.includes("v0001"));
  } finally {
    await project.cleanup();
  }
});

test("editor state bumps its revision only when the described text changes", { timeout: 60_000 }, async () => {
  const project = await makeProject();
  try {
    const { state } = project;
    let notified = 0;
    state.subscribe(() => { notified += 1; });
    const start = state.revision;
    state.setPlayhead(1.04);
    assert.equal(state.revision, start + 1);
    state.setPlayhead(1.01);
    assert.equal(state.revision, start + 1, "a move inside the same tenth of a second changes nothing");
    state.setSelection({ in: 1, out: null });
    state.setSelection({ in: 1, out: null });
    assert.equal(state.revision, start + 2, "setting the same marks twice changes nothing");
    state.setPlayhead(99);
    assert.equal(state.playhead, state.media.duration, "the playhead is clamped to the video");
    assert.ok(notified >= 3);
    const described = state.describe();
    assert.equal(described.revision, state.revision);
    assert.match(described.body, /In mark: 1\.0s/);
  } finally {
    await project.cleanup();
  }
});

test("recorded usage reaches the in-memory summary and the saved ledger, counting agent cost with the editor model", { timeout: 60_000 }, async () => {
  const project = await makeProject();
  try {
    await project.state.recordUsage({ kind: "agent", provider: "openrouter", model: "m", label: "turn", costUsd: 0.25, estimated: false });
    await project.state.recordUsage({ kind: "asset", provider: "openrouter", model: "m", label: "image", costUsd: 0.5, estimated: true });
    assert.deepEqual(project.state.usage, { totalUsd: 0.75, lunaUsd: 0.25, assetUsd: 0.5, harnessUsd: 0, entries: 2 });
    assert.deepEqual(summarizeUsage(await project.store.usageEntries()), project.state.usage);
  } finally {
    await project.cleanup();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL with `Cannot find module '../src/core/state/editor-state.js'` and `Property 'pinVersion' does not exist on type 'ProjectStore'`.

- [ ] **Step 3: Write the implementation**

Create `src/core/state/editor-state.ts`:

```typescript
import type { MediaInfo, Selection, VersionEntry } from "../../types.js";
import { AgentWorkspace, type AgentAsset } from "../agent-workspace.js";
import { probeMedia } from "../media.js";
import type { ProjectStore } from "../project.js";
import { formatTime } from "../time.js";
import { summarizeUsage, type UsageEntry, type UsageSummary } from "../usage.js";

export interface EditorStateDescription {
  /** Increments whenever the described text would change. */
  revision: number;
  /** What the agent reads each turn it changed. */
  body: string;
}

/**
 * The single live view of the open project. The UI reads it, the agent reads it, and actions
 * write it. Durable data stays in ProjectStore; this class adds what is only true right now
 * (playhead, marks) and notifies subscribers when anything changes.
 */
export class EditorState {
  private readonly listeners = new Set<() => void>();
  private revisionCounter = 0;
  private mediaInfo: MediaInfo;
  private playheadSeconds = 0;
  private marks: Selection = { in: null, out: null };
  private assetList: AgentAsset[] = [];
  private usageEntries: UsageEntry[] = [];

  private constructor(readonly store: ProjectStore, readonly workspace: AgentWorkspace, media: MediaInfo) {
    this.mediaInfo = media;
  }

  static async open(store: ProjectStore): Promise<EditorState> {
    const workspace = new AgentWorkspace(store.createAgentWorkspace());
    await workspace.initialize();
    const state = new EditorState(store, workspace, await probeMedia(store.current.filePath));
    await state.reloadAssetsAndUsage();
    return state;
  }

  get media(): MediaInfo { return this.mediaInfo; }
  get playhead(): number { return this.playheadSeconds; }
  get selection(): Selection { return this.marks; }
  get assets(): readonly AgentAsset[] { return this.assetList; }
  get usage(): UsageSummary { return summarizeUsage(this.usageEntries); }
  get revision(): number { return this.revisionCounter; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setPlayhead(seconds: number): void {
    const next = Math.max(0, Math.min(this.mediaInfo.duration, Number.isFinite(seconds) ? seconds : 0));
    const changed = Math.round(next * 10) !== Math.round(this.playheadSeconds * 10);
    this.playheadSeconds = next;
    if (changed) this.bump();
  }

  setSelection(selection: Selection): void {
    if (selection.in === this.marks.in && selection.out === this.marks.out) return;
    this.marks = { in: selection.in, out: selection.out };
    this.bump();
  }

  /** Re-read everything that depends on the active version, then reset playhead and marks. */
  async afterVersionChange(): Promise<void> {
    this.mediaInfo = await probeMedia(this.store.current.filePath);
    this.playheadSeconds = 0;
    this.marks = { in: null, out: null };
    await this.store.pinVersion(this.store.current.id);
    await this.reloadAssetsAndUsage();
    this.bump();
  }

  async revertTo(reference: string): Promise<VersionEntry> {
    const version = await this.store.revert(reference);
    await this.afterVersionChange();
    return version;
  }

  async refreshAssets(): Promise<void> {
    await this.reloadAssetsAndUsage();
    this.bump();
  }

  async recordUsage(entry: Omit<UsageEntry, "id" | "at">): Promise<void> {
    this.usageEntries.push(await this.store.appendUsage(entry));
    this.notify();
  }

  describe(): EditorStateDescription {
    const version = this.store.current;
    const recent = this.store.history(6).map((item) => `${item.id} ${truncate(item.action, 60)}`).join(" · ");
    const mark = (value: number | null) => value === null ? "unset" : `${value.toFixed(1)}s`;
    const body = [
      `Active version: ${version.id}${version.parentId ? ` (parent ${version.parentId})` : " (original)"}`,
      `Video: ${this.mediaInfo.duration.toFixed(1)}s, ${this.mediaInfo.width}x${this.mediaInfo.height}, ${this.mediaInfo.fps}fps, audio ${this.mediaInfo.hasAudio ? "yes" : "no"}`,
      `Playhead: ${this.playheadSeconds.toFixed(1)}s (${formatTime(this.playheadSeconds)})`,
      `In mark: ${mark(this.marks.in)}`,
      `Out mark: ${mark(this.marks.out)}`,
      `Recent versions, newest first: ${recent}`,
      `Workspace assets: ${this.assetList.length}`,
    ].join("\n");
    return { revision: this.revisionCounter, body };
  }

  private async reloadAssetsAndUsage(): Promise<void> {
    const [assets, usage] = await Promise.all([this.workspace.assets(), this.store.usageEntries()]);
    this.assetList = assets;
    this.usageEntries = usage;
  }

  private bump(): void {
    this.revisionCounter += 1;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
```

Apply this change to `src/types.ts`:

```diff
--- a/src/types.ts
+++ b/src/types.ts
@@ -43,6 +43,8 @@
   updatedAt?: string;
   /** Number of rendered edit versions retained in addition to the source. */
   versionLimit?: number;
+  /** Versions the agent has seen; retention pruning never removes them (newest 20 kept). */
+  pinnedVersionIds?: string[];
   versions: VersionEntry[];
 }
 
```

Apply this change to `src/core/project.ts`:

```diff
--- a/src/core/project.ts
+++ b/src/core/project.ts
@@ -12,6 +12,7 @@
 const USAGE_FILE = "usage.jsonl";
 const PROJECT_REGISTRY_FILE = "projects.json";
 export const DEFAULT_VERSION_LIMIT = 5;
+export const MAX_PINNED_VERSIONS = 20;
 
 export interface ProjectSummary {
   name: string;
@@ -212,18 +213,37 @@
     return limit;
   }
 
-  async revert(reference: string): Promise<VersionEntry> {
+  /** Resolve "3", "v3", "v0003" or a unique id prefix to one retained version. */
+  resolveVersion(reference: string): VersionEntry {
     const normalized = reference.trim().toLowerCase();
     const numeric = /^\d+$/.test(normalized) ? `v${normalized.padStart(4, "0")}` : normalized;
     const matches = this.state.versions.filter((version) => version.id.toLowerCase().startsWith(numeric));
     if (matches.length !== 1) throw new Error(matches.length === 0 ? `Version ${reference} was not found` : `Version ${reference} is ambiguous`);
     const version = matches[0];
     if (!version) throw new Error(`Version ${reference} was not found`);
+    return version;
+  }
+
+  async revert(reference: string): Promise<VersionEntry> {
+    const version = this.resolveVersion(reference);
     this.state.currentVersionId = version.id;
     await this.save();
     return version;
   }
 
+  get pinnedVersionIds(): readonly string[] {
+    return this.state.pinnedVersionIds ?? [];
+  }
+
+  /** Protect a version the agent has seen from retention pruning. The newest MAX_PINNED_VERSIONS stay pinned. */
+  async pinVersion(id: string): Promise<void> {
+    if (!this.state.versions.some((version) => version.id === id)) return;
+    const pinned = (this.state.pinnedVersionIds ?? []).filter((item) => item !== id);
+    pinned.push(id);
+    this.state.pinnedVersionIds = pinned.slice(-MAX_PINNED_VERSIONS);
+    await this.save();
+  }
+
   history(limit = 8): VersionEntry[] {
     if (!Number.isFinite(limit)) return [...this.state.versions].reverse();
     const count = Math.max(0, Math.floor(limit));
@@ -306,6 +326,7 @@
 
     const keepIds = new Set<string>();
     if (this.state.currentVersionId !== original.id) keepIds.add(this.state.currentVersionId);
+    for (const id of this.state.pinnedVersionIds ?? []) if (id !== original.id) keepIds.add(id);
     for (let index = edits.length - 1; index >= 0 && keepIds.size < this.versionLimit; index -= 1) {
       const version = edits[index];
       if (version) keepIds.add(version.id);
```

Apply this change to `src/core/usage.ts`:

```diff
--- a/src/core/usage.ts
+++ b/src/core/usage.ts
@@ -1,6 +1,7 @@
 import { randomUUID } from "node:crypto";
 
-export type UsageKind = "luna" | "asset" | "harness";
+/** "luna" and "harness" appear only in ledgers written before the agent core rewrite. */
+export type UsageKind = "agent" | "luna" | "asset" | "harness";
 
 export interface UsageEntry {
   id: string;
@@ -33,7 +34,7 @@
 }
 
 export function summarizeUsage(entries: UsageEntry[]): UsageSummary {
-  const lunaUsd = entries.filter((entry) => entry.kind === "luna").reduce((sum, entry) => sum + entry.costUsd, 0);
+  const lunaUsd = entries.filter((entry) => entry.kind === "luna" || entry.kind === "agent").reduce((sum, entry) => sum + entry.costUsd, 0);
   const assetUsd = entries.filter((entry) => entry.kind === "asset").reduce((sum, entry) => sum + entry.costUsd, 0);
   const harnessUsd = entries.filter((entry) => entry.kind === "harness").reduce((sum, entry) => sum + entry.costUsd, 0);
   return { totalUsd: lunaUsd + assetUsd + harnessUsd, lunaUsd, assetUsd, harnessUsd, entries: entries.length };
@@ -52,7 +53,7 @@
   const entry = value as Partial<UsageEntry>;
   return typeof entry.id === "string"
     && typeof entry.at === "string"
-    && (entry.kind === "luna" || entry.kind === "asset" || entry.kind === "harness")
+    && (entry.kind === "agent" || entry.kind === "luna" || entry.kind === "asset" || entry.kind === "harness")
     && ["openai", "openrouter", "anthropic", "local"].includes(entry.provider ?? "")
     && typeof entry.model === "string"
     && typeof entry.label === "string"
```

Apply this change to `src/core/editor.ts`:

```diff
--- a/src/core/editor.ts
+++ b/src/core/editor.ts
@@ -10,6 +10,7 @@
   edit: DirectEdit,
   request: string,
   onStage?: (stage: string) => void,
+  signal?: AbortSignal,
 ): Promise<{ version: VersionEntry; media: MediaInfo }> {
   const input = store.current.filePath;
   const media = await probeMedia(input);
@@ -18,7 +19,7 @@
 
   try {
     onStage?.("Rendering with FFmpeg");
-    await runProcess("ffmpeg", args, { timeoutMs: 30 * 60_000, maxOutputBytes: 8_000_000 });
+    await runProcess("ffmpeg", args, { timeoutMs: 30 * 60_000, maxOutputBytes: 8_000_000, ...(signal ? { signal } : {}) });
     onStage?.("Checking rendered video");
     const outputMedia = await probeMedia(output);
     onStage?.("Saving new version");
```

Apply this change to `src/core/advanced-editor.ts`:

```diff
--- a/src/core/advanced-editor.ts
+++ b/src/core/advanced-editor.ts
@@ -67,6 +67,7 @@
   edit: AdvancedEdit,
   request: string,
   onStage?: (stage: string) => void,
+  signal?: AbortSignal,
 ): Promise<AdvancedEditResult> {
   const input = store.current.filePath;
   const media = await probeMedia(input);
@@ -83,6 +84,7 @@
       cwd: workspace,
       timeoutMs: 30 * 60_000,
       maxOutputBytes: 8_000_000,
+      ...(signal ? { signal } : {}),
     });
     onStage?.("Checking rendered video");
     const outputMedia = await probeMedia(output);
```

Apply this change to `package.json`:

```diff
--- a/package.json
+++ b/package.json
@@ -17,7 +17,7 @@
     "build": "tsup",
     "check": "tsc --noEmit",
     "dev": "tsx src/cli.tsx",
-    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/luna.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/transcription.test.js",
+    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/luna.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/transcription.test.js",
     "quality": "npm run check && npm test && npm run build",
     "release:check": "npm run quality && npm pack --dry-run",
     "prepublishOnly": "npm run quality"
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/editor-state.test.js .test-dist/tests/editor.test.js .test-dist/tests/projects.test.js
```

Expected: all pass (the existing `editor` and `projects` tests prove pruning and reverting still behave). Then the whole suite:

```bash
npm test
```

Expected: undefined tests, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src tests package.json
git commit -m "feat: add shared editor state, version pinning and abortable edits"
```

## Task 4: The action registry

**Files:**
- Create: `src/core/actions/types.ts`, `registry.ts`, `schema.ts`, `edit.ts`, `media.ts`, `versions.ts`, `workspace.ts`, `interaction.ts`, `index.ts`; `tests/helpers/actions.ts`, `tests/actions.test.ts`
- Modify: `src/core/agent-skills.ts`, `src/core/luna-agent.ts` (one-line shim, deleted in Task 7), `skills/*/SKILL.md`, `package.json` (`test` script)

**Interfaces:**
- Consumes: `EditorState` (Task 3), `executeDirectEdit`/`executeAdvancedEdit`/`executeCustomRender`, `transcribeVideoToSrt`, `generateAsset`, `runSandboxScript`, `ProjectStore` (existing).
- Produces (from `src/core/actions/index.ts`):
  - `createEditorRegistry(): ActionRegistry`; `ActionRegistry` with `register`, `get(name)`, `list()`, `riskOf(name, args): Risk`, `describe(name, args): string`, `run(name, args, ctx): Promise<ActionResult>` (after an action that returns `versionId`, `run` calls `ctx.state.afterVersionChange()`).
  - `directEditCall(edit: DirectEdit): { name: string; args: Record<string, unknown> }` maps a parsed slash command to its action.
  - Types `Action<Args>` (`name`, `description`, `schema`, `risk: Risk | ((args) => Risk)`, `audits?`, `describe?`, `run`), `ActionContext` (`state`, `settings`, `signal`, `request`, `progress`, `requestChoice`), `ActionResult` (`text`, `data?`, `images?`, `versionId?`), `Risk = "read" | "edit" | "spend" | "code"`.
  - `loadAgentSkills(): Promise<AgentSkill[]>` (`{ name, description, body }`), `skillIndex(skills)`, `parseSkill(name, source)` in `agent-skills.ts`.
- Produces (tests): `actionContext(state, signal?)` in `tests/helpers/actions.ts`.

- [ ] **Step 1: Write the tests**

Create `tests/helpers/actions.ts`:

```typescript
import type { ActionContext } from "../../src/core/actions/types.js";
import { DEFAULT_SETTINGS } from "../../src/core/settings.js";
import type { EditorState } from "../../src/core/state/editor-state.js";

export function actionContext(state: EditorState, signal: AbortSignal = new AbortController().signal): ActionContext {
  return {
    state, settings: structuredClone(DEFAULT_SETTINGS), signal, request: "test request",
    progress: () => undefined, requestChoice: async () => null,
  };
}
```

Create `tests/actions.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { createEditorRegistry, directEditCall } from "../src/core/actions/index.js";
import { parseEditCommand } from "../src/core/commands.js";
import { actionContext } from "./helpers/actions.js";
import { makeProject } from "./helpers/project.js";

const EXPECTED_ACTIONS = [
  "add_background_music", "add_fade", "add_image_overlay", "add_text_overlay", "apply_visual_effect", "burn_subtitles",
  "change_speed", "compare_frames", "crop_video", "generate_asset", "get_editor_state", "inspect_video_frames",
  "keep_range", "list_assets", "list_versions", "list_workspace_files", "mute_range", "present_choices",
  "read_skill", "read_workspace_file", "register_workspace_asset", "remove_ranges", "render_custom_ffmpeg", "revert_to",
  "run_sandbox_script", "sandbox_status", "search_music_catalog", "search_project_chat", "transcribe_and_add_subtitles",
  "transcribe_video_audio", "write_workspace_file",
];

test("registers every editor action exactly once, with strict schemas", () => {
  const registry = createEditorRegistry();
  assert.deepEqual(registry.list().map((action) => action.name).sort(), EXPECTED_ACTIONS);
  for (const action of registry.list()) {
    const schema = action.schema as { type: string; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    assert.equal(schema.type, "object", action.name);
    assert.equal(schema.additionalProperties, false, action.name);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${action.name} must require every property`);
  }
});

test("classifies risk: paid generation and custom code ask, read-only actions never do", () => {
  const registry = createEditorRegistry();
  assert.equal(registry.riskOf("generate_asset", {}), "spend");
  assert.equal(registry.riskOf("render_custom_ffmpeg", {}), "code");
  assert.equal(registry.riskOf("run_sandbox_script", {}), "code");
  assert.equal(registry.riskOf("remove_ranges", {}), "edit");
  assert.equal(registry.riskOf("inspect_video_frames", {}), "read");
  assert.equal(registry.riskOf("transcribe_video_audio", {}), "read");
  assert.equal(registry.riskOf("transcribe_video_audio", { model: "gpt-4o-transcribe-diarize" }), "spend");
  assert.equal(registry.riskOf("transcribe_and_add_subtitles", { provider_options_json: "{\"a\":1}" }), "spend");
});

test("slash commands and agent tools call the same action with the same arguments", () => {
  const context = { duration: 4, currentTime: 0, selection: { in: null, out: null } };
  const parsed = (line: string) => {
    const edit = parseEditCommand(line, context);
    assert.ok(edit);
    return directEditCall(edit);
  };
  assert.deepEqual(parsed("/clip-remove 1 2"), { name: "remove_ranges", args: { ranges: [{ start: 1, end: 2 }] } });
  assert.deepEqual(parsed("/clip-keep 0.5 2.5"), { name: "keep_range", args: { start: 0.5, end: 2.5 } });
  assert.deepEqual(parsed("/speed 1 2 2x"), { name: "change_speed", args: { start: 1, end: 2, factor: 2 } });
  assert.deepEqual(parsed("/mute 1 2"), { name: "mute_range", args: { start: 1, end: 2 } });
  assert.deepEqual(parsed("/crop 160x90"), { name: "crop_video", args: { width: 160, height: 90, x: null, y: null } });
  const registry = createEditorRegistry();
  for (const line of ["/clip-remove 1 2", "/clip-keep 0.5 2.5", "/speed 1 2 2x", "/mute 1 2", "/crop 160x90"]) {
    const { name } = parsed(line);
    assert.ok(registry.get(name), `${name} must be a registered action`);
  }
});

test("an edit action commits a version, pins it, resets the playhead and updates the state description", { timeout: 90_000 }, async () => {
  const project = await makeProject();
  try {
    const registry = createEditorRegistry();
    project.state.setPlayhead(2.5);
    project.state.setSelection({ in: 1, out: 2 });
    const before = project.state.revision;
    const result = await registry.run("remove_ranges", { ranges: [{ start: 3, end: 4 }] }, actionContext(project.state));
    assert.equal(result.versionId, "v0001");
    assert.ok(project.state.media.duration > 2.8 && project.state.media.duration < 3.2);
    assert.ok(project.state.revision > before);
    assert.equal(project.state.playhead, 0);
    assert.deepEqual(project.state.selection, { in: null, out: null });
    assert.deepEqual([...project.store.pinnedVersionIds], ["v0001"]);
    const described = project.state.describe().body;
    assert.match(described, /Active version: v0001 \(parent v0000\)/);
    assert.match(described, /Playhead: 0\.0s/);
  } finally {
    await project.cleanup();
  }
});

test("get_editor_state reports the playhead and marks the user set", { timeout: 60_000 }, async () => {
  const project = await makeProject();
  try {
    project.state.setPlayhead(1.5);
    project.state.setSelection({ in: 1, out: null });
    const result = await createEditorRegistry().run("get_editor_state", {}, actionContext(project.state));
    assert.match(result.text, /Playhead: 1\.5s/);
    assert.match(result.text, /In mark: 1\.0s/);
    assert.match(result.text, /Out mark: unset/);
  } finally {
    await project.cleanup();
  }
});

test("revert_to and list_versions share the version store with the slash commands", { timeout: 90_000 }, async () => {
  const project = await makeProject();
  try {
    const registry = createEditorRegistry();
    const context = actionContext(project.state);
    await registry.run("keep_range", { start: 0, end: 2 }, context);
    const reverted = await registry.run("revert_to", { version: "0" }, context);
    assert.equal(reverted.versionId, "v0000");
    assert.equal(project.store.current.id, "v0000");
    const listed = await registry.run("list_versions", {}, context);
    const rows = (listed.data as { versions: Array<{ id: string; active: boolean }> }).versions;
    assert.deepEqual(rows.map((row) => [row.id, row.active]), [["v0000", true], ["v0001", false]]);
    await assert.rejects(registry.run("revert_to", { version: "v9999" }, context), /not found/);
  } finally {
    await project.cleanup();
  }
});

test("an aborted action commits nothing", { timeout: 60_000 }, async () => {
  const project = await makeProject();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createEditorRegistry().run("remove_ranges", { ranges: [{ start: 1, end: 2 }] }, actionContext(project.state, controller.signal)));
    assert.equal(project.store.snapshot.versions.length, 1);
    assert.equal(project.store.current.id, "v0000");
  } finally {
    await project.cleanup();
  }
});

test("inspect_video_frames returns images and counts as an audit; compare_frames pairs two versions", { timeout: 90_000 }, async () => {
  const project = await makeProject();
  try {
    const registry = createEditorRegistry();
    const context = actionContext(project.state);
    const inspected = await registry.run("inspect_video_frames", { timestamps: [0.5, 1.5], detail: "low" }, context);
    assert.equal(inspected.images?.length, 2);
    assert.equal(inspected.images?.[0]?.mimeType, "image/jpeg");
    assert.equal(registry.get("inspect_video_frames")?.audits, true);
    await registry.run("keep_range", { start: 0, end: 2 }, context);
    const compared = await registry.run("compare_frames", { version_a: "v0000", version_b: "v0001", timestamps: [0.5] }, context);
    assert.equal(compared.images?.length, 1);
    assert.match(compared.text, /v0000 \(left\) vs v0001 \(right\)/);
  } finally {
    await project.cleanup();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL with `Cannot find module '../src/core/actions/index.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/core/actions/types.ts`:

```typescript
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
```

Create `src/core/actions/registry.ts`:

```typescript
import type { Action, ActionContext, ActionResult, Risk } from "./types.js";

/** Everything the editor can do. Slash commands and agent tools both run actions from here. */
export class ActionRegistry {
  private readonly actions = new Map<string, Action<any>>();

  register<Args>(action: Action<Args>): this {
    if (this.actions.has(action.name)) throw new Error(`Action ${action.name} is already registered.`);
    this.actions.set(action.name, action as Action<any>);
    return this;
  }

  get(name: string): Action<any> | undefined {
    return this.actions.get(name);
  }

  list(): Action<any>[] {
    return [...this.actions.values()];
  }

  riskOf(name: string, args: unknown): Risk {
    const action = this.require(name);
    return typeof action.risk === "function" ? action.risk(args) : action.risk;
  }

  describe(name: string, args: unknown): string {
    const action = this.require(name);
    if (action.describe) return action.describe(args);
    const encoded = JSON.stringify(args) ?? "";
    return `${name} ${encoded.length > 100 ? `${encoded.slice(0, 97)}...` : encoded}`;
  }

  /** Run an action, then bring the editor state up to date when it changed the active version. */
  async run(name: string, args: unknown, ctx: ActionContext): Promise<ActionResult> {
    const action = this.require(name);
    const result = await action.run(args, ctx);
    if (result.versionId) await ctx.state.afterVersionChange();
    return result;
  }

  private require(name: string): Action<any> {
    const action = this.actions.get(name);
    if (!action) throw new Error(`Unknown action: ${name}`);
    return action;
  }
}
```

Create `src/core/actions/schema.ts`:

```typescript
// Schema builders and argument readers shared by action definitions. Every action schema lists all of
// its properties as required and forbids extra properties; optional values are nullable instead.

export function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
export function rangeSchema() { return objectSchema({ start: numberSchema(0), end: numberSchema(0) }); }
export function numberSchema(minimum: number) { return { type: "number", minimum }; }
export function nullableInteger(minimum: number) { return { type: ["integer", "null"], minimum }; }
export function stringSchema(minLength: number, maxLength: number) { return { type: "string", minLength, maxLength }; }

export function range(args: Record<string, unknown>) { return { start: number(args.start, "start"), end: number(args.end, "end") }; }
export function ranges(value: unknown) {
  if (!Array.isArray(value)) throw new Error("ranges must be an array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each range must be an object");
    return range(item as Record<string, unknown>);
  });
}
export function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}
export function integer(value: unknown, label: string): number {
  const result = number(value, label);
  if (!Number.isInteger(result)) throw new Error(`${label} must be a whole number`);
  return result;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  return value;
}

export function jsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`${label} must contain valid JSON.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must contain a JSON object.`);
  return parsed as Record<string, unknown>;
}

export function optionalOverride(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  if (!result || ["null", "undefined", "default", "none"].includes(result.toLowerCase())) return undefined;
  return result;
}

export function optionalJsonObject(value: unknown, label: string): Record<string, unknown> | undefined {
  const text = optionalOverride(value);
  if (!text) return undefined;
  const parsed = jsonObject(text, label);
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}
```

The edit actions are the old `agent-runtime.ts` tools for cutting, text, subtitles, overlays, effects, fades, music and custom FFmpeg, now running through `ctx`:

Create `src/core/actions/edit.ts`:

```typescript
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DirectEdit, MediaInfo } from "../../types.js";
import { executeAdvancedEdit, type AdvancedEdit, type TextPosition, type VisualEffect } from "../advanced-editor.js";
import type { AgentWorkspace } from "../agent-workspace.js";
import { executeCustomRender } from "../custom-render.js";
import { executeDirectEdit } from "../editor.js";
import { findMusicTrack } from "../music-catalog.js";
import { selectedMusicTrack } from "../music.js";
import { formatTime } from "../time.js";
import { integer, nullableInteger, number, numberSchema, objectSchema, range, rangeSchema, ranges, string, stringSchema } from "./schema.js";
import type { Action, ActionContext, ActionResult } from "./types.js";

type Args = Record<string, unknown>;

function editResult(result: { version: { id: string; action: string }; media: MediaInfo }): ActionResult {
  return {
    text: `${result.version.id}: ${result.version.action}`,
    data: { versionId: result.version.id, action: result.version.action, media: result.media },
    versionId: result.version.id,
  };
}

function direct(
  name: string,
  description: string,
  schema: Record<string, unknown>,
  make: (args: Args) => DirectEdit,
  describe: (args: Args) => string,
): Action<Args> {
  return {
    name, description, schema, risk: "edit", describe,
    run: async (args, ctx) => editResult(await executeDirectEdit(
      ctx.state.store, make(args), ctx.request, (stage) => ctx.progress({ stage }), ctx.signal,
    )),
  };
}

function advanced(
  name: string,
  description: string,
  schema: Record<string, unknown>,
  make: (args: Args, ctx: ActionContext) => Promise<AdvancedEdit> | AdvancedEdit,
  describe: (args: Args) => string,
): Action<Args> {
  return {
    name, description, schema, risk: "edit", describe,
    run: async (args, ctx) => editResult(await executeAdvancedEdit(
      ctx.state.store, await make(args, ctx), ctx.request, (stage) => ctx.progress({ stage }), ctx.signal,
    )),
  };
}

const span = (args: Args) => `${formatTime(number(args.start, "start"))}–${formatTime(number(args.end, "end"))}`;

/** Map a parsed slash command to the action that performs it, so commands and the agent share one path. */
export function directEditCall(edit: DirectEdit): { name: string; args: Args } {
  if (edit.action === "remove") return { name: "remove_ranges", args: { ranges: edit.ranges } };
  if (edit.action === "trim") return { name: "keep_range", args: { start: edit.range.start, end: edit.range.end } };
  if (edit.action === "speed") return { name: "change_speed", args: { start: edit.range.start, end: edit.range.end, factor: edit.factor } };
  if (edit.action === "mute") return { name: "mute_range", args: { start: edit.range.start, end: edit.range.end } };
  return { name: "crop_video", args: { width: edit.width, height: edit.height, x: edit.x ?? null, y: edit.y ?? null } };
}

export function createEditActions(): Action<any>[] {
  return [
    direct("remove_ranges", "Remove one or more time ranges from the active video.", objectSchema({
      ranges: { type: "array", minItems: 1, maxItems: 20, items: rangeSchema() },
    }), (args) => ({ action: "remove", ranges: ranges(args.ranges) }),
    (args) => `Remove ${ranges(args.ranges).map((item) => `${formatTime(item.start)}–${formatTime(item.end)}`).join(", ")}`),

    direct("keep_range", "Keep only one time range and discard everything outside it.", objectSchema({
      start: numberSchema(0), end: numberSchema(0),
    }), (args) => ({ action: "trim", range: range(args) }), (args) => `Keep ${span(args)}`),

    direct("change_speed", "Change playback speed inside one time range.", objectSchema({
      start: numberSchema(0), end: numberSchema(0), factor: { type: "number", minimum: 0.25, maximum: 16 },
    }), (args) => ({ action: "speed", range: range(args), factor: number(args.factor, "factor") }),
    (args) => `Speed ${span(args)} to ${String(args.factor)}x`),

    direct("mute_range", "Mute the source audio inside one time range.", objectSchema({
      start: numberSchema(0), end: numberSchema(0),
    }), (args) => ({ action: "mute", range: range(args) }), (args) => `Mute ${span(args)}`),

    direct("crop_video", "Crop the whole video. Use null x/y to center the crop.", objectSchema({
      width: { type: "integer", minimum: 2 }, height: { type: "integer", minimum: 2 },
      x: nullableInteger(0), y: nullableInteger(0),
    }), (args) => ({
      action: "crop", width: integer(args.width, "width"), height: integer(args.height, "height"),
      ...(args.x === null ? {} : { x: integer(args.x, "x") }), ...(args.y === null ? {} : { y: integer(args.y, "y") }),
    }), (args) => `Crop to ${String(args.width)}x${String(args.height)}`),

    advanced("add_text_overlay", "Add styled text over a time range.", objectSchema({
      text: stringSchema(1, 20_000), start: numberSchema(0), end: numberSchema(0),
      position: { type: "string", enum: ["top-left", "top-center", "top-right", "center", "bottom-left", "bottom-center", "bottom-right"] },
      font_size: { type: "integer", minimum: 6, maximum: 500 }, color: stringSchema(1, 32),
    }), (args) => ({
      action: "text", text: string(args.text, "text"), range: range(args), position: args.position as TextPosition,
      fontSize: integer(args.font_size, "font_size"), color: string(args.color, "color"),
    }), (args) => `Text “${String(args.text).slice(0, 40)}” ${span(args)}`),

    advanced("burn_subtitles", "Burn an SRT, VTT, ASS, or SSA file from the agent workspace into the video.", objectSchema({
      workspace_path: stringSchema(1, 240),
    }), async (args, ctx) => ({ action: "subtitles", filePath: await workspacePath(ctx.state.workspace, string(args.workspace_path, "workspace_path")) }),
    (args) => `Burn subtitles from ${String(args.workspace_path)}`),

    advanced("add_image_overlay", "Overlay a generated image asset over a time range.", objectSchema({
      asset_id: stringSchema(1, 100), start: numberSchema(0), end: numberSchema(0),
      x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 },
      width: nullableInteger(1), height: nullableInteger(1), opacity: { type: "number", minimum: 0, maximum: 1 },
    }), async (args, ctx) => {
      const asset = await ctx.state.workspace.asset(string(args.asset_id, "asset_id"));
      if (asset.kind !== "image") throw new Error("The selected asset is not an image.");
      return {
        action: "image-overlay", filePath: asset.path, range: range(args), x: integer(args.x, "x"), y: integer(args.y, "y"),
        ...(args.width === null ? {} : { width: integer(args.width, "width") }),
        ...(args.height === null ? {} : { height: integer(args.height, "height") }), opacity: number(args.opacity, "opacity"),
      };
    }, (args) => `Image ${String(args.asset_id)} ${span(args)}`),

    advanced("apply_visual_effect", "Apply grayscale, sepia, blur, sharpen, or vignette over a time range.", objectSchema({
      effect: { type: "string", enum: ["grayscale", "sepia", "blur", "sharpen", "vignette"] },
      start: numberSchema(0), end: numberSchema(0), intensity: { type: "number", minimum: 0, maximum: 1 },
    }), (args) => ({
      action: "effect", effect: args.effect as VisualEffect, range: range(args), intensity: number(args.intensity, "intensity"),
    }), (args) => `${String(args.effect)} ${span(args)}`),

    advanced("add_fade", "Add a video fade and optional matching audio fade.", objectSchema({
      direction: { type: "string", enum: ["in", "out"] }, start: numberSchema(0), end: numberSchema(0),
      color: stringSchema(1, 32), audio: { type: "boolean" },
    }), (args) => ({
      action: "fade", direction: args.direction as "in" | "out", range: range(args), color: string(args.color, "color"), audio: Boolean(args.audio),
    }), (args) => `Fade ${String(args.direction)} ${span(args)}`),

    advanced("add_background_music", "Mix a selected catalog track or generated music/audio asset under the video.", objectSchema({
      source: { type: "string", enum: ["selected", "catalog", "asset"] }, reference: { type: ["string", "null"], maxLength: 100 },
      volume: { type: "number", minimum: 0, maximum: 2 }, loop: { type: "boolean" }, start_at: numberSchema(0),
    }), async (args, ctx) => ({
      action: "background-music", filePath: await musicPath(ctx.state.workspace, string(args.source, "source"), args.reference),
      volume: number(args.volume, "volume"), loop: Boolean(args.loop), startAt: number(args.start_at, "start_at"),
    }), (args) => `Background music (${String(args.source)})`),

    {
      name: "render_custom_ffmpeg",
      description: "Build a custom FFmpeg filter graph when no specialized edit tool fits. Input 0 is the active video; inputs 1 onward are asset_ids in the given order. Produce a labeled video output such as [vout], and optionally an audio output such as [aout] or map 0:a:0?. This is the general composition layer for overlays, animation, transitions, color work, audio processing, and combinations of effects.",
      schema: objectSchema({
        filter_graph: stringSchema(1, 20_000),
        asset_ids: { type: "array", maxItems: 12, items: stringSchema(1, 100) },
        video_map: stringSchema(1, 100),
        audio_map: { type: ["string", "null"], maxLength: 100 },
        summary: stringSchema(1, 160),
      }),
      risk: "code",
      describe: (args: Args) => `Custom FFmpeg: ${String(args.summary)}`,
      run: async (args: Args, ctx: ActionContext) => {
        if (!Array.isArray(args.asset_ids) || !args.asset_ids.every((id) => typeof id === "string")) throw new Error("asset_ids must be an array of asset IDs.");
        return editResult(await executeCustomRender({
          store: ctx.state.store,
          workspace: ctx.state.workspace,
          filterGraph: string(args.filter_graph, "filter_graph"),
          assetIds: args.asset_ids,
          videoMap: string(args.video_map, "video_map"),
          audioMap: args.audio_map === null ? null : string(args.audio_map, "audio_map"),
          summary: string(args.summary, "summary"),
          request: ctx.request,
          signal: ctx.signal,
          onStage: (stage) => ctx.progress({ stage }),
        }));
      },
    },
  ];
}

async function workspacePath(workspace: AgentWorkspace, requested: string): Promise<string> {
  await workspace.readText(requested);
  return join(workspace.filesDirectory, ...requested.split("/"));
}

async function musicPath(workspace: AgentWorkspace, source: string, reference: unknown): Promise<string> {
  if (source === "asset") {
    if (typeof reference !== "string") throw new Error("An asset reference is required.");
    const asset = await workspace.asset(reference);
    if (asset.kind !== "music" && asset.kind !== "audio") throw new Error("The selected asset is not audio or music.");
    return asset.path;
  }
  const track = source === "selected" ? await selectedMusicTrack() : typeof reference === "string" ? findMusicTrack(reference) : null;
  if (!track) throw new Error(source === "selected" ? "No background track is selected. Use /bg-music first." : "Catalog track was not found.");
  const path = workspace.assetPath("music", ".mp3");
  const response = await fetch(track.assetUrl);
  if (!response.ok) throw new Error(`Could not download ${track.title}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 100_000_000) throw new Error("Catalog music download was empty or too large.");
  await writeFile(path, bytes);
  await workspace.registerAsset({
    kind: "music", path, source: "catalog", description: track.title,
    license: `${track.license.attribution} License: ${track.license.url} Modified: mixed into the edited video's soundtrack.`,
    sourceUrl: track.sourceUrl, costUsd: 0, costEstimated: false,
  });
  return path;
}
```

Create `src/core/actions/media.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { AssetGenerationError, generateAsset } from "../asset-generation.js";
import type { AgentAsset } from "../agent-workspace.js";
import { executeAdvancedEdit } from "../advanced-editor.js";
import { extractRawFrame } from "../media.js";
import { searchMusicTracks, type MusicTrack } from "../music-catalog.js";
import { runProcess } from "../process.js";
import { transcribeVideoToSrt, type TranscriptionResult } from "../transcription.js";
import { number, numberSchema, objectSchema, optionalJsonObject, optionalOverride, string, stringSchema } from "./schema.js";
import type { Action, ActionContext, ActionResult } from "./types.js";

type Args = Record<string, unknown>;

const transcriptionSchema = () => objectSchema({
  language: { type: ["string", "null"], maxLength: 40 },
  context: { type: ["string", "null"], maxLength: 1000 },
  model: { type: ["string", "null"], maxLength: 200 },
  provider_options_json: { type: ["string", "null"], maxLength: 10_000 },
});

export function createMediaActions(): Action<any>[] {
  const overridesModel = (args: Args) => Boolean(optionalOverride(args.model) || optionalOverride(args.provider_options_json));
  return [
    {
      name: "transcribe_and_add_subtitles",
      description: "Automatically transcribe the active video's speech, create a timed SRT, and burn the subtitles into a new video version. Use this whenever the user asks to add, generate, or create subtitles and has not supplied a subtitle file.",
      schema: transcriptionSchema(),
      risk: (args: Args) => overridesModel(args) ? "spend" : "edit",
      describe: () => "Transcribe speech and burn subtitles",
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        const transcription = await transcribe(ctx, args);
        const subtitleAsset = await registerTranscription(ctx, transcription);
        const edited = await executeAdvancedEdit(
          ctx.state.store, { action: "subtitles", filePath: transcription.path }, ctx.request,
          (stage) => ctx.progress({ stage }), ctx.signal,
        );
        return {
          text: `${edited.version.id}: ${edited.version.action}`,
          versionId: edited.version.id,
          data: {
            versionId: edited.version.id,
            subtitlePath: transcription.path,
            cueCount: transcription.cueCount,
            model: transcription.model,
            assetId: subtitleAsset.id,
            costUsd: transcription.costUsd,
            ...(transcription.language ? { language: transcription.language } : {}),
          },
        };
      },
    },
    {
      name: "transcribe_video_audio",
      description: "Transcribe the active video's speech into a transcript and timed SRT without changing the video. Use this to understand, summarize, or inspect spoken content.",
      schema: transcriptionSchema(),
      risk: (args: Args) => overridesModel(args) ? "spend" : "read",
      describe: () => "Transcribe speech",
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        const result = await transcribe(ctx, args);
        const asset = await registerTranscription(ctx, result);
        return { text: `Transcribed ${result.cueCount} subtitle cues.`, data: { ...result, assetId: asset.id } as unknown as Record<string, unknown> };
      },
    },
    {
      name: "generate_asset",
      description: "Generate an image, speech audio, music clip, or video asset. Normally use the configured default. You may request another provider/model and endpoint parameters when the task needs them. Generation costs money, so the user may be asked to approve it.",
      schema: objectSchema({
        kind: { type: "string", enum: ["image", "audio", "music", "video"] }, prompt: stringSchema(1, 8000),
        duration: { type: ["number", "null"], minimum: 1, maximum: 15 }, voice: { type: ["string", "null"], maxLength: 80 },
        provider: { type: ["string", "null"], enum: ["openai", "openrouter", null] },
        model: { type: ["string", "null"], maxLength: 200 },
        provider_options_json: { type: ["string", "null"], maxLength: 10_000 },
      }),
      risk: "spend",
      describe: (args: Args) => `Generate ${String(args.kind)}: ${String(args.prompt).slice(0, 60)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        const kind = args.kind as "image" | "audio" | "music" | "video";
        const provider = args.provider === "openai" || args.provider === "openrouter" ? args.provider : undefined;
        const model = optionalOverride(args.model);
        const voice = optionalOverride(args.voice);
        const providerOptions = optionalJsonObject(args.provider_options_json, "provider_options_json");
        const prompt = string(args.prompt, "prompt");
        let asset: AgentAsset;
        try {
          asset = await generateAsset(kind, {
            prompt, workspace: ctx.state.workspace, signal: ctx.signal,
            ...(typeof args.duration === "number" ? { duration: args.duration } : {}),
            ...(voice ? { voice } : {}),
            ...(provider ? { provider } : {}),
            ...(model ? { model } : {}),
            ...(providerOptions ? { providerOptions } : {}),
            onStage: (stage) => ctx.progress({ stage }),
          });
        } catch (error) {
          if (error instanceof AssetGenerationError && error.costUsd !== undefined) {
            await ctx.state.recordUsage({
              kind: "asset", provider: error.provider, model: error.model,
              label: `Failed ${kind}: ${prompt}`.slice(0, 160), costUsd: error.costUsd, estimated: false,
            });
          }
          throw error;
        }
        await recordAssetUsage(ctx, asset);
        await ctx.state.refreshAssets();
        return { text: `Created ${asset.id}`, data: asset as unknown as Record<string, unknown> };
      },
    },
    {
      name: "inspect_video_frames",
      description: "Extract up to eight frames from the active version and show them to the model for visual inspection.",
      schema: objectSchema({ timestamps: { type: "array", minItems: 1, maxItems: 8, items: numberSchema(0) }, detail: { type: "string", enum: ["low", "high"] } }),
      risk: "read",
      audits: true,
      describe: (args: Args) => `Inspect ${Array.isArray(args.timestamps) ? args.timestamps.length : 0} frame(s)`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        if (!Array.isArray(args.timestamps)) throw new Error("timestamps must be an array");
        const timestamps = args.timestamps.map((item) => number(item, "timestamp"));
        return extractFrames(ctx, ctx.state.store.current.filePath, timestamps, args.detail === "high" ? 1280 : 640);
      },
    },
    {
      name: "search_music_catalog",
      description: "Search the built-in CC BY music catalog and return license and attribution details.",
      schema: objectSchema({ query: stringSchema(0, 200) }),
      risk: "read",
      describe: (args: Args) => `Search music: ${String(args.query)}`,
      run: async (args: Args): Promise<ActionResult> => ({
        text: "Music catalog results",
        data: { tracks: searchMusicTracks(string(args.query, "query")).map(trackData) },
      }),
    },
    {
      name: "list_assets",
      description: "List assets already available in this project's agent workspace.",
      schema: objectSchema({}),
      risk: "read",
      describe: () => "List workspace assets",
      run: async (_args: Args, ctx: ActionContext): Promise<ActionResult> => ({
        text: "Workspace assets", data: { assets: await ctx.state.workspace.assets() },
      }),
    },
    {
      name: "register_workspace_asset",
      description: "Register an image, video, audio, music, or other file created by a sandbox script so other editing tools can use it by asset ID.",
      schema: objectSchema({
        kind: { type: "string", enum: ["image", "video", "audio", "music", "file"] },
        workspace_path: stringSchema(1, 240),
        description: stringSchema(1, 500),
      }),
      risk: "edit",
      describe: (args: Args) => `Register ${String(args.workspace_path)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        const asset = await ctx.state.workspace.registerWorkspaceFile(
          args.kind as "image" | "video" | "audio" | "music" | "file",
          string(args.workspace_path, "workspace_path"),
          string(args.description, "description"),
        );
        await ctx.state.refreshAssets();
        return { text: `Registered ${asset.id}.`, data: asset as unknown as Record<string, unknown> };
      },
    },
  ];
}

/** Extract frames from one video file as JPEGs for the model, with a numeric colour cross-check per frame. */
export async function extractFrames(ctx: ActionContext, filePath: string, timestamps: number[], width: number, label = ""): Promise<ActionResult> {
  const lines: string[] = [];
  const images: NonNullable<ActionResult["images"]> = [];
  for (const timestamp of timestamps) {
    const sample = await extractRawFrame(filePath, timestamp, { width: 32, height: 18 }, ctx.signal);
    const average = averageRgb(sample);
    const path = ctx.state.workspace.assetPath("image", ".jpg");
    await runProcess("ffmpeg", ["-y", "-v", "error", "-ss", timestamp.toFixed(3), "-i", filePath, "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, "-q:v", "3", path],
      { timeoutMs: 30_000, maxOutputBytes: 1_000_000, signal: ctx.signal });
    images.push({ mimeType: "image/jpeg", data: (await readFile(path)).toString("base64") });
    lines.push(`Image ${images.length}: ${label}frame at ${timestamp.toFixed(3)} seconds. Whole-frame average RGB: ${average.red}, ${average.green}, ${average.blue}. Use this numeric measurement as a cross-check, while relying on the image for objects, layout, and local colors.`);
  }
  return { text: `Extracted ${images.length} frame(s). Images follow in this order.\n${lines.join("\n")}`, images, data: { timestamps } };
}

function averageRgb(buffer: Buffer): { red: number; green: number; blue: number } {
  if (buffer.length < 3) return { red: 0, green: 0, blue: 0 };
  let red = 0;
  let green = 0;
  let blue = 0;
  let pixels = 0;
  for (let offset = 0; offset + 2 < buffer.length; offset += 3) {
    red += buffer[offset] ?? 0;
    green += buffer[offset + 1] ?? 0;
    blue += buffer[offset + 2] ?? 0;
    pixels += 1;
  }
  return { red: Math.round(red / pixels), green: Math.round(green / pixels), blue: Math.round(blue / pixels) };
}

async function transcribe(ctx: ActionContext, args: Args): Promise<TranscriptionResult> {
  const model = optionalOverride(args.model);
  const providerOptions = optionalJsonObject(args.provider_options_json, "provider_options_json");
  return transcribeVideoToSrt({
    filePath: ctx.state.store.current.filePath,
    workspace: ctx.state.workspace,
    signal: ctx.signal,
    onStage: (stage) => ctx.progress({ stage }),
    ...(typeof args.language === "string" ? { language: args.language } : {}),
    ...(typeof args.context === "string" ? { context: args.context } : {}),
    ...(model ? { model } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  });
}

async function registerTranscription(ctx: ActionContext, transcription: TranscriptionResult): Promise<AgentAsset> {
  const asset = await ctx.state.workspace.registerAsset({
    kind: "file",
    path: transcription.path,
    source: "generated",
    description: `Subtitles (${transcription.cueCount} cues)`,
    model: transcription.model,
    costUsd: transcription.costUsd,
    costEstimated: transcription.costEstimated,
  });
  await recordAssetUsage(ctx, asset);
  await ctx.state.refreshAssets();
  return asset;
}

async function recordAssetUsage(ctx: ActionContext, asset: AgentAsset): Promise<void> {
  if (asset.costUsd === undefined) return;
  await ctx.state.recordUsage({
    kind: "asset",
    provider: asset.source === "catalog" || asset.source === "agent" ? "local" : asset.model?.includes("/") ? "openrouter" : "openai",
    model: asset.model ?? asset.source,
    label: asset.description.slice(0, 160),
    costUsd: asset.costUsd,
    estimated: asset.costEstimated ?? false,
    assetId: asset.id,
  });
}

function trackData(track: MusicTrack) {
  return {
    id: track.id, title: track.title, artist: track.artist, description: track.description, genres: track.genres, moods: track.moods,
    durationSeconds: track.durationSeconds, license: track.license, sourceUrl: track.sourceUrl,
  };
}
```

Create `src/core/actions/versions.ts`:

```typescript
import { readFile, rm, writeFile } from "node:fs/promises";
import { runProcess } from "../process.js";
import { numberSchema, objectSchema, number, string, stringSchema } from "./schema.js";
import { extractFrames } from "./media.js";
import type { Action, ActionContext, ActionResult } from "./types.js";

type Args = Record<string, unknown>;

export function createVersionActions(): Action<any>[] {
  return [
    {
      name: "get_editor_state",
      description: "Return the current playhead, in/out marks, active version, video details and recent versions. Call this when the user refers to \"here\", \"this part\", or the current selection.",
      schema: objectSchema({}),
      risk: "read",
      describe: () => "Read editor state",
      run: async (_args: Args, ctx: ActionContext): Promise<ActionResult> => ({ text: ctx.state.describe().body }),
    },
    {
      name: "list_versions",
      description: "List the retained versions of this project as a tree: id, parent, what the version did, and which one is active.",
      schema: objectSchema({}),
      risk: "read",
      describe: () => "List versions",
      run: async (_args: Args, ctx: ActionContext): Promise<ActionResult> => {
        const { versions, currentVersionId } = ctx.state.store.snapshot;
        const rows = versions.map((version) => ({
          id: version.id, parentId: version.parentId, action: version.action, duration: version.duration,
          active: version.id === currentVersionId, createdAt: version.createdAt,
        }));
        return { text: `${rows.length} retained version(s); active is ${currentVersionId}.`, data: { versions: rows } };
      },
    },
    {
      name: "revert_to",
      description: "Make an earlier retained version the active one. A later edit then branches from it, so nothing is lost. Accepts \"3\", \"v3\" or \"v0003\".",
      schema: objectSchema({ version: stringSchema(1, 20) }),
      risk: "edit",
      describe: (args: Args) => `Revert to ${String(args.version)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        const version = await ctx.state.revertTo(string(args.version, "version"));
        return { text: `Now on ${version.id}: ${version.action}`, versionId: version.id, data: { versionId: version.id, action: version.action } };
      },
    },
    {
      name: "compare_frames",
      description: "Show frames from two retained versions side by side (version A on the left, B on the right) at the same timestamps, to check what an edit changed.",
      schema: objectSchema({
        version_a: stringSchema(1, 20), version_b: stringSchema(1, 20),
        timestamps: { type: "array", minItems: 1, maxItems: 4, items: numberSchema(0) },
      }),
      risk: "read",
      describe: (args: Args) => `Compare ${String(args.version_a)} and ${String(args.version_b)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        if (!Array.isArray(args.timestamps)) throw new Error("timestamps must be an array");
        const store = ctx.state.store;
        const a = store.resolveVersion(string(args.version_a, "version_a"));
        const b = store.resolveVersion(string(args.version_b, "version_b"));
        const timestamps = args.timestamps.map((item) => number(item, "timestamp"));
        const left = await extractFrames(ctx, a.filePath, timestamps, 640, `${a.id} `);
        const right = await extractFrames(ctx, b.filePath, timestamps, 640, `${b.id} `);
        const images: NonNullable<ActionResult["images"]> = [];
        for (let index = 0; index < timestamps.length; index += 1) {
          const pair = await sideBySide(ctx, left.images?.[index]?.data, right.images?.[index]?.data);
          images.push({ mimeType: "image/jpeg", data: pair });
        }
        const lines = timestamps.map((timestamp, index) => `Image ${index + 1}: ${a.id} (left) vs ${b.id} (right) at ${timestamp.toFixed(3)} seconds.`);
        return { text: `Compared ${timestamps.length} timestamp(s). Images follow in this order.\n${lines.join("\n")}`, images };
      },
    },
  ];
}

async function sideBySide(ctx: ActionContext, left: string | undefined, right: string | undefined): Promise<string> {
  if (!left || !right) throw new Error("Could not extract a frame to compare.");
  const leftPath = ctx.state.workspace.assetPath("image", ".jpg");
  const rightPath = ctx.state.workspace.assetPath("image", ".jpg");
  const outputPath = ctx.state.workspace.assetPath("image", ".jpg");
  try {
    await writeFile(leftPath, Buffer.from(left, "base64"));
    await writeFile(rightPath, Buffer.from(right, "base64"));
    await runProcess("ffmpeg", ["-y", "-v", "error", "-i", leftPath, "-i", rightPath, "-filter_complex", "[0:v]scale=-2:360[l];[1:v]scale=-2:360[r];[l][r]hstack=inputs=2", "-frames:v", "1", "-q:v", "3", outputPath],
      { timeoutMs: 30_000, maxOutputBytes: 1_000_000, signal: ctx.signal });
    return (await readFile(outputPath)).toString("base64");
  } finally {
    await Promise.all([leftPath, rightPath, outputPath].map((path) => rm(path, { force: true }).catch(() => undefined)));
  }
}
```

Create `src/core/actions/workspace.ts`:

```typescript
import { loadAgentSkills } from "../agent-skills.js";
import { localSandboxStatus, runSandboxScript } from "../sandbox.js";
import { integer, objectSchema, string, stringSchema } from "./schema.js";
import type { Action, ActionContext, ActionResult } from "./types.js";

type Args = Record<string, unknown>;

export function createWorkspaceActions(): Action<any>[] {
  return [
    {
      name: "write_workspace_file",
      description: "Write a text file such as SRT subtitles, ASS captions, JSON, or a reusable script into the isolated project workspace. This does not execute scripts.",
      schema: objectSchema({ path: stringSchema(1, 240), content: stringSchema(0, 1_000_000) }),
      risk: "edit",
      describe: (args: Args) => `Write ${String(args.path)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => ({
        text: "Workspace file written",
        data: { path: await ctx.state.workspace.writeText(string(args.path, "path"), string(args.content, "content")) },
      }),
    },
    {
      name: "read_workspace_file",
      description: "Read a text file from the isolated project workspace.",
      schema: objectSchema({ path: stringSchema(1, 240) }),
      risk: "read",
      describe: (args: Args) => `Read ${String(args.path)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => ({
        text: "Workspace file contents", data: { content: await ctx.state.workspace.readText(string(args.path, "path")) },
      }),
    },
    {
      name: "list_workspace_files",
      description: "List text files in the isolated project workspace.",
      schema: objectSchema({}),
      risk: "read",
      describe: () => "List workspace files",
      run: async (_args: Args, ctx: ActionContext): Promise<ActionResult> => ({
        text: "Workspace files", data: { files: await ctx.state.workspace.listFiles() },
      }),
    },
    {
      name: "run_sandbox_script",
      description: "Run a Python or JavaScript file written to the project workspace through DumbEditor's local OS sandbox. Call sandbox_status first. The active video path is passed as the script's first argument; only the project workspace is writable; network and host API keys are unavailable.",
      schema: objectSchema({
        language: { type: "string", enum: ["python", "javascript"] },
        workspace_path: stringSchema(1, 240),
        arguments: { type: "array", maxItems: 30, items: stringSchema(0, 500) },
      }),
      risk: "code",
      describe: (args: Args) => `Run ${String(args.language)} script ${String(args.workspace_path)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        if (!Array.isArray(args.arguments) || !args.arguments.every((item) => typeof item === "string")) throw new Error("arguments must be an array of strings.");
        ctx.progress({ stage: "Running isolated script" });
        const result = await runSandboxScript({
          language: args.language as "python" | "javascript",
          workspace: ctx.state.workspace,
          workspacePath: string(args.workspace_path, "workspace_path"),
          activeVideoPath: ctx.state.store.current.filePath,
          arguments: args.arguments,
          signal: ctx.signal,
        });
        return { text: "Sandbox script completed.", data: result as unknown as Record<string, unknown> };
      },
    },
    {
      name: "sandbox_status",
      description: "Report the project workspace boundary and whether arbitrary script execution is safely available.",
      schema: objectSchema({}),
      risk: "read",
      describe: () => "Check sandbox status",
      run: async (_args: Args, ctx: ActionContext): Promise<ActionResult> => {
        const sandbox = await localSandboxStatus();
        return {
          text: sandbox.available
            ? `Custom FFmpeg and isolated script execution are available through ${sandbox.detail}.`
            : `Custom FFmpeg is available. Isolated scripts are disabled: ${sandbox.detail}.`,
          data: { root: ctx.state.workspace.root, scriptExecution: sandbox.available, sandbox: sandbox.detail, customFfmpeg: true, builtInFfmpegTools: true },
        };
      },
    },
    {
      name: "search_project_chat",
      description: "Search the complete local project transcript for older requests or decisions.",
      schema: objectSchema({ query: stringSchema(1, 500), limit: { type: "integer", minimum: 1, maximum: 50 } }),
      risk: "read",
      describe: (args: Args) => `Search chat: ${String(args.query)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => ({
        text: "Chat search results",
        data: { messages: await ctx.state.store.searchChat(string(args.query, "query"), integer(args.limit, "limit")) },
      }),
    },
    {
      name: "read_skill",
      description: "Load the full text of one packaged DumbEditor skill listed in the system prompt.",
      schema: objectSchema({ name: stringSchema(1, 80) }),
      risk: "read",
      describe: (args: Args) => `Read skill ${String(args.name)}`,
      run: async (args: Args): Promise<ActionResult> => {
        const name = string(args.name, "name");
        const skills = await loadAgentSkills();
        const skill = skills.find((item) => item.name === name);
        if (!skill) throw new Error(`Unknown skill ${name}. Available: ${skills.map((item) => item.name).join(", ")}`);
        return { text: skill.body };
      },
    },
  ];
}
```

Create `src/core/actions/interaction.ts`:

```typescript
import { objectSchema, stringSchema, string } from "./schema.js";
import type { Action, ActionContext, ActionResult } from "./types.js";

type Args = Record<string, unknown>;

export function createInteractionActions(): Action<any>[] {
  return [
    {
      name: "present_choices",
      description: "Open a native DumbEditor choice picker when the user should choose between several creative directions. The picker also has a custom answer field. Use it instead of printing a list of options when the answer should guide the current request.",
      schema: objectSchema({
        question: stringSchema(1, 500),
        options: { type: "array", minItems: 2, maxItems: 6, items: stringSchema(1, 160) },
        allow_custom: { type: "boolean" },
      }),
      risk: "read",
      describe: (args: Args) => `Ask: ${String(args.question).slice(0, 80)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        if (!Array.isArray(args.options) || !args.options.every((option) => typeof option === "string")) throw new Error("options must be an array of text choices.");
        const answer = await ctx.requestChoice({
          question: string(args.question, "question"),
          options: args.options.map((option) => option.trim()),
          allowCustom: args.allow_custom === true,
        });
        if (answer === null) throw new Error("The user cancelled the choice picker.");
        return { text: `The user chose: ${answer}`, data: { answer } };
      },
    },
  ];
}
```

Create `src/core/actions/index.ts`:

```typescript
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
```

Skills are now listed by name and description and loaded on demand with `read_skill`:

Create `src/core/agent-skills.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = ["video-editing", "asset-generation", "audio-music", "agent-workspace"] as const;

export interface AgentSkill {
  name: string;
  description: string;
  body: string;
}

let cachedSkills: Promise<AgentSkill[]> | undefined;

export function loadAgentSkills(): Promise<AgentSkill[]> {
  cachedSkills ??= readAgentSkills();
  return cachedSkills;
}

/** Names and one-line descriptions for the system prompt; the agent loads a body with read_skill. */
export function skillIndex(skills: readonly AgentSkill[]): string {
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
}

async function readAgentSkills(): Promise<AgentSkill[]> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const roots = [
    join(moduleDirectory, "..", "skills"),
    join(moduleDirectory, "..", "..", "skills"),
    join(process.cwd(), "skills"),
  ];
  for (const root of roots) {
    try {
      return await Promise.all(SKILLS.map(async (name) => parseSkill(name, await readFile(join(root, name, "SKILL.md"), "utf8"))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [];
}

export function parseSkill(name: string, source: string): AgentSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  const description = match?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? name;
  return { name, description, body: source.slice(match?.[0].length ?? 0).trim() };
}
```

The old loop still calls `loadAgentSkills()` until Task 7, so give it a one-line adapter:

Apply this change to `src/core/luna-agent.ts`:

```diff
--- a/src/core/luna-agent.ts
+++ b/src/core/luna-agent.ts
@@ -94,7 +94,7 @@
   let auditedSinceMutation = true;
 
   let round = 0;
-  const packagedSkills = await loadAgentSkills();
+  const packagedSkills = (await loadAgentSkills()).map((skill) => `## ${skill.name}\n${skill.body}`).join("\n\n");
   while (true) {
     options.onStage?.(round === 0 ? "planning the edit" : "reviewing tool results");
     const response = await fetch(provider === "openrouter" ? "https://openrouter.ai/api/v1/responses" : "https://api.openai.com/v1/responses", {
```

Two skills had no front matter, so the agent could not list them. Add it, and fix a stale model name:

Apply this change to `skills/video-editing/SKILL.md`:

```diff
--- a/skills/video-editing/SKILL.md
+++ b/skills/video-editing/SKILL.md
@@ -1,3 +1,8 @@
+---
+name: video-editing
+description: Edit the active video with validated FFmpeg tools, inspect frames, and review or revert versions.
+---
+
 # Video editing
 
 Use DumbEditor's validated FFmpeg tools for project mutations. Inspect frames when the request depends on visible content, then apply the smallest sequence of edits that completes the request.
```

Apply this change to `skills/agent-workspace/SKILL.md`:

```diff
--- a/skills/agent-workspace/SKILL.md
+++ b/skills/agent-workspace/SKILL.md
@@ -1,3 +1,8 @@
+---
+name: agent-workspace
+description: Write subtitle files and scripts in the isolated project workspace and run them in the local sandbox.
+---
+
 # Agent workspace
 
 The project workspace stores generated assets, subtitle files, notes, and reusable scripts. Paths are confined to the current project's `agent/workspace` directory and text files are limited to 1 MB.
```

Apply this change to `skills/audio-music/SKILL.md`:

```diff
--- a/skills/audio-music/SKILL.md
+++ b/skills/audio-music/SKILL.md
@@ -5,7 +5,7 @@
 
 # Audio and music
 
-Use `search_music_catalog` for free background tracks. Every bundled catalog record includes its source, license URL, and required attribution. `/bg-music` lets the user search, preview, stop, and persist a selection before asking Luna to mix it.
+Use `search_music_catalog` for free background tracks. Every bundled catalog record includes its source, license URL, and required attribution. `/bg-music` lets the user search, preview, stop, and persist a selection before asking the agent to mix it.
 
 For mixing:
 
```

Apply this change to `package.json`:

```diff
--- a/package.json
+++ b/package.json
@@ -17,7 +17,7 @@
     "build": "tsup",
     "check": "tsc --noEmit",
     "dev": "tsx src/cli.tsx",
-    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/luna.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/transcription.test.js",
+    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/luna.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/transcription.test.js",
     "quality": "npm run check && npm test && npm run build",
     "release:check": "npm run quality && npm pack --dry-run",
     "prepublishOnly": "npm run quality"
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/actions.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/editor.test.js
```

Expected: all pass (the 8 new tests render real FFmpeg video; allow about a minute). Then the whole suite:

```bash
npm test
```

Expected: undefined tests, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src skills tests package.json
git commit -m "feat: add the action registry shared by slash commands and the agent"
```

## Task 5: Session store

**Files:**
- Create: `src/core/session/session-store.ts`, `tests/session-store.test.ts`
- Modify: `package.json` (`test` script)

**Interfaces:**
- Produces: `class SessionStore` with `constructor(path: string)`, `load(): Promise<AgentMessage[]>` (replays messages, `compaction` and `replace` lines, skips unreadable lines, never returns system messages), `appendMessage(message)`, `appendCompaction({ summaryMessage, keptCount, tokensBefore })`, `appendReplace(messages)`.

- [ ] **Step 1: Write the test**

Create `tests/session-store.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionStore } from "../src/core/session/session-store.js";

const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: text, timestamp });
const textOf = (message: AgentMessage | undefined) => message && message.role === "user" && typeof message.content === "string" ? message.content : "";

async function withStore(run: (store: SessionStore, path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-session-"));
  try {
    const path = join(directory, "agent", "session.jsonl");
    await run(new SessionStore(path), path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("replays appended messages in order and never stores system messages", async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.load(), []);
    await store.appendMessage({ role: "system", content: "prompt", timestamp: 0 } as AgentMessage);
    await store.appendMessage(user("one", 1));
    await store.appendMessage(user("two", 2));
    assert.deepEqual((await store.load()).map(textOf), ["one", "two"]);
  });
});

test("a compaction entry replaces everything before the newest kept messages with the summary", async () => {
  await withStore(async (store) => {
    for (const [index, text] of ["a", "b", "c", "d"].entries()) await store.appendMessage(user(text, index + 1));
    await store.appendCompaction({ summaryMessage: user("SUMMARY", 10), keptCount: 2, tokensBefore: 123 });
    await store.appendMessage(user("e", 11));
    assert.deepEqual((await store.load()).map(textOf), ["SUMMARY", "c", "d", "e"]);
    await store.appendCompaction({ summaryMessage: user("SUMMARY 2", 20), keptCount: 0, tokensBefore: 456 });
    assert.deepEqual((await store.load()).map(textOf), ["SUMMARY 2"]);
  });
});

test("a replace entry swaps the whole transcript", async () => {
  await withStore(async (store) => {
    await store.appendMessage(user("old", 1));
    await store.appendReplace([user("new 1", 2), user("new 2", 3)]);
    await store.appendMessage(user("after", 4));
    assert.deepEqual((await store.load()).map(textOf), ["new 1", "new 2", "after"]);
  });
});

test("ignores a truncated final line and other unreadable lines", async () => {
  await withStore(async (store, path) => {
    await store.appendMessage(user("kept", 1));
    await appendFile(path, "not json\n{\"type\":\"message\",\"message\":{\"role\":\"us", "utf8");
    assert.deepEqual((await store.load()).map(textOf), ["kept"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL with `Cannot find module '../src/core/session/session-store.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/core/session/session-store.ts`:

```typescript
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
```

Apply this change to `package.json`:

```diff
--- a/package.json
+++ b/package.json
@@ -17,7 +17,7 @@
     "build": "tsup",
     "check": "tsc --noEmit",
     "dev": "tsx src/cli.tsx",
-    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/luna.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/transcription.test.js",
+    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/luna.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/transcription.test.js",
     "quality": "npm run check && npm test && npm run build",
     "release:check": "npm run quality && npm pack --dry-run",
     "prepublishOnly": "npm run quality"
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/session-store.test.js
```

Expected: 4 passed. Then `npm test`:

Expected: undefined tests, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/core/session tests package.json
git commit -m "feat: add an append-only agent session store"
```

## Task 6: The engine

**Files:**
- Create: `src/core/engine/events.ts`, `src/core/engine/prompt.ts`, `src/core/engine/engine.ts`, `tests/engine.test.ts`, `tests/live-openrouter.test.ts`
- Modify: `src/core/settings.ts` (add the spend limit only; the old fields go in Task 7), `package.json` (`test` script)

**Interfaces:**
- Consumes: everything from Tasks 2 to 5.
- Produces:
  - `EngineEvent` (union, `src/core/engine/events.ts`): `run_start`, `text_delta`, `thinking_delta`, `tool_start { callId, name, summary, risk }`, `tool_progress { callId, stage, fraction? }`, `tool_end { callId, ok, summary, versionId? }`, `approval_request { id, kind: "action" | "budget", callId?, name?, summary, risk, args? }`, `choice_request { id, question, options, allowCustom }`, `steer_queued { text }`, `usage { runCostUsd, estimated }`, `compaction { phase, tokensBefore?, tokensAfter? }`, `error { message, retryable }`, `run_end { reason: "done" | "aborted" | "error" | "budget", message }`; `ApprovalDecision = "once" | "session" | "deny"`.
  - `class Engine`: `static create(options: EngineOptions): Promise<Engine>`; `running: boolean`; `on(listener): () => void`; `submit(text)` (starts a run, or queues steering when one is active); `abort()`; `resolveApproval(id, decision)`; `resolveChoice(id, answer | null)`; `compact(): Promise<boolean>`.
  - `EngineOptions`: `state`, `registry`, `session`, `models`, `modelId`, `getSettings`, `skills?`, `chatSeed?`, `stallMs?`, `keepRecentTokens?`, and test seams `model?`, `streamFn?`, `tracker?`.
  - `setSpendCeiling(usd): Promise<DumbEditorSettings>` and `settings.agent.spendCeilingUsd` (default `5`, `0` = off).

- [ ] **Step 1: Write the tests**

The engine tests drive the real registry and a real FFmpeg project with pi's scripted fake model, so they cover streaming, steering, aborting, approvals, the audit rule, state injection, the spend limit, compaction and resume without any network.

Create `tests/engine.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream, fauxAssistantMessage, type AssistantMessage, type Model, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createEditorRegistry } from "../src/core/actions/index.js";
import { Engine } from "../src/core/engine/engine.js";
import type { EngineEvent } from "../src/core/engine/events.js";
import { AUDIT_NUDGE } from "../src/core/engine/prompt.js";
import type { CostTracker } from "../src/core/pi/cost.js";
import { createStreamFn } from "../src/core/pi/models.js";
import { SessionStore } from "../src/core/session/session-store.js";
import { DEFAULT_SETTINGS, type DumbEditorSettings } from "../src/core/settings.js";
import { call, makeFaux, say, toolUse } from "./helpers/faux.js";
import { makeProject } from "./helpers/project.js";

type RunEnd = Extract<EngineEvent, { type: "run_end" }>;

interface HarnessOptions {
  agent?: Partial<DumbEditorSettings["agent"]>;
  tracker?: CostTracker;
  stallMs?: number;
  keepRecentTokens?: number;
  contextWindow?: number;
}

async function harness(options: HarnessOptions = {}) {
  const project = await makeProject();
  const { faux, models, model } = makeFaux(options.contextWindow
    ? { models: [{ id: "small", name: "small", reasoning: false, input: ["text", "image"], contextWindow: options.contextWindow, maxTokens: 1_000 }] }
    : {});
  const settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings.agent, options.agent);
  const session = new SessionStore(join(project.directory, "agent", "session.jsonl"));
  const engineOptions = {
    state: project.state, registry: createEditorRegistry(), session, models, modelId: "faux", model,
    streamFn: createStreamFn(models), getSettings: () => settings,
    ...(options.tracker ? { tracker: options.tracker } : {}),
    ...(options.stallMs ? { stallMs: options.stallMs } : {}),
    ...(options.keepRecentTokens ? { keepRecentTokens: options.keepRecentTokens } : {}),
  };
  const engine = await Engine.create(engineOptions);
  const events: EngineEvent[] = [];
  engine.on((event) => events.push(event));
  const next = (type: EngineEvent["type"]) => waitFor(events, (event) => event.type === type);
  const runEnd = () => new Promise<RunEnd>((resolve) => {
    const off = engine.on((event) => { if (event.type === "run_end") { off(); resolve(event); } });
  });
  const ask = (text: string) => { const done = runEnd(); engine.submit(text); return done; };
  return { project, faux, models, model, settings, session, engine, engineOptions, events, next, runEnd, ask, cleanup: () => project.cleanup() };
}

async function waitFor(events: EngineEvent[], match: (event: EngineEvent) => boolean, seen = 0): Promise<EngineEvent> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = events.slice(seen).find(match);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for an engine event");
}

/** What a model request carried, one line per message, so tests can assert on the transcript. */
function flat(context: TranscriptContext): string[] {
  return context.messages.map((message) => {
    const content = (message as { content: unknown }).content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map((block: { type: string; text?: string; name?: string }) => block.type === "text" ? block.text ?? "" : `<${block.type}${block.name ? `:${block.name}` : ""}>`).join("") : "";
    return `${message.role}:${text}`;
  });
}

/** A scripted reply that also records the request it answered. */
function reply(message: AssistantMessage, seen: string[][]) {
  return (context: TranscriptContext) => { seen.push(flat(context)); return message; };
}

const REMOVE_END = call("remove_ranges", { ranges: [{ start: 3, end: 4 }] }, "c1");
const AUDIT = call("inspect_video_frames", { timestamps: [0.5], detail: "low" }, "c2");
const CHOICE = (id: string) => call("present_choices", { question: "Which one?", options: ["A", "B"], allow_custom: false }, id);
const BAD_GRAPH = (id: string) => call("render_custom_ffmpeg", { filter_graph: "movie=secret.mp4[v]", asset_ids: [], video_map: "[v]", audio_map: null, summary: "bad" }, id);
const GENERATE = call("generate_asset", { kind: "image", prompt: "a cat", duration: null, voice: null, provider: null, model: null, provider_options_json: null }, "g1");

test("streams the answer and ends the run with the final message", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    h.faux.setResponses([say("Hello there")]);
    const end = await h.ask("hi");
    assert.deepEqual([end.reason, end.message], ["done", "Hello there"]);
    assert.equal(h.events[0]?.type, "run_start");
    assert.ok(h.events.some((event) => event.type === "text_delta"));
    assert.equal(h.engine.running, false);
  } finally { await h.cleanup(); }
});

test("runs an edit through the registry and asks the model to audit before it stops", { timeout: 90_000 }, async () => {
  const h = await harness();
  try {
    h.faux.setResponses([toolUse(REMOVE_END), say("Removed the end."), toolUse(AUDIT), say("Audited: looks right.")]);
    const end = await h.ask("remove the last second");
    assert.equal(end.message, "Audited: looks right.");
    const finished = h.events.find((event) => event.type === "tool_end" && event.callId === "c1");
    assert.deepEqual(finished && finished.type === "tool_end" ? [finished.ok, finished.versionId] : null, [true, "v0001"]);
    assert.equal(h.project.store.current.id, "v0001");
    assert.ok((await h.session.load()).some((message) => JSON.stringify(message).includes("visually audit")));
    assert.equal(h.faux.getPendingResponseCount(), 0);
  } finally { await h.cleanup(); }
});

test("stops nudging after two audit reminders even if the model ignores them", { timeout: 90_000 }, async () => {
  const h = await harness();
  try {
    h.faux.setResponses([toolUse(REMOVE_END), say("one"), say("two"), say("three"), say("never used")]);
    const end = await h.ask("remove the last second");
    assert.equal(end.message, "three");
    assert.equal((await h.session.load()).filter((message) => JSON.stringify(message).includes("visually audit")).length, 2);
    assert.equal(h.faux.getPendingResponseCount(), 1);
  } finally { await h.cleanup(); }
});

test("sends editor state only when it changed", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const seen: string[][] = [];
    h.faux.setResponses([reply(say("one"), seen), reply(say("two"), seen), reply(say("three"), seen)]);
    await h.ask("first");
    await h.ask("second");
    h.project.state.setPlayhead(2);
    await h.ask("third");
    const states = (lines: string[]) => lines.filter((line) => line.startsWith("user:<editor_state"));
    assert.equal(states(seen[0] ?? []).length, 1);
    assert.equal(states(seen[1] ?? []).length, 1, "unchanged state is not sent again");
    assert.equal(states(seen[2] ?? []).length, 2);
    assert.match(states(seen[2] ?? [])[1] ?? "", /Playhead: 2\.0s/);
  } finally { await h.cleanup(); }
});

test("text typed during a run steers it after the current tool finishes", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const seen: string[][] = [];
    h.faux.setResponses([toolUse(CHOICE("c1")), reply(say("ok"), seen)]);
    const done = h.runEnd();
    h.engine.submit("start");
    const choice = await h.next("choice_request");
    h.engine.submit("also make it shorter");
    await h.next("steer_queued");
    assert.equal(choice.type, "choice_request");
    if (choice.type === "choice_request") h.engine.resolveChoice(choice.id, "A");
    const end = await done;
    assert.equal(end.reason, "done");
    const request = seen[0] ?? [];
    assert.ok(request.some((line) => line.includes("The user chose: A")));
    assert.ok(request.indexOf("user:also make it shorter") > request.findIndex((line) => line.includes("The user chose: A")));
  } finally { await h.cleanup(); }
});

test("abort ends the run, cancels the waiting action and closes unanswered tool calls", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    h.faux.setResponses([toolUse(CHOICE("c1"), call("list_versions", {}, "c2"))]);
    const done = h.runEnd();
    h.engine.submit("ask me");
    await h.next("choice_request");
    h.engine.abort();
    const end = await done;
    assert.equal(end.reason, "aborted");
    assert.equal(h.engine.running, false);
    const results = (await h.session.load()).filter((message) => message.role === "toolResult") as Array<{ toolCallId: string; isError: boolean; content: Array<{ text?: string }> }>;
    assert.deepEqual(results.map((result) => [result.toolCallId, result.isError]), [["c1", true], ["c2", true]]);
    assert.match(results[1]?.content[0]?.text ?? "", /Cancelled by user/);
  } finally { await h.cleanup(); }
});

test("paid actions ask first; a denial blocks the action and the model hears about it", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const seen: string[][] = [];
    h.faux.setResponses([toolUse(GENERATE), reply(say("I will not generate it."), seen)]);
    const done = h.runEnd();
    h.engine.submit("make a cat image");
    const request = await h.next("approval_request");
    assert.equal(request.type === "approval_request" ? request.risk : "", "spend");
    if (request.type === "approval_request") h.engine.resolveApproval(request.id, "deny");
    const end = await done;
    assert.equal(end.reason, "done");
    assert.ok((seen[0] ?? []).some((line) => line.includes("The user denied this action")));
  } finally { await h.cleanup(); }
});

test("allow-for-session asks once per action; auto mode never asks", { timeout: 60_000 }, async () => {
  const asking = await harness();
  try {
    asking.faux.setResponses([toolUse(BAD_GRAPH("a1"), BAD_GRAPH("a2")), say("done")]);
    const done = asking.runEnd();
    asking.engine.submit("try custom ffmpeg");
    const request = await asking.next("approval_request");
    assert.equal(request.type === "approval_request" ? request.risk : "", "code");
    if (request.type === "approval_request") asking.engine.resolveApproval(request.id, "session");
    await done;
    assert.equal(asking.events.filter((event) => event.type === "approval_request").length, 1);
    assert.equal(asking.events.filter((event) => event.type === "tool_end" && !event.ok).length, 2, "the bad graph is rejected by the action itself");
  } finally { await asking.cleanup(); }
  const auto = await harness({ agent: { permissionMode: "auto" } });
  try {
    auto.faux.setResponses([toolUse(BAD_GRAPH("b1")), say("done")]);
    await auto.ask("try custom ffmpeg");
    assert.equal(auto.events.filter((event) => event.type === "approval_request").length, 0);
  } finally { await auto.cleanup(); }
});

const COSTLY: CostTracker = {
  onProviderStreamEvent: () => undefined,
  takeCost: () => ({ costUsd: 0.6, estimated: false, source: "openrouter" }),
  pendingCount: () => 0,
};

test("pauses at the spend ceiling: declining ends the run, allowing continues it", { timeout: 60_000 }, async () => {
  const stop = await harness({ agent: { spendCeilingUsd: 1 }, tracker: COSTLY });
  try {
    stop.faux.setResponses([toolUse(call("list_versions", {}, "l1")), toolUse(call("list_versions", {}, "l2")), say("never")]);
    const done = stop.runEnd();
    stop.engine.submit("keep going");
    const request = await stop.next("approval_request");
    assert.equal(request.type === "approval_request" ? request.kind : "", "budget");
    if (request.type === "approval_request") stop.engine.resolveApproval(request.id, "deny");
    assert.equal((await done).reason, "budget");
  } finally { await stop.cleanup(); }
  const go = await harness({ agent: { spendCeilingUsd: 1 }, tracker: COSTLY });
  try {
    go.faux.setResponses([toolUse(call("list_versions", {}, "l1")), toolUse(call("list_versions", {}, "l2")), say("finished")]);
    const done = go.runEnd();
    go.engine.submit("keep going");
    const request = await go.next("approval_request");
    if (request.type === "approval_request") go.engine.resolveApproval(request.id, "once");
    const end = await done;
    assert.deepEqual([end.reason, end.message], ["done", "finished"]);
  } finally { await go.cleanup(); }
});

test("records each model turn in the project's cost ledger", { timeout: 60_000 }, async () => {
  const h = await harness({ tracker: COSTLY });
  try {
    h.faux.setResponses([say("hi")]);
    await h.ask("hello");
    const usage = h.project.state.usage;
    assert.equal(usage.lunaUsd, 0.6);
    assert.equal((await h.project.store.usageEntries())[0]?.kind, "agent");
  } finally { await h.cleanup(); }
});

// The system prompt and tool declarations are about 3.7k tokens, so a 9k window compacts at roughly 5.4k.
test("compacts before a run when the saved conversation is too large, then answers", { timeout: 60_000 }, async () => {
  const h = await harness({ contextWindow: 9_000, keepRecentTokens: 300 });
  try {
    for (let turn = 0; turn < 24; turn += 1) {
      await h.session.appendMessage({ role: "user", content: `earlier request ${turn} ${"x".repeat(600)}`, timestamp: 100 + turn });
    }
    const engine = await Engine.create(h.engineOptions);
    const events: EngineEvent[] = [];
    engine.on((event) => events.push(event));
    const seen: string[][] = [];
    h.faux.setResponses([say("## Goal\nearlier work\n\n## Visual findings\n(none)"), reply(say("ok"), seen)]);
    const done = new Promise<RunEnd>((resolve) => { const off = engine.on((event) => { if (event.type === "run_end") { off(); resolve(event); } }); });
    engine.submit("continue");
    assert.equal((await done).message, "ok");
    assert.deepEqual(events.filter((event) => event.type === "compaction").map((event) => event.type === "compaction" ? event.phase : ""), ["start", "end"]);
    assert.ok((seen[0] ?? []).some((line) => line.includes("<summary>") && line.includes("earlier work")));
    assert.ok(JSON.stringify((await h.session.load())[0]).includes("earlier work"), "the saved session starts from the summary");
  } finally { await h.cleanup(); }
});

test("compacts in the middle of a run and keeps going on the compacted transcript", { timeout: 60_000 }, async () => {
  const h = await harness({ contextWindow: 9_000, keepRecentTokens: 300 });
  try {
    for (let turn = 0; turn < 6; turn += 1) {
      await h.session.appendMessage({ role: "user", content: `older request ${turn} ${"x".repeat(600)}`, timestamp: 100 + turn });
    }
    await h.project.state.workspace.writeText("big.txt", "y".repeat(3_000));
    const engine = await Engine.create(h.engineOptions);
    const events: EngineEvent[] = [];
    engine.on((event) => events.push(event));
    const ask = (text: string) => new Promise<RunEnd>((resolve) => {
      const off = engine.on((event) => { if (event.type === "run_end") { off(); resolve(event); } });
      engine.submit(text);
    });
    const seen: string[][] = [];
    h.faux.setResponses([
      toolUse(call("read_workspace_file", { path: "big.txt" }, "r1")),
      say("## Goal\nread the file\n\n## Visual findings\n(none)"),
      reply(say("final"), seen),
      reply(say("second run"), seen),
    ]);
    assert.equal((await ask("read big.txt")).message, "final");
    assert.deepEqual(events.filter((event) => event.type === "compaction").map((event) => event.type === "compaction" ? event.phase : ""), ["start", "end"]);
    const request = seen[0] ?? [];
    assert.ok(request.some((line) => line.includes("<summary>") && line.includes("read the file")));
    assert.ok(request.some((line) => line.startsWith("toolResult:")), "the newest tool result is kept");
    assert.ok(!request.some((line) => line.includes("older request 0")), "older messages were summarized away");
    assert.equal((await ask("again")).message, "second run");
    assert.ok((seen[1] ?? []).some((line) => line.includes("<summary>")), "the next run continues from the compacted transcript");
    assert.ok(JSON.stringify((await h.session.load())[0]).includes("read the file"));
  } finally { await h.cleanup(); }
});

test("a new engine resumes from the saved session", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    h.faux.setResponses([say("Hello there")]);
    await h.ask("hi");
    const resumed = await Engine.create(h.engineOptions);
    const seen: string[][] = [];
    h.faux.setResponses([reply(say("welcome back"), seen)]);
    const done = new Promise<RunEnd>((resolve) => { const off = resumed.on((event) => { if (event.type === "run_end") { off(); resolve(event); } }); });
    resumed.submit("do you remember?");
    await done;
    const request = seen[0] ?? [];
    assert.ok(request.includes("user:hi") && request.includes("assistant:Hello there"));
  } finally { await h.cleanup(); }
});

test("seeds a project that has chat history but no agent session yet", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const seen: string[][] = [];
    const engine = await Engine.create({ ...h.engineOptions, chatSeed: [
      { role: "user", content: "make it black and white", at: "t" },
      { role: "assistant", content: "Done, v0003.", at: "t" },
    ] });
    h.faux.setResponses([reply(say("ok"), seen)]);
    const done = new Promise<RunEnd>((resolve) => { const off = engine.on((event) => { if (event.type === "run_end") { off(); resolve(event); } }); });
    engine.submit("and now crop it");
    await done;
    assert.ok((seen[0] ?? []).some((line) => line.includes("<previous_conversation>") && line.includes("make it black and white")));
  } finally { await h.cleanup(); }
});

test("reports a provider error without saving it as an answer", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    h.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" })]);
    const end = await h.ask("hi");
    assert.deepEqual([end.reason, end.message], ["error", ""]);
    const error = h.events.find((event) => event.type === "error");
    assert.equal(error && error.type === "error" ? error.message : "", "provider exploded");
  } finally { await h.cleanup(); }
});

test("stops a model that goes silent", { timeout: 60_000 }, async () => {
  const h = await harness({ stallMs: 80 });
  try {
    const silent = (model: Model<never>, _context: TranscriptContext, options?: { signal?: AbortSignal }) => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener("abort", () => {
        const message = fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" });
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end(message);
      }, { once: true });
      void model;
      return stream;
    };
    const engine = await Engine.create({ ...h.engineOptions, streamFn: silent as never, stallMs: 80 });
    const events: EngineEvent[] = [];
    engine.on((event) => events.push(event));
    const done = new Promise<RunEnd>((resolve) => { const off = engine.on((event) => { if (event.type === "run_end") { off(); resolve(event); } }); });
    engine.submit("hello?");
    const end = await done;
    assert.equal(end.reason, "error");
    assert.ok(events.some((event) => event.type === "error" && /stopped responding/.test(event.message)));
  } finally { await h.cleanup(); }
});

test("caps a huge tool result before it reaches the model", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    await h.project.state.workspace.writeText("huge.txt", "z".repeat(200_000));
    h.faux.setResponses([toolUse(call("read_workspace_file", { path: "huge.txt" }, "r1")), say("read it")]);
    await h.ask("read huge.txt");
    const result = (await h.session.load()).find((message) => message.role === "toolResult") as { content: Array<{ text?: string }> } | undefined;
    const text = result?.content[0]?.text ?? "";
    assert.ok(text.length < 51_000, `tool text was ${text.length} characters`);
    assert.match(text, /more characters truncated/);
  } finally { await h.cleanup(); }
});

test("an invalid tool call becomes an error result and the run carries on", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const seen: string[][] = [];
    h.faux.setResponses([toolUse(call("remove_ranges", { ranges: "not a list" }, "bad1")), reply(say("sorry, retrying"), seen)]);
    const end = await h.ask("remove something");
    assert.deepEqual([end.reason, end.message], ["done", "sorry, retrying"]);
    const finished = h.events.find((event) => event.type === "tool_end" && event.callId === "bad1");
    assert.equal(finished && finished.type === "tool_end" ? finished.ok : true, false);
    assert.equal(h.project.store.current.id, "v0000", "nothing was committed");
    assert.ok((seen[0] ?? []).some((line) => line.startsWith("toolResult:")));
  } finally { await h.cleanup(); }
});

test("two quick submissions make one run: the second steers the first", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const seen: string[][] = [];
    h.faux.setResponses([reply(say("one"), seen), reply(say("two"), seen)]);
    const done = h.runEnd();
    h.engine.submit("first");
    h.engine.submit("second");
    await done;
    assert.equal(h.events.filter((event) => event.type === "run_start").length, 1);
    assert.ok(h.events.some((event) => event.type === "steer_queued" && event.text === "second"));
    assert.ok(seen.some((request) => request.includes("user:first") || request.includes("user:second")));
    assert.ok(seen.some((request) => request.includes("user:second")), "the steering text must reach the model, never be dropped");
  } finally { await h.cleanup(); }
});

test("a failing summarizer is reported and the run still answers", { timeout: 60_000 }, async () => {
  const h = await harness({ contextWindow: 9_000, keepRecentTokens: 300 });
  try {
    for (let turn = 0; turn < 24; turn += 1) {
      await h.session.appendMessage({ role: "user", content: `earlier request ${turn} ${"x".repeat(600)}`, timestamp: 100 + turn });
    }
    const engine = await Engine.create(h.engineOptions);
    const events: EngineEvent[] = [];
    engine.on((event) => events.push(event));
    h.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "summarizer exploded" }), say("answered anyway")]);
    const done = new Promise<RunEnd>((resolve) => { const off = engine.on((event) => { if (event.type === "run_end") { off(); resolve(event); } }); });
    engine.submit("continue");
    const end = await done;
    assert.deepEqual([end.reason, end.message], ["done", "answered anyway"]);
    assert.ok(events.some((event) => event.type === "error" && /compaction failed/i.test(event.message)));
  } finally { await h.cleanup(); }
});

test("aborting while an approval is pending denies it and ends the run", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    h.faux.setResponses([toolUse(GENERATE)]);
    const done = h.runEnd();
    h.engine.submit("make a cat image");
    await h.next("approval_request");
    h.engine.abort();
    assert.equal((await done).reason, "aborted");
    assert.equal(h.engine.running, false);
  } finally { await h.cleanup(); }
});

test("hands back text typed as a run ended instead of dropping it, but not audit reminders", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const internals = h.engine as unknown as { agent: Agent; takeLeftoverSteering(): string[] };
    internals.agent.steer({ role: "user", content: "late message", timestamp: 1 });
    internals.agent.steer({ role: "user", content: AUDIT_NUDGE, timestamp: 2 });
    assert.deepEqual(internals.takeLeftoverSteering(), ["late message"]);
    assert.equal(internals.agent.hasQueuedMessages(), false);
  } finally { await h.cleanup(); }
});
```

The live test is skipped unless you opt in; it is how the unverified OpenRouter cost field gets checked against the real service:

Create `tests/live-openrouter.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createCostTracker } from "../src/core/pi/cost.js";
import { createEditorModels, createStreamFn, EDITOR_STREAM_DEFAULTS, openRouterModel } from "../src/core/pi/models.js";

// Opt-in: spends a fraction of a cent. Run with DUMBEDITOR_LIVE_TEST=1 and OPENROUTER_API_KEY set.
// Set DUMBEDITOR_LIVE_MODEL (for example anthropic/claude-haiku-4.5) to check the Anthropic-compatible path.
const live = process.env.DUMBEDITOR_LIVE_TEST === "1" && Boolean(process.env.OPENROUTER_API_KEY?.trim());

test("live: OpenRouter answers and reports a real cost", { skip: !live, timeout: 60_000 }, async () => {
  const models = createEditorModels({ apiKey: process.env.OPENROUTER_API_KEY!.trim() });
  const tracker = createCostTracker();
  const streamFn = createStreamFn(models, { ...EDITOR_STREAM_DEFAULTS, onProviderStreamEvent: tracker.onProviderStreamEvent });
  const model = openRouterModel(models, process.env.DUMBEDITOR_LIVE_MODEL?.trim() || "openai/gpt-4o-mini");
  const context = normalizeContext({ messages: [{ role: "user", content: "Reply with the single word: ready", timestamp: Date.now() }] });
  const message = await (await streamFn(model, context, { maxTokens: 20 })).result();
  assert.equal(message.stopReason, "stop", message.errorMessage);
  const cost = tracker.takeCost(message);
  assert.ok(cost, "the response carried no usage");
  console.log(`live cost for ${model.id}: ${JSON.stringify(cost)}`);
  assert.equal(cost.estimated, false, "OpenRouter's usage.cost did not reach the tracker; the wire shape differs from the documented one");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx tsc -p tsconfig.test.json
```

Expected: FAIL with `Cannot find module '../src/core/engine/engine.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/core/engine/events.ts`:

```typescript
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
```

Create `src/core/engine/prompt.ts`:

```typescript
import { skillIndex, type AgentSkill } from "../agent-skills.js";

export const AUDIT_NUDGE = "[system] Before finishing, visually audit the current rendered version with inspect_video_frames. Sample the edited ranges and enough surrounding frames to catch timing, layout, or rendering mistakes. If the audit finds a problem, correct it and audit again.";

export function agentSystemPrompt(skills: readonly AgentSkill[]): string {
  return [
    "You are the DumbEditor video-editing agent. You and the user work on the same open project: whatever the user does in the editor (moving the playhead, setting marks, undoing) is visible to you, and everything you do appears to them as it happens.",
    "Use the supplied tools to complete the user's request; you may call several tools in sequence. Messages wrapped in <editor_state> describe the playhead, in/out marks, active version and recent versions. They are updated whenever they change; call get_editor_state if you need them fresh. When the user says \"here\" or \"this part\", use the playhead and marks.",
    "Prefer deterministic local editing tools. Generate paid assets only when the request actually needs them.",
    "When the user asks to add or generate subtitles and the video has audio, call transcribe_and_add_subtitles; do not ask them to provide a transcript first.",
    "When no specialized edit tool fits, inspect the available general workspace and rendering tools and devise a method before saying the edit is unavailable.",
    "Every edit creates a new immutable version. list_versions, revert_to and compare_frames let you review and undo your own work; an edit made after reverting branches from that version.",
    "After every rendered mutation, inspect frames from the current output around the changed ranges before you finish. The harness enforces a final visual audit.",
    "When several reasonable creative directions would benefit from a user decision, call present_choices instead of printing a list. Continue using the selected or custom answer it returns.",
    "The user may send new messages while you work; treat them as updated instructions. Some tools ask the user for approval; if one is denied, do not retry it, adapt or explain.",
    "If a tool fails, correct the arguments or explain the exact blocker. Never invent a successful edit.",
    "Keep the final response short and say which version and assets were created.",
    skills.length > 0 ? `Packaged skills (call read_skill with a name to load one when relevant):\n${skillIndex(skills)}` : "",
  ].filter(Boolean).join("\n\n");
}
```

Create `src/core/engine/engine.ts`:

```typescript
import { randomUUID } from "node:crypto";
import {
  Agent,
  type AgentEvent,
  type AgentLoopTurnUpdate,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  type AgentTurnContext,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type PrepareNextTurnContext,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Message, Model, Models, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ChatMessage } from "../../types.js";
import type { ActionRegistry } from "../actions/registry.js";
import type { Action, ActionContext, ActionProgress, ActionResult, Risk } from "../actions/types.js";
import type { AgentSkill } from "../agent-skills.js";
import type { ChoiceRequest } from "../choice.js";
import { createCostTracker, type CostTracker } from "../pi/cost.js";
import { compact, estimateContextTokens, NothingToCompactError, shouldCompact, type CompactionResult } from "../pi/compaction.js";
import { createEditorStateSync } from "../pi/editor-state-sync.js";
import { createStreamFn, EDITOR_STREAM_DEFAULTS, openRouterModel } from "../pi/models.js";
import { toolFromJsonSchema } from "../pi/tools.js";
import type { SessionStore } from "../session/session-store.js";
import type { DumbEditorSettings } from "../settings.js";
import type { EditorState } from "../state/editor-state.js";
import { formatUsd } from "../usage.js";
import type { ApprovalDecision, EngineEvent } from "./events.js";
import { AUDIT_NUDGE, agentSystemPrompt } from "./prompt.js";

/** Compact when the transcript passes this share of the model's context window. */
export const COMPACTION_THRESHOLD = 0.6;
/** Tokens of the newest conversation kept verbatim when compacting. */
export const KEEP_RECENT_TOKENS = 20_000;
const MAX_AUDIT_NUDGES = 2;
const MAX_TOOL_TEXT = 50_000;
const DEFAULT_STALL_MS = 5 * 60_000;

export interface EngineOptions {
  state: EditorState;
  registry: ActionRegistry;
  session: SessionStore;
  models: Models;
  /** OpenRouter model id used for the agent. */
  modelId: string;
  /** Read on every run so /permissions and /budget apply immediately. */
  getSettings: () => DumbEditorSettings;
  skills?: readonly AgentSkill[];
  /** Recent project chat, used to seed a project that has no agent session yet. */
  chatSeed?: readonly ChatMessage[];
  /** Milliseconds a model response may stay silent before the run is stopped. */
  stallMs?: number;
  /** Tokens of newest conversation kept verbatim when compacting. */
  keepRecentTokens?: number;
  /** Test seams: a prebuilt model, stream function and cost source (for example pi's faux provider). */
  model?: Model<Api>;
  streamFn?: StreamFn;
  tracker?: CostTracker;
}

interface ToolDetails {
  summary: string;
  versionId?: string;
}

interface RunState {
  id: string;
  request: string;
  controller: AbortController;
  costUsd: number;
  ceilingUsd: number;
  nudges: number;
  mutatedSinceAudit: boolean;
  abortRequested: boolean;
  budgetStopped: boolean;
  failed: boolean;
  /** Newest assistant message of this run; compaction can replace the transcript mid-run. */
  lastAssistant?: AssistantMessage;
  stallTimer?: NodeJS.Timeout;
}

/**
 * The agent for one open project. It owns the pi Agent and turns everything the agent does into
 * EngineEvents; clients call submit/abort/resolve* and never see pi.
 */
export class Engine {
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private readonly agent: Agent;
  private readonly model: Model<Api>;
  private readonly tracker: CostTracker;
  private readonly compactionTracker = createCostTracker();
  private readonly compactionStreamFn: StreamFn;
  private readonly sync;
  private readonly approvals = new Map<string, (decision: ApprovalDecision) => void>();
  private readonly choices = new Map<string, (answer: string | null) => void>();
  private readonly sessionAllowed = new Set<string>();
  private run: RunState | null = null;
  private compacting = false;

  static async create(options: EngineOptions): Promise<Engine> {
    let messages = await options.session.load();
    if (messages.length === 0 && options.chatSeed && options.chatSeed.length > 0) {
      const seed = seedMessage(options.chatSeed);
      if (seed) {
        messages = [seed];
        await options.session.appendMessage(seed);
      }
    }
    return new Engine(options, messages);
  }

  private constructor(private readonly options: EngineOptions, messages: AgentMessage[]) {
    this.model = options.model ?? openRouterModel(options.models, options.modelId);
    this.tracker = options.tracker ?? createCostTracker();
    const streamFn = options.streamFn
      ?? createStreamFn(options.models, { ...EDITOR_STREAM_DEFAULTS, onProviderStreamEvent: this.tracker.onProviderStreamEvent });
    this.compactionStreamFn = options.streamFn
      ?? createStreamFn(options.models, { ...EDITOR_STREAM_DEFAULTS, onProviderStreamEvent: this.compactionTracker.onProviderStreamEvent });
    this.sync = createEditorStateSync(() => options.state.describe());
    this.agent = new Agent({
      initialState: {
        systemPrompt: agentSystemPrompt(options.skills ?? []),
        model: this.model,
        thinkingLevel: this.model.reasoning ? "medium" : "off",
        tools: options.registry.list().map((action) => this.toolFor(action)),
        messages,
      },
      streamFn,
      sessionId: randomUUID(),
      toolExecution: "sequential",
      steeringMode: "all",
      beforeToolCall: (context, signal) => this.beforeToolCall(context, signal),
      finishTurn: (turn, signal) => this.finishTurn(turn, signal),
      prepareNextTurnWithContext: (turn, signal) => this.prepareNextTurn(turn, signal),
    });
    this.agent.subscribe((event) => this.onAgentEvent(event));
  }

  get running(): boolean {
    return this.run !== null;
  }

  on(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Start a run, or queue the text as steering when one is already active. */
  submit(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.compacting) {
      this.emit({ type: "error", message: "Context compaction is running. Try again in a moment.", retryable: true });
      return;
    }
    if (this.run) {
      this.agent.steer({ role: "user", content: trimmed, timestamp: Date.now() });
      this.emit({ type: "steer_queued", text: trimmed });
      return;
    }
    void this.execute(trimmed);
  }

  abort(): void {
    const run = this.run;
    if (!run) return;
    run.abortRequested = true;
    run.controller.abort();
    this.agent.abort();
    for (const resolve of this.approvals.values()) resolve("deny");
    this.approvals.clear();
    for (const resolve of this.choices.values()) resolve(null);
    this.choices.clear();
  }

  resolveApproval(id: string, decision: ApprovalDecision): void {
    const resolve = this.approvals.get(id);
    this.approvals.delete(id);
    resolve?.(decision);
  }

  resolveChoice(id: string, answer: string | null): void {
    const resolve = this.choices.get(id);
    this.choices.delete(id);
    resolve?.(answer);
  }

  /** Summarize older conversation now. Returns false when there was nothing to compact. */
  async compact(): Promise<boolean> {
    if (this.run) throw new Error("Wait for the current run to finish before compacting.");
    if (this.compacting) return false;
    this.compacting = true;
    try {
      const result = await this.compactTranscript(this.agent.state.messages);
      if (!result) return false;
      this.agent.state.messages = result.messages;
      return true;
    } finally {
      this.compacting = false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------------------------

  private async execute(text: string): Promise<void> {
    const settings = this.options.getSettings();
    const run: RunState = {
      id: randomUUID(),
      request: text,
      controller: new AbortController(),
      costUsd: 0,
      ceilingUsd: ceilingOf(settings),
      nudges: 0,
      mutatedSinceAudit: false,
      abortRequested: false,
      budgetStopped: false,
      failed: false,
    };
    this.run = run;
    this.emit({ type: "run_start", runId: run.id });
    try {
      if (shouldCompact(this.agent.state.messages, this.model.contextWindow, { thresholdRatio: COMPACTION_THRESHOLD })) {
        const result = await this.compactTranscript(this.agent.state.messages, run.controller.signal);
        if (result) this.agent.state.messages = result.messages;
      }
      if (!run.controller.signal.aborted) await this.agent.prompt(this.sync.wrapPrompt(text));
    } catch (error) {
      run.failed = true;
      this.emit({ type: "error", message: errorText(error), retryable: true });
    } finally {
      await this.finishRun(run);
    }
  }

  private async finishRun(run: RunState): Promise<void> {
    if (run.stallTimer) clearTimeout(run.stallTimer);
    const leftover = this.takeLeftoverSteering();
    try {
      await this.closeUnansweredToolCalls();
    } catch (error) {
      this.emit({ type: "error", message: `Could not save the cancelled run: ${errorText(error)}`, retryable: false });
    }
    const last = run.lastAssistant;
    let reason: "done" | "aborted" | "error" | "budget" = "done";
    if (run.budgetStopped) reason = "budget";
    else if (run.abortRequested) reason = "aborted";
    else if (run.failed) reason = "error";
    else if (last?.stopReason === "aborted") reason = "aborted";
    else if (last?.stopReason === "error") {
      reason = "error";
      this.emit({ type: "error", message: last.errorMessage ?? "The model request failed.", retryable: true });
    }
    this.run = null;
    this.emit({ type: "run_end", reason, message: reason === "done" && last ? textOf(last) : "" });
    // Text typed after the loop's last steering check would otherwise vanish: run it as a follow-up.
    if (reason === "done" && leftover.length > 0) this.submit(leftover.join("\n\n"));
  }

  /** Empty the steering queue, returning what the user typed (audit reminders are dropped). */
  private takeLeftoverSteering(): string[] {
    const texts = this.agent.peekQueuedMessages()
      .map((message) => message.role === "user" && typeof message.content === "string" ? message.content : "")
      .filter((text) => text !== "" && !text.startsWith("[system]"));
    this.agent.clearAllQueues();
    return texts;
  }

  /**
   * After an abort in sequential mode, a tool call can be left without a result. Close each one with a
   * "Cancelled" result so the saved transcript stays valid and the model knows what did not happen.
   */
  private async closeUnansweredToolCalls(): Promise<void> {
    const messages = this.agent.state.messages;
    let callIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant" && (message as AssistantMessage).content.some((block) => block.type === "toolCall")) {
        callIndex = index;
        break;
      }
    }
    if (callIndex < 0) return;
    const answered = new Set<string>();
    let insertAt = callIndex + 1;
    for (let index = callIndex + 1; index < messages.length; index += 1) {
      const message = messages[index];
      if (message?.role !== "toolResult") break;
      answered.add((message as ToolResultMessage).toolCallId);
      insertAt = index + 1;
    }
    const missing = (messages[callIndex] as AssistantMessage).content
      .filter((block): block is ToolCall => block.type === "toolCall" && !answered.has(block.id));
    if (missing.length === 0) return;
    const synthetic: ToolResultMessage[] = missing.map((call) => ({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "Cancelled by user before this tool ran." }],
      isError: true,
      timestamp: Date.now(),
    }));
    const next = [...messages.slice(0, insertAt), ...synthetic, ...messages.slice(insertAt)];
    this.agent.state.messages = next;
    await this.options.session.appendReplace(next);
  }

  // ---------------------------------------------------------------------------------------------
  // pi hooks
  // ---------------------------------------------------------------------------------------------

  private async onAgentEvent(event: AgentEvent): Promise<void> {
    const run = this.run;
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        if (run) this.armStallTimer(run);
        break;
      case "message_start":
        if (run && event.message.role === "assistant") this.armStallTimer(run);
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (run) this.armStallTimer(run);
        if (update.type === "text_delta") this.emit({ type: "text_delta", text: update.delta });
        else if (update.type === "thinking_delta") this.emit({ type: "thinking_delta", text: update.delta });
        break;
      }
      case "message_end":
        if (run && event.message.role === "assistant") {
          if (run.stallTimer) clearTimeout(run.stallTimer);
          run.lastAssistant = event.message as AssistantMessage;
        }
        await this.options.session.appendMessage(event.message);
        break;
      case "turn_end":
        if (run && event.message.role === "assistant") await this.recordTurnCost(run, event.message as AssistantMessage);
        break;
      case "tool_execution_start":
        this.emit({
          type: "tool_start", callId: event.toolCallId, name: event.toolName,
          summary: this.safeDescribe(event.toolName, event.args), risk: this.safeRisk(event.toolName, event.args),
        });
        break;
      case "tool_execution_update": {
        const details = (event.partialResult as { details?: { stage?: string; fraction?: number } } | undefined)?.details;
        if (details?.stage) {
          this.emit({
            type: "tool_progress", callId: event.toolCallId, stage: details.stage,
            ...(typeof details.fraction === "number" ? { fraction: details.fraction } : {}),
          });
        }
        break;
      }
      case "tool_execution_end": {
        const details = (event.result as AgentToolResult<ToolDetails> | undefined)?.details;
        const versionId = details?.versionId;
        if (run && !event.isError) {
          if (versionId) run.mutatedSinceAudit = true;
          if (this.options.registry.get(event.toolName)?.audits) run.mutatedSinceAudit = false;
        }
        this.emit({
          type: "tool_end", callId: event.toolCallId, ok: !event.isError,
          summary: details?.summary ?? textOfResult(event.result), ...(versionId ? { versionId } : {}),
        });
        break;
      }
      default:
        break;
    }
  }

  private armStallTimer(run: RunState): void {
    if (run.stallTimer) clearTimeout(run.stallTimer);
    run.stallTimer = setTimeout(() => {
      run.failed = true;
      this.emit({ type: "error", message: "The model stopped responding, so the run was stopped.", retryable: true });
      run.controller.abort();
      this.agent.abort();
    }, this.options.stallMs ?? DEFAULT_STALL_MS);
    run.stallTimer.unref();
  }

  private async recordTurnCost(run: RunState, message: AssistantMessage): Promise<void> {
    const cost = this.tracker.takeCost(message);
    if (!cost || (cost.costUsd === 0 && message.usage.totalTokens === 0)) return;
    run.costUsd += cost.costUsd;
    await this.options.state.recordUsage({
      kind: "agent", provider: "openrouter", model: this.options.modelId, label: run.request.slice(0, 160),
      costUsd: cost.costUsd, estimated: cost.estimated,
      inputTokens: message.usage.input, cachedInputTokens: message.usage.cacheRead,
      cacheWriteTokens: message.usage.cacheWrite, outputTokens: message.usage.output,
    });
    this.emit({ type: "usage", runCostUsd: run.costUsd, estimated: cost.estimated });
  }

  private async beforeToolCall(context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> {
    const name = context.toolCall.name;
    const risk = this.safeRisk(name, context.args);
    if (risk === "read" || risk === "edit") return undefined;
    if (this.options.getSettings().agent.permissionMode === "auto" || this.sessionAllowed.has(name)) return undefined;
    const decision = await this.askApproval({
      kind: "action", callId: context.toolCall.id, name,
      summary: this.safeDescribe(name, context.args), risk, args: context.args,
    }, signal);
    if (decision === "deny") return { block: true, reason: "The user denied this action. Do not retry it; adapt or explain." };
    if (decision === "session") this.sessionAllowed.add(name);
    return undefined;
  }

  /** Nudge the model to audit its output before it stops, at most twice per run. */
  private async finishTurn(turn: AgentTurnContext, signal?: AbortSignal): Promise<undefined> {
    const run = this.run;
    if (!run || turn.message.stopReason !== "stop" || signal?.aborted) return undefined;
    if (run.mutatedSinceAudit && run.nudges < MAX_AUDIT_NUDGES) {
      run.nudges += 1;
      this.agent.steer({ role: "user", content: AUDIT_NUDGE, timestamp: Date.now() });
    }
    return undefined;
  }

  private async prepareNextTurn(turn: PrepareNextTurnContext, signal?: AbortSignal): Promise<AgentLoopTurnUpdate | undefined> {
    const run = this.run;
    if (run && !(await this.withinBudget(run, signal))) return undefined;
    const update: AgentLoopTurnUpdate = {};
    if (shouldCompact(turn.context.messages, this.model.contextWindow, { thresholdRatio: COMPACTION_THRESHOLD })) {
      const result = await this.compactTranscript(turn.context.messages, signal);
      if (result) {
        this.agent.state.messages = result.messages;
        update.context = { ...turn.context, messages: [...result.messages] };
      }
    }
    const state = this.sync.prepareNextTurn();
    if (state?.messages) update.messages = state.messages;
    return update.context || update.messages ? update : undefined;
  }

  private async withinBudget(run: RunState, signal?: AbortSignal): Promise<boolean> {
    if (run.costUsd < run.ceilingUsd) return true;
    const decision = await this.askApproval({
      kind: "budget", risk: "budget",
      summary: `This run has spent ${formatUsd(run.costUsd)}, over its ${formatUsd(run.ceilingUsd)} limit. Continue?`,
    }, signal);
    if (decision === "deny") {
      run.budgetStopped = true;
      this.agent.abort();
      return false;
    }
    run.ceilingUsd += ceilingOf(this.options.getSettings());
    return true;
  }

  private async compactTranscript(messages: readonly AgentMessage[], signal?: AbortSignal): Promise<CompactionResult | undefined> {
    this.emit({ type: "compaction", phase: "start" });
    try {
      const result = await compact(messages, {
        model: this.model, streamFn: this.compactionStreamFn, keepRecentTokens: this.options.keepRecentTokens ?? KEEP_RECENT_TOKENS,
        ...(signal ? { signal } : {}),
      });
      const cost = this.compactionTracker.takeCost({ usage: result.usage, ...(result.responseId ? { responseId: result.responseId } : {}) });
      if (cost) {
        await this.options.state.recordUsage({
          kind: "agent", provider: "openrouter", model: this.options.modelId, label: "Context compaction",
          costUsd: cost.costUsd, estimated: cost.estimated,
          inputTokens: result.usage.input, cachedInputTokens: result.usage.cacheRead,
          cacheWriteTokens: result.usage.cacheWrite, outputTokens: result.usage.output,
        });
      }
      await this.options.session.appendCompaction({
        summaryMessage: result.summaryMessage, keptCount: result.keptMessages.length, tokensBefore: result.tokensBefore,
      });
      // The newest editor state may have been summarized away; send it again on the next turn.
      this.sync.syncFromTranscript([]);
      this.emit({
        type: "compaction", phase: "end", tokensBefore: result.tokensBefore,
        tokensAfter: estimateContextTokens(result.messages as Message[]).tokens,
      });
      return result;
    } catch (error) {
      if (!(error instanceof NothingToCompactError)) {
        this.emit({ type: "error", message: `Context compaction failed: ${errorText(error)}`, retryable: true });
      }
      this.emit({ type: "compaction", phase: "end" });
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Tools, approvals, choices
  // ---------------------------------------------------------------------------------------------

  private toolFor(action: Action<any>): AgentTool<any> {
    return toolFromJsonSchema<Record<string, unknown>, ToolDetails>({
      name: action.name,
      description: action.description,
      jsonSchema: action.schema,
      strict: true,
      execute: async (_callId, args, signal, onUpdate) => {
        const progress = (update: ActionProgress) => onUpdate?.({
          content: [{ type: "text", text: update.stage }],
          details: { summary: update.stage, stage: update.stage, ...(update.fraction === undefined ? {} : { fraction: update.fraction }) } as ToolDetails,
        });
        return toToolResult(await this.options.registry.run(action.name, args, this.contextFor(signal, progress)));
      },
    });
  }

  private contextFor(signal: AbortSignal | undefined, progress: (update: ActionProgress) => void): ActionContext {
    return {
      state: this.options.state,
      settings: this.options.getSettings(),
      signal: signal ?? this.run?.controller.signal ?? new AbortController().signal,
      request: this.run?.request ?? "",
      progress,
      requestChoice: (request) => this.askChoice(request, signal),
    };
  }

  private askApproval(request: Omit<Extract<EngineEvent, { type: "approval_request" }>, "type" | "id">, signal?: AbortSignal): Promise<ApprovalDecision> {
    const id = randomUUID();
    return new Promise<ApprovalDecision>((resolve) => {
      if (signal?.aborted) { resolve("deny"); return; }
      this.approvals.set(id, resolve);
      signal?.addEventListener("abort", () => { this.approvals.delete(id); resolve("deny"); }, { once: true });
      this.emit({ type: "approval_request", id, ...request });
    });
  }

  private askChoice(request: ChoiceRequest, signal?: AbortSignal): Promise<string | null> {
    const id = randomUUID();
    return new Promise<string | null>((resolve) => {
      if (signal?.aborted) { resolve(null); return; }
      this.choices.set(id, resolve);
      signal?.addEventListener("abort", () => { this.choices.delete(id); resolve(null); }, { once: true });
      this.emit({ type: "choice_request", id, question: request.question, options: request.options, allowCustom: request.allowCustom });
    });
  }

  private safeRisk(name: string, args: unknown): Risk {
    try { return this.options.registry.riskOf(name, args); } catch { return "read"; }
  }

  private safeDescribe(name: string, args: unknown): string {
    try { return this.options.registry.describe(name, args); } catch { return name; }
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function toToolResult(result: ActionResult): AgentToolResult<ToolDetails> {
  let text = result.data ? `${result.text}\n${JSON.stringify(result.data)}` : result.text;
  if (text.length > MAX_TOOL_TEXT) text = `${text.slice(0, MAX_TOOL_TEXT)}\n[... ${text.length - MAX_TOOL_TEXT} more characters truncated]`;
  const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
  for (const image of result.images ?? []) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  return { content, details: { summary: result.text.slice(0, 200), ...(result.versionId ? { versionId: result.versionId } : {}) } };
}

function ceilingOf(settings: DumbEditorSettings): number {
  return settings.agent.spendCeilingUsd > 0 ? settings.agent.spendCeilingUsd : Number.POSITIVE_INFINITY;
}

function textOf(message: AssistantMessage): string {
  return message.content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("").trim();
}

function textOfResult(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
  return content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("").slice(0, 200);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One user message carrying recent chat, so a project from before agent sessions keeps its context. */
export function seedMessage(chat: readonly ChatMessage[]): AgentMessage | undefined {
  const lines: string[] = [];
  let budget = 8_000;
  for (const message of chat.slice(-20).reverse()) {
    const line = `[${message.role === "user" ? "User" : "Assistant"}]: ${message.content.slice(0, 600)}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.unshift(line);
  }
  if (lines.length === 0) return undefined;
  return { role: "user", content: `<previous_conversation>\n${lines.join("\n")}\n</previous_conversation>`, timestamp: Date.now() };
}
```

Add the spend limit to settings (the Claude fields stay until Task 7):

Apply this change to `src/core/settings.ts`:

```diff
--- a/src/core/settings.ts
+++ b/src/core/settings.ts
@@ -9,6 +9,7 @@
 export type ModelSlot = OpenRouterSlot | OpenAISlot;
 export type ModelProvider = "openai" | "openrouter";
 export type AgentPermissionMode = "ask" | "auto";
+export const MAX_SPEND_CEILING_USD = 1000;
 
 export interface DumbEditorSettings {
   schemaVersion: 1;
@@ -18,6 +19,8 @@
     permissionMode: AgentPermissionMode;
     claudeModel: string;
     claudeMaxBudgetUsd: number;
+    /** Pause and ask to continue when one agent run has spent this much. 0 disables the limit. */
+    spendCeilingUsd: number;
   };
   models: {
     openai: Record<OpenAISlot, string>;
@@ -33,6 +36,7 @@
     permissionMode: "ask",
     claudeModel: "claude-sonnet-4-6",
     claudeMaxBudgetUsd: 0.5,
+    spendCeilingUsd: 5,
   },
   models: {
     openai: {
@@ -101,6 +105,14 @@
   return settings;
 }
 
+export async function setSpendCeiling(usd: number): Promise<DumbEditorSettings> {
+  if (!Number.isFinite(usd) || usd < 0 || usd > MAX_SPEND_CEILING_USD) throw new Error(`The spend limit must be between 0 and ${MAX_SPEND_CEILING_USD} dollars (0 turns it off).`);
+  const settings = await readSettings();
+  settings.agent.spendCeilingUsd = usd;
+  await writeSettings(settings);
+  return settings;
+}
+
 export async function setClaudeHarnessModel(model: string): Promise<DumbEditorSettings> {
   const value = cleanModel(model, "");
   if (!value) throw new Error("Claude model IDs cannot be empty or contain spaces.");
@@ -129,6 +141,7 @@
       permissionMode: raw.agent?.permissionMode === "auto" ? "auto" : "ask",
       claudeModel: cleanModel(raw.agent?.claudeModel, DEFAULT_SETTINGS.agent.claudeModel),
       claudeMaxBudgetUsd: finiteBudget(raw.agent?.claudeMaxBudgetUsd, DEFAULT_SETTINGS.agent.claudeMaxBudgetUsd),
+      spendCeilingUsd: spendCeiling(raw.agent?.spendCeilingUsd, DEFAULT_SETTINGS.agent.spendCeilingUsd),
     },
     models: {
       openai: {
@@ -147,6 +160,10 @@
   };
 }
 
+function spendCeiling(value: unknown, fallback: number): number {
+  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SPEND_CEILING_USD ? value : fallback;
+}
+
 function finiteBudget(value: unknown, fallback: number): number {
   return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 20 ? value : fallback;
 }
```

Apply this change to `package.json`:

```diff
--- a/package.json
+++ b/package.json
@@ -17,7 +17,7 @@
     "build": "tsup",
     "check": "tsc --noEmit",
     "dev": "tsx src/cli.tsx",
-    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/luna.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/transcription.test.js",
+    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/luna.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/transcription.test.js",
     "quality": "npm run check && npm test && npm run build",
     "release:check": "npm run quality && npm pack --dry-run",
     "prepublishOnly": "npm run quality"
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js
```

Expected: 22 passed, 1 skipped (the live test). Then `npm test`:

Expected: undefined tests with 0 failed (one is skipped: the live test).

Optional, needs a key and spends a fraction of a cent. Run it once before relying on real cost reporting:

```bash
DUMBEDITOR_LIVE_TEST=1 OPENROUTER_API_KEY=sk-or-... node --test .test-dist/tests/live-openrouter.test.js
```

If it fails on `cost.estimated`, OpenRouter's usage chunk differs from the documented shape: fix `readUsageCost` in `src/core/pi/cost.ts` and add the real chunk to `tests/pi-layer.test.ts`. Set `DUMBEDITOR_LIVE_MODEL=anthropic/claude-haiku-4.5` to check the Anthropic-compatible path, which the spike could not verify offline.

- [ ] **Step 5: Commit**

```bash
git add src tests package.json
git commit -m "feat: add the agent engine with approvals, audit rule, compaction and spend limit"
```

## Task 7: Cut over: the UI becomes a client of the engine and the old loop goes

This is the one task that changes what a user sees. Everything before it added code beside the old agent; this task switches the app to the engine and deletes the old loop, the Claude harness and the OpenAI-first setup. The unit-testable parts (model picker, settings) are test-first; the Ink behaviour is verified by the manual checklist in Step 9, because the repository has no terminal UI test harness.

**Files:**
- Modify: `src/ui/App.tsx`, `src/ui/ApprovalPanel.tsx` (replaced), `src/ui/Help.tsx`, `src/ui/ModelPanel.tsx`, `src/cli.tsx`, `src/core/config.ts`, `src/core/settings.ts`, `tests/model-picker.test.ts`, `README.md`, `package.json`, `package-lock.json` (by npm)
- Delete: `src/core/agent-runtime.ts`, `src/core/luna-agent.ts`, `src/core/claude-harness.ts`, `src/core/approval.ts`, `tests/luna.test.ts`

**Interfaces:**
- Consumes: `Engine`, `EngineEvent`, `ApprovalDecision` (Task 6), `createEditorRegistry`, `directEditCall`, `ActionContext` (Task 4), `EditorState` (Task 3), `SessionStore` (Task 5), `createEditorModels` (Task 2), `loadAgentSkills`, `setSpendCeiling`.
- Produces: streaming chat with `▸`/`✓`/`✗` tool lines; Enter while the agent works steers it; Esc (empty input) and Ctrl+C stop it; approval popup with `Allow once` / `Allow this session` / `Deny` (or `Continue` / `Stop` at the spend limit); `/budget [USD]` and `/compact`; sessions that resume; `settings.agent.provider` is always `"openrouter"`; `ApprovalPanel` exports `approvalOptions(request)` and `approvalDecision(request, index)`.

- [ ] **Step 1: Write the failing test for the OpenRouter-only base agent**

Apply this change to `tests/model-picker.test.ts`:

```diff
--- a/tests/model-picker.test.ts
+++ b/tests/model-picker.test.ts
@@ -9,14 +9,14 @@
   { id: "openai/gpt-image", name: "OpenAI Image" },
 ];
 
-test("opens the model picker at capability selection with a provider-diverse base agent", () => {
+test("opens the model picker at capability selection with an OpenRouter-only base agent", () => {
   const picker = initialModelPicker();
   assert.equal(picker.step, "capability");
   assert.equal(picker.capability, "agent");
   assert.equal(picker.selectedIndex, 0);
   assert.equal(picker.query, "");
   assert.equal(MODEL_CAPABILITIES[0]?.label, "Base agent");
-  assert.deepEqual(capabilityDefinition("agent").providers, ["openai", "openrouter"]);
+  assert.deepEqual(capabilityDefinition("agent").providers, ["openrouter"]);
   assert.deepEqual(capabilityDefinition("video").providers, ["openrouter"]);
 });
 
```

```bash
npx tsc -p tsconfig.test.json && node --test .test-dist/tests/model-picker.test.js
```

Expected: FAIL: `Expected values to be deeply strictly equal: [ 'openai', 'openrouter' ] should equal [ 'openrouter' ]`.

- [ ] **Step 2: Delete the old agent**

```bash
git rm src/core/agent-runtime.ts src/core/luna-agent.ts src/core/claude-harness.ts src/core/approval.ts tests/luna.test.ts
```

(The project no longer compiles until Step 6; that is expected.)

- [ ] **Step 3: Make settings OpenRouter-only**

Remove the Claude harness fields, force the agent provider to OpenRouter, and keep the spend limit added in Task 6:

Apply this change to `src/core/settings.ts`:

```diff
--- a/src/core/settings.ts
+++ b/src/core/settings.ts
@@ -15,10 +15,9 @@
   schemaVersion: 1;
   welcomeShown: boolean;
   agent: {
+    /** Always "openrouter": the agent runs on OpenRouter only. */
     provider: ModelProvider;
     permissionMode: AgentPermissionMode;
-    claudeModel: string;
-    claudeMaxBudgetUsd: number;
     /** Pause and ask to continue when one agent run has spent this much. 0 disables the limit. */
     spendCeilingUsd: number;
   };
@@ -32,10 +31,8 @@
   schemaVersion: 1,
   welcomeShown: false,
   agent: {
-    provider: "openai",
+    provider: "openrouter",
     permissionMode: "ask",
-    claudeModel: "claude-sonnet-4-6",
-    claudeMaxBudgetUsd: 0.5,
     spendCeilingUsd: 5,
   },
   models: {
@@ -89,6 +86,7 @@
 }
 
 export async function setBaseAgentModel(provider: ModelProvider, model: string): Promise<DumbEditorSettings> {
+  if (provider !== "openrouter") throw new Error("The editor agent runs on OpenRouter only.");
   const value = model.trim();
   if (!value || value.length > 200 || /\s/.test(value)) throw new Error("Model IDs cannot be empty or contain spaces.");
   const settings = await readSettings();
@@ -113,15 +111,6 @@
   return settings;
 }
 
-export async function setClaudeHarnessModel(model: string): Promise<DumbEditorSettings> {
-  const value = cleanModel(model, "");
-  if (!value) throw new Error("Claude model IDs cannot be empty or contain spaces.");
-  const settings = await readSettings();
-  settings.agent.claudeModel = value;
-  await writeSettings(settings);
-  return settings;
-}
-
 /** Returns true only for the first no-argument launch. */
 export async function markWelcomeShown(): Promise<boolean> {
   const settings = await readSettings();
@@ -137,10 +126,8 @@
     schemaVersion: 1,
     welcomeShown: raw.welcomeShown === true,
     agent: {
-      provider: raw.agent?.provider === "openrouter" ? "openrouter" : "openai",
+      provider: "openrouter",
       permissionMode: raw.agent?.permissionMode === "auto" ? "auto" : "ask",
-      claudeModel: cleanModel(raw.agent?.claudeModel, DEFAULT_SETTINGS.agent.claudeModel),
-      claudeMaxBudgetUsd: finiteBudget(raw.agent?.claudeMaxBudgetUsd, DEFAULT_SETTINGS.agent.claudeMaxBudgetUsd),
       spendCeilingUsd: spendCeiling(raw.agent?.spendCeilingUsd, DEFAULT_SETTINGS.agent.spendCeilingUsd),
     },
     models: {
@@ -164,10 +151,6 @@
   return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SPEND_CEILING_USD ? value : fallback;
 }
 
-function finiteBudget(value: unknown, fallback: number): number {
-  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 20 ? value : fallback;
-}
-
 function cleanModel(value: unknown, fallback: string): string {
   return typeof value === "string" && value.trim() && !/\s/.test(value) ? value.trim() : fallback;
 }
```

Apply this change to `src/ui/ModelPanel.tsx`:

```diff
--- a/src/ui/ModelPanel.tsx
+++ b/src/ui/ModelPanel.tsx
@@ -14,7 +14,7 @@
 }
 
 export const MODEL_CAPABILITIES: CapabilityDefinition[] = [
-  { id: "agent", label: "Base agent", detail: "plans edits and runs tools", slot: "text", providers: ["openai", "openrouter"] },
+  { id: "agent", label: "Base agent", detail: "plans edits and runs tools", slot: "text", providers: ["openrouter"] },
   { id: "image", label: "Image", detail: "generated overlays and artwork", slot: "image", providers: ["openrouter"] },
   { id: "audio", label: "Audio", detail: "generated sound and speech", slot: "audio", providers: ["openrouter"] },
   { id: "music", label: "Music", detail: "generated background music", slot: "music", providers: ["openrouter"] },
```

- [ ] **Step 4: Replace the approval panel**

Replace the whole file `src/ui/ApprovalPanel.tsx` with:

```tsx
import { Box, Text } from "ink";
import type { ApprovalDecision, EngineEvent } from "../core/engine/events.js";

export type ApprovalView = Extract<EngineEvent, { type: "approval_request" }>;

/** Choices shown for a request, last one being the safe default. */
export function approvalOptions(request: ApprovalView): string[] {
  return request.kind === "budget" ? ["Continue", "Stop"] : ["Allow once", "Allow this session", "Deny"];
}

export function approvalDecision(request: ApprovalView, index: number): ApprovalDecision {
  if (request.kind === "budget") return index === 0 ? "once" : "deny";
  return (["once", "session", "deny"] as const)[index] ?? "deny";
}

const RISK_NOTE: Record<string, string> = {
  spend: "This can spend money with a model provider.",
  code: "This runs custom FFmpeg or a script the agent wrote.",
};

export function ApprovalPanel(props: { request: ApprovalView; options: string[]; selectedIndex: number; width: number; height: number }) {
  const { request } = props;
  const args = request.args === undefined ? null : JSON.stringify(request.args);
  return (
    <Box width={props.width} height={props.height} justifyContent="center" alignItems="center">
      <Box width={Math.min(86, props.width - 4)} flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={2} paddingY={1}>
        <Text bold color="yellow">{request.kind === "budget" ? "Spend limit reached" : "Permission required"}</Text>
        <Text bold wrap="wrap">{request.summary}</Text>
        {RISK_NOTE[request.risk] && <Text wrap="wrap">{RISK_NOTE[request.risk]}</Text>}
        {args && <Text dimColor wrap="truncate-end">Arguments: {args}</Text>}
        <Text> </Text>
        <Box gap={2}>
          {props.options.map((option, index) => (
            <Text key={option} inverse={index === props.selectedIndex} {...(index === props.selectedIndex ? { color: index === props.options.length - 1 ? "red" as const : "green" as const } : {})}> {option} </Text>
          ))}
        </Box>
        <Text dimColor>←/→ or Tab chooses · Enter confirms · Esc denies</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 5: Setup, help text and CLI reference**

`dumbeditor setup` now requires an OpenRouter key and treats the OpenAI key (speech and transcription only) as optional; the Anthropic prompt is gone.

Apply this change to `src/core/config.ts`:

```diff
--- a/src/core/config.ts
+++ b/src/core/config.ts
@@ -22,20 +22,17 @@
   const saved = await readSavedConfig();
   process.stdout.write("DumbEditor setup\nKeys stay in your local user config and are never printed.\n\n");
 
-  const openai = await promptSecret(`OpenAI API key${saved.OPENAI_API_KEY ? " (Enter keeps saved key)" : ""}: `);
-  const openaiKey = openai || saved.OPENAI_API_KEY;
-  if (!openaiKey) throw new Error("An OpenAI API key is required.");
+  const openrouter = await promptSecret(`OpenRouter API key${saved.OPENROUTER_API_KEY ? " (Enter keeps saved key)" : ""}: `);
+  const openrouterKey = openrouter || saved.OPENROUTER_API_KEY;
+  if (!openrouterKey) throw new Error("An OpenRouter API key is required.");
 
-  const openrouter = await promptSecret(`OpenRouter API key (optional)${saved.OPENROUTER_API_KEY ? " (Enter keeps saved key; - removes it)" : " (Enter skips)"}: `);
-  const openrouterKey = openrouter === "-" ? "" : (openrouter || saved.OPENROUTER_API_KEY || "");
-  const anthropic = await promptSecret(`Anthropic API key for optional Claude harness${saved.ANTHROPIC_API_KEY ? " (Enter keeps saved key; - removes it)" : " (optional; Enter skips)"}: `);
-  const anthropicKey = anthropic === "-" ? "" : (anthropic || saved.ANTHROPIC_API_KEY || "");
+  const openai = await promptSecret(`OpenAI API key for speech transcription and text to speech (optional)${saved.OPENAI_API_KEY ? " (Enter keeps saved key; - removes it)" : " (Enter skips)"}: `);
+  const openaiKey = openai === "-" ? "" : (openai || saved.OPENAI_API_KEY || "");
 
   const lines = [
     "# DumbEditor user configuration",
-    `OPENAI_API_KEY=${JSON.stringify(openaiKey)}`,
-    ...(openrouterKey ? [`OPENROUTER_API_KEY=${JSON.stringify(openrouterKey)}`] : []),
-    ...(anthropicKey ? [`ANTHROPIC_API_KEY=${JSON.stringify(anthropicKey)}`] : []),
+    `OPENROUTER_API_KEY=${JSON.stringify(openrouterKey)}`,
+    ...(openaiKey ? [`OPENAI_API_KEY=${JSON.stringify(openaiKey)}`] : []),
     "",
   ];
   await mkdir(dirname(userConfigPath), { recursive: true });
@@ -49,11 +46,10 @@
     : `Agent sandbox unavailable: ${sandbox.detail}\nRun dumbeditor setup again to enable isolated scripts.\n`);
 }
 
-export function providerKeyStatus(): { openai: boolean; openrouter: boolean; anthropic: boolean } {
+export function providerKeyStatus(): { openai: boolean; openrouter: boolean } {
   return {
     openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
     openrouter: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
-    anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
   };
 }
 
```

Apply this change to `src/ui/Help.tsx`:

```diff
--- a/src/ui/Help.tsx
+++ b/src/ui/Help.tsx
@@ -10,9 +10,10 @@
       <Text>/open path  /projects  /version [all]  /revert id  /undo</Text>
       <Text>/export [path] popup  /version-limits [N]  /model model picker</Text>
       <Text>/bg-music music browser  /assets asset browser  (also Ctrl+O)</Text>
-      <Text>/permissions [ask|auto]  /harness-model [MODEL]</Text>
+      <Text>/permissions [ask|auto]  /budget [USD]  /compact</Text>
       <Text dimColor>Type / for commands, use ↑/↓ to choose, and Tab to complete.</Text>
       <Text dimColor>↑/↓ scroll chat, PgUp/PgDn move a page, Ctrl+G expands chat.</Text>
+      <Text dimColor>While the agent works: Enter sends a message that steers it, Esc stops it.</Text>
       <Text dimColor>Ask {model} normally: “remove the first two seconds and the last ten”.</Text>
       <Text dimColor>Esc closes this panel</Text>
     </Box>
```

Apply this change to `src/cli.tsx`:

```diff
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -162,8 +162,8 @@
   [ / ]          Mark selection in / out
   Tab            Complete the selected slash command
   Enter          Send a request or complete a slash command
-  Esc            Minimize chat, close a panel, or clear the input
-  Ctrl+C         Quit
+  Esc            Stop the agent, minimize chat, close a panel, or clear the input
+  Ctrl+C         Stop the agent while it works; otherwise quit
   Ctrl+O         Open or close the project asset browser
 
 Editor commands:
@@ -183,7 +183,8 @@
   /bg-music [query]  Search, preview, and select open-license music
   /assets            Browse generated and project assets
   /permissions [mode] Show or set ask/auto approval mode
-  /harness-model [id] Show or set the optional Claude harness model
+  /budget [USD]       Show or set the per-run spend limit (0 turns it off)
+  /compact            Summarize earlier conversation to free context
   /status            Show project details
   /play              Play the preview
   /pause             Pause the preview
```

- [ ] **Step 6: Switch `App.tsx` to the engine**

The change is mechanical but large. It does these things, in order: imports; state for the editor, the engine and the running flag; mirroring playhead, marks and version changes into `EditorState`; replacing the approval and choice promises with engine events; `handleEngineEvent` (streaming text, tool lines, approvals, choices, compaction, run end); `createEngine` (null without an OpenRouter key); `openVideo` creating the state and the engine; slash commands going through the registry (`applyEdit`, `changeVersion`); `/budget` and `/compact`; slash commands other than a safe few waiting while the agent works; `submit` steering or starting a run; Ctrl+C and Esc stopping the agent; the footer text.

Apply this change to `src/ui/App.tsx`:

```diff
--- a/src/ui/App.tsx
+++ b/src/ui/App.tsx
@@ -1,29 +1,33 @@
 import { useCallback, useEffect, useMemo, useRef, useState } from "react";
-import { extname, resolve } from "node:path";
+import { extname, join, resolve } from "node:path";
 import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
 import type { ChildProcess } from "node:child_process";
 import type { ChatMessage, DirectEdit, MediaInfo, Selection } from "../types.js";
-import { AgentWorkspace, type AgentAsset } from "../core/agent-workspace.js";
-import type { ApprovalRequest, RequestApproval } from "../core/approval.js";
-import type { ChoiceRequest, RequestChoice } from "../core/choice.js";
-import { runEditorAgent } from "../core/agent-runtime.js";
+import type { AgentAsset } from "../core/agent-workspace.js";
+import { createEditorRegistry, directEditCall, type ActionContext } from "../core/actions/index.js";
+import { loadAgentSkills } from "../core/agent-skills.js";
 import { commandSuggestions, parseEditCommand } from "../core/commands.js";
 import { providerKeyStatus } from "../core/config.js";
-import { executeDirectEdit } from "../core/editor.js";
+import { Engine } from "../core/engine/engine.js";
+import type { ApprovalDecision, EngineEvent } from "../core/engine/events.js";
 import { EXPORT_FORMATS, EXPORT_PRESETS, exportDestination, exportVideo, type ExportFormat } from "../core/export.js";
-import { playAudio, probeMedia } from "../core/media.js";
+import { playAudio } from "../core/media.js";
 import { listMusicTracks, searchMusicTracks } from "../core/music-catalog.js";
 import { clearMusicSelection, MusicPreviewController, readMusicSelection, selectMusicTrack } from "../core/music.js";
 import { listProviderModels } from "../core/models.js";
+import { createEditorModels } from "../core/pi/models.js";
 import { ProjectStore, type ProjectSummary } from "../core/project.js";
 import { terminateProcess, terminateRunningProcesses } from "../core/process.js";
-import { DEFAULT_SETTINGS, readSettings, setAgentPermissionMode, setBaseAgentModel, setClaudeHarnessModel, setDefaultModel, type DumbEditorSettings, type ModelProvider, type ModelSlot } from "../core/settings.js";
+import { SessionStore } from "../core/session/session-store.js";
+import { DEFAULT_SETTINGS, readSettings, setAgentPermissionMode, setBaseAgentModel, setDefaultModel, setSpendCeiling, type DumbEditorSettings, type ModelProvider, type ModelSlot } from "../core/settings.js";
+import { EditorState } from "../core/state/editor-state.js";
 import { formatTime } from "../core/time.js";
 import { EMPTY_USAGE_SUMMARY, formatUsd, type UsageSummary } from "../core/usage.js";
 import { AssetPanel } from "./AssetPanel.js";
 import { ChatPanel } from "./ChatPanel.js";
-import { ApprovalPanel } from "./ApprovalPanel.js";
+import { ApprovalPanel, approvalDecision, approvalOptions, type ApprovalView } from "./ApprovalPanel.js";
 import { ChoicePanel, type ChoicePanelState } from "./ChoicePanel.js";
+import type { ChoiceRequest } from "../core/choice.js";
 import { Help } from "./Help.js";
 import { History } from "./History.js";
 import { InputPanel } from "./InputPanel.js";
@@ -43,6 +47,8 @@
 type Overlay = "help" | "history" | "model" | "music" | "export" | "assets" | "projects" | "approval" | "choice" | null;
 interface LoaderState { source: string; stage: string }
 const LOADER_MARK = "◐";
+/** Commands that cannot disturb a running agent; everything else waits until it finishes or is stopped. */
+const SAFE_DURING_RUN = new Set(["/help", "/chat", "/status", "/clear", "/play", "/pause", "/quit", "/exit", "/permissions", "/budget", "/version", "/versions", "/assets"]);
 
 export function App({ initialPath }: { initialPath?: string }) {
   const { exit } = useApp();
@@ -71,18 +77,28 @@
   const [assetPlaying, setAssetPlaying] = useState(false);
   const [projects, setProjects] = useState<ProjectSummary[]>([]);
   const [projectIndex, setProjectIndex] = useState(0);
-  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
-  const [approvalAllow, setApprovalAllow] = useState(false);
-  const approvalResolver = useRef<((allowed: boolean) => void) | null>(null);
-  const [choice, setChoice] = useState<ChoiceRequest | null>(null);
+  const [approval, setApproval] = useState<ApprovalView | null>(null);
+  const [approvalIndex, setApprovalIndex] = useState(0);
+  const [choice, setChoice] = useState<(ChoiceRequest & { id: string }) | null>(null);
   const [choicePanel, setChoicePanel] = useState<ChoicePanelState>({ selectedIndex: 0, customActive: false, customText: "", customCursor: 0 });
-  const choiceResolver = useRef<((answer: string | null) => void) | null>(null);
+  const [editor, setEditor] = useState<EditorState | null>(null);
+  const [engine, setEngine] = useState<Engine | null>(null);
+  const [agentRunning, setAgentRunning] = useState(false);
+  const registry = useMemo(() => createEditorRegistry(), []);
+  const modelsRef = useRef<ReturnType<typeof createEditorModels> | null>(null);
+  const liveMessage = useRef<{ id: string; text: string; timer: NodeJS.Timeout | null } | null>(null);
   const [previewRefresh, setPreviewRefresh] = useState(0);
   const assetPreview = useRef<ChildProcess | null>(null);
   const [overlay, setOverlayState] = useState<Overlay>(null);
   const [showAllHistory, setShowAllHistory] = useState(false);
   const [settings, setSettings] = useState<DumbEditorSettings>(() => structuredClone(DEFAULT_SETTINGS));
   const [settingsReady, setSettingsReady] = useState(false);
+  const settingsRef = useRef(settings);
+  settingsRef.current = settings;
+  const engineRef = useRef(engine);
+  engineRef.current = engine;
+  const projectRef = useRef(project);
+  projectRef.current = project;
   const [modelPicker, setModelPicker] = useState<ModelPickerState>(initialModelPicker);
   const [modelOverlayReady, setModelOverlayReady] = useState(false);
   const modelRequest = useRef(0);
@@ -103,7 +119,8 @@
     setOverlayState(next);
   }, []);
 
-  const busy = loader !== null;
+  // A running agent shows its stage in the header but must not block typing: text sent now steers it.
+  const busy = loader !== null && !agentRunning;
   const videoMutationActive = loader !== null && isVideoMutationStage(loader.stage);
   const previewBackend = useMemo(() => activePreviewBackend(), []);
   const inputMetrics = useMemo(() => inputViewport(input, inputCursor, Math.max(8, terminal.columns - 6)), [input, inputCursor, terminal.columns]);
@@ -111,7 +128,9 @@
   const suggestions = useMemo(() => commandSuggestions(input), [input]);
   const musicTracks = useMemo(() => musicQuery.trim() ? searchMusicTracks(musicQuery) : listMusicTracks(), [musicQuery]);
   const currentFile = project?.current.filePath;
-  const agentModel = settingsReady ? settings.models[settings.agent.provider].text : "editor model";
+  const agentModel = settingsReady ? settings.models.openrouter.text : "editor model";
+  const agentModelRef = useRef(agentModel);
+  agentModelRef.current = agentModel;
   const controlsHint = terminal.columns >= 120
     ? `${previewBackend.toUpperCase()} · Ctrl+P play · ←/→ 5s · +/- volume · ↑/↓ chat · Ctrl+G focus`
     : "Ctrl+P play · +/- volume · ↑/↓ chat · Ctrl+G focus";
@@ -130,7 +149,7 @@
 
   useEffect(() => { setSuggestionIndex(0); }, [input]);
   useEffect(() => { setChatScrollRows(0); }, [messages.length]);
-  useEffect(() => () => { musicPreview.current?.dispose(); terminateProcess(assetPreview.current); terminateRunningProcesses(); }, []);
+  useEffect(() => () => { engineRef.current?.abort(); musicPreview.current?.dispose(); terminateProcess(assetPreview.current); terminateRunningProcesses(); }, []);
   useEffect(() => {
     void readSettings()
       .then((value) => { setSettings(value); setSettingsReady(true); })
@@ -165,6 +184,21 @@
     };
   }, [stdin, stdout]);
 
+  // Mirror what the user does into the shared editor state so the agent sees the same playhead and marks.
+  useEffect(() => { editor?.setPlayhead(currentTime); }, [currentTime, editor]);
+  useEffect(() => { editor?.setSelection(selection); }, [selection, editor]);
+  useEffect(() => {
+    if (!editor) return;
+    let activeVersion = editor.store.current.id;
+    return editor.subscribe(() => {
+      setMedia(editor.media); setUsage(editor.usage); setAssets([...editor.assets]); setRevision((value) => value + 1);
+      if (editor.store.current.id !== activeVersion) {
+        activeVersion = editor.store.current.id;
+        currentTimeRef.current = editor.playhead; setCurrentTime(editor.playhead); setSelection(editor.selection);
+      }
+    });
+  }, [editor]);
+
   const movePlayhead = useCallback((next: number) => {
     if (!media) return;
     const value = Math.max(0, Math.min(media.duration, next));
@@ -203,45 +237,122 @@
     setAssetIndex(Math.max(0, assets.length - 1));
     setOverlay("assets");
   }, [assets.length, stopAssetPlayback]);
-  const requestApproval = useCallback<RequestApproval>((request) => new Promise<boolean>((resolve) => {
-    approvalResolver.current?.(false);
-    approvalResolver.current = resolve;
-    setApproval(request);
-    setApprovalAllow(false);
-    setOverlay("approval");
-  }), []);
-  const resolveApproval = useCallback((allowed: boolean) => {
-    const resolve = approvalResolver.current;
-    approvalResolver.current = null;
+  const resolveApproval = useCallback((decision: ApprovalDecision) => {
+    if (approval) engineRef.current?.resolveApproval(approval.id, decision);
     setApproval(null);
-    setApprovalAllow(false);
     setOverlay(null);
-    resolve?.(allowed);
-  }, []);
-  const requestChoice = useCallback<RequestChoice>((request) => new Promise<string | null>((resolve) => {
-    choiceResolver.current?.(null);
-    choiceResolver.current = resolve;
-    setChoice(request);
-    setChoicePanel({ selectedIndex: 0, customActive: false, customText: "", customCursor: 0 });
-    setOverlay("choice");
-  }), []);
+  }, [approval, setOverlay]);
   const resolveChoice = useCallback((answer: string | null) => {
-    const resolve = choiceResolver.current;
-    choiceResolver.current = null;
+    if (choice) engineRef.current?.resolveChoice(choice.id, answer);
     setChoice(null);
     setOverlay(null);
-    resolve?.(answer);
-  }, []);
+  }, [choice, setOverlay]);
 
-  const refreshProjectData = useCallback(async (store: ProjectStore) => {
-    const workspace = new AgentWorkspace(store.createAgentWorkspace());
-    const [nextAssets, nextUsage] = await Promise.all([workspace.assets(), store.usageSummary()]);
-    setAssets(nextAssets);
-    setUsage(nextUsage);
-    setAssetIndex((value) => Math.max(0, Math.min(value, nextAssets.length - 1)));
-  }, []);
+  /** Show the agent working: stream text, list tool calls, and surface approvals and choices. */
+  const handleEngineEvent = useCallback((event: EngineEvent) => {
+    const label = agentModelRef.current;
+    const flushLive = () => {
+      const live = liveMessage.current;
+      if (!live) return;
+      if (live.timer) { clearTimeout(live.timer); live.timer = null; }
+      setMessages((items) => items.map((item) => item.at === live.id ? { ...item, content: live.text } : item));
+    };
+    switch (event.type) {
+      case "run_start":
+        setAgentRunning(true); setLoader({ source: label, stage: "Thinking" });
+        break;
+      case "text_delta": {
+        let live = liveMessage.current;
+        if (!live) {
+          const id = `live-${Date.now()}-${Math.random().toString(36).slice(2)}`;
+          live = { id, text: "", timer: null };
+          liveMessage.current = live;
+          setMessages((items) => [...items, { role: "assistant", content: "", at: id, label }]);
+        }
+        live.text += event.text;
+        setLoader((current) => current?.stage === "Writing response" ? current : { source: label, stage: "Writing response" });
+        if (!live.timer) {
+          const target = live;
+          live.timer = setTimeout(() => {
+            target.timer = null;
+            setMessages((items) => items.map((item) => item.at === target.id ? { ...item, content: target.text } : item));
+            setChatScrollRows(0);
+          }, 80);
+        }
+        break;
+      }
+      case "tool_start":
+        flushLive(); liveMessage.current = null;
+        addUiMessage("assistant", `▸ ${event.summary}`, "tool");
+        setLoader({ source: event.name === "run_sandbox_script" ? "Sandbox" : label, stage: event.summary });
+        break;
+      case "tool_progress":
+        setLoader((current) => ({ source: current?.source ?? label, stage: event.stage }));
+        break;
+      case "tool_end":
+        addUiMessage("assistant", `${event.ok ? "✓" : "✗"} ${event.summary}`, "tool");
+        break;
+      case "approval_request":
+        setApproval(event); setApprovalIndex(approvalOptions(event).length - 1); setOverlay("approval");
+        break;
+      case "choice_request":
+        setChoice({ id: event.id, question: event.question, options: event.options, allowCustom: event.allowCustom });
+        setChoicePanel({ selectedIndex: 0, customActive: false, customText: "", customCursor: 0 });
+        setOverlay("choice");
+        break;
+      case "steer_queued":
+        setStatus("Queued · the agent will read it after its current step");
+        break;
+      case "compaction":
+        if (event.phase === "start") setLoader((current) => ({ source: current?.source ?? label, stage: "Compacting conversation" }));
+        else if (event.tokensBefore !== undefined) addUiMessage("assistant", `Compacted earlier conversation (${event.tokensBefore} → ${event.tokensAfter ?? 0} tokens).`, "editor");
+        break;
+      case "error":
+        addUiMessage("assistant", event.message, "error");
+        break;
+      case "run_end": {
+        flushLive();
+        const live = liveMessage.current;
+        liveMessage.current = null;
+        setAgentRunning(false); setLoader(null); setApproval(null); setChoice(null);
+        setOverlayState((current) => current === "approval" || current === "choice" ? null : current);
+        if (event.reason === "done" && event.message) {
+          if (!live || live.text.trim() !== event.message.trim()) addUiMessage("assistant", event.message, label);
+          void projectRef.current?.addChat("assistant", event.message, label);
+        }
+        if (event.reason === "aborted") addUiMessage("assistant", "Stopped.", "editor");
+        if (event.reason === "budget") addUiMessage("assistant", "Stopped at the spend limit. Raise it with /budget.", "editor");
+        setStatus(event.reason === "done" ? `${label} · done` : event.reason === "error" ? `${label} request failed` : "Stopped");
+        break;
+      }
+      default:
+        break;
+    }
+  }, [addUiMessage, setOverlay]);
+  useEffect(() => (engine ? engine.on(handleEngineEvent) : undefined), [engine, handleEngineEvent]);
+
+  /** Build the agent for an open project, or null when no OpenRouter key is configured. */
+  const createEngine = useCallback(async (state: EditorState, chatSeed: readonly ChatMessage[]) => {
+    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
+    if (!apiKey) return null;
+    modelsRef.current ??= createEditorModels({ apiKey });
+    return Engine.create({
+      state, registry, models: modelsRef.current, modelId: settingsRef.current.models.openrouter.text,
+      session: new SessionStore(join(state.store.snapshot.projectDir, "agent", "session.jsonl")),
+      getSettings: () => settingsRef.current, skills: await loadAgentSkills(), chatSeed,
+    });
+  }, [registry]);
+
+  const actionContext = useCallback((state: EditorState, request: string, onStage: (stage: string) => void): ActionContext => ({
+    state, settings: settingsRef.current, signal: new AbortController().signal, request,
+    progress: (update) => onStage(update.stage), requestChoice: async () => null,
+  }), []);
 
   const openVideo = useCallback(async (path: string, projectDirectory?: string) => {
+    if (engineRef.current?.running) {
+      addUiMessage("assistant", "The agent is working. Wait for it to finish, or press Esc to stop it, before opening another video.");
+      return;
+    }
     setLoader({ source: "Editor", stage: "Opening video" });
     setPlaying(false);
     try {
@@ -249,16 +360,19 @@
         ? await ProjectStore.openProject(projectDirectory)
         : await ProjectStore.open(resolve(path));
       setLoader({ source: "Editor", stage: "Reading media details" });
-      const nextMedia = await probeMedia(store.current.filePath);
+      const state = await EditorState.open(store);
       const history = await store.chatHistory();
-      await Promise.all([refreshProjectData(store), store.register()]);
-      setProject(store); setRevision((value) => value + 1); setMedia(nextMedia); setMessages(history);
+      await store.register();
+      const nextEngine = await createEngine(state, history);
+      setProject(store); setEditor(state); setEngine(nextEngine); setRevision((value) => value + 1);
+      setMedia(state.media); setAssets([...state.assets]); setUsage(state.usage); setMessages(history);
       setSelection({ in: null, out: null }); currentTimeRef.current = 0; setCurrentTime(0);
       setStatus(`Opened ${store.name}`);
-      addUiMessage("assistant", `Opened ${store.name} · ${nextMedia.width}x${nextMedia.height} · ${formatTime(nextMedia.duration)}`, "editor");
+      addUiMessage("assistant", `Opened ${store.name} · ${state.media.width}x${state.media.height} · ${formatTime(state.media.duration)}`, "editor");
+      if (!nextEngine) addUiMessage("assistant", "Add an OpenRouter API key with dumbeditor setup to talk to the agent. Slash commands still work.", "editor");
     } catch (error) { addUiMessage("assistant", errorMessage(error)); setStatus("Open failed"); }
     finally { setLoader(null); }
-  }, [addUiMessage, refreshProjectData]);
+  }, [addUiMessage, createEngine]);
 
   const openProjectsBrowser = useCallback(async () => {
     setPlaying(false);
@@ -301,24 +415,23 @@
   }, [currentFile, media, playing, layout.playerRows, audioVolume]);
 
   const applyEdit = useCallback(async (edit: DirectEdit, request: string, source: LoaderState["source"]) => {
-    if (!project) throw new Error("Open a video first with /open <path>.");
+    if (!editor) throw new Error("Open a video first with /open <path>.");
     setLoader({ source, stage: "Preparing edit" });
-    const result = await executeDirectEdit(project, edit, request, (stage) => setLoader({ source, stage }));
-    setMedia(result.media); setRevision((value) => value + 1); movePlayhead(0); setSelection({ in: null, out: null });
-    await answer(`${result.version.id} · ${result.version.action}`);
+    const { name, args } = directEditCall(edit);
+    const result = await registry.run(name, args, actionContext(editor, request, (stage) => setLoader({ source, stage })));
+    await answer(result.text);
     setStatus(`${source} · complete`);
-  }, [answer, movePlayhead, project]);
+  }, [actionContext, answer, editor, registry]);
 
   const changeVersion = useCallback(async (reference: string) => {
-    if (!project) return;
+    if (!editor) return;
     setLoader({ source: "Editor", stage: "Loading saved version" }); setPlaying(false);
     try {
-      const version = await project.revert(reference); const nextMedia = await probeMedia(version.filePath);
-      setMedia(nextMedia); setRevision((value) => value + 1); movePlayhead(0);
+      const version = await editor.revertTo(reference);
       await answer(`Now on ${version.id}: ${version.action}`); setStatus(`Current ${version.id}`);
     } catch (error) { await answer(errorMessage(error)); setStatus("Revert failed"); }
     finally { setLoader(null); }
-  }, [answer, movePlayhead, project]);
+  }, [answer, editor]);
 
   const openModelPicker = useCallback(() => {
     modelRequest.current += 1;
@@ -408,6 +521,10 @@
         ? await setBaseAgentModel(modelPicker.provider, selected.id)
         : await setDefaultModel(modelPicker.provider, modelPicker.slot, selected.id);
       setSettings(next);
+      if (modelPicker.capability === "agent" && editor && !engineRef.current?.running) {
+        settingsRef.current = next;
+        setEngine(await createEngine(editor, []));
+      }
       setOverlay(null);
       setStatus(`${selected.id} selected`);
       await answer(modelPicker.capability === "agent"
@@ -418,7 +535,7 @@
     } finally {
       setLoader(null);
     }
-  }, [answer, loadModelChoices, modelPicker]);
+  }, [answer, createEngine, editor, loadModelChoices, modelPicker]);
 
   const backModelPicker = useCallback(() => {
     modelRequest.current += 1;
@@ -442,6 +559,7 @@
     const space = line.indexOf(" ");
     const command = (space === -1 ? line : line.slice(0, space)).toLowerCase();
     const argument = unquoteArgument(space === -1 ? "" : line.slice(space + 1).trim());
+    if (agentRunning && !SAFE_DURING_RUN.has(command)) { await answer("The agent is working. Wait for it to finish, or press Esc to stop it."); return; }
     if (command === "/quit" || command === "/exit") { exit(); return; }
     if (command === "/help") { setOverlay("help"); return; }
     if (command === "/clear") { setMessages([]); setOverlay(null); return; }
@@ -460,11 +578,25 @@
       await answer(`Agent permission mode set to ${argument}.`);
       return;
     }
-    if (command === "/harness-model") {
-      if (!argument) { await answer(`Claude harness model: ${settings.agent.claudeModel}`); return; }
-      const next = await setClaudeHarnessModel(argument);
+    if (command === "/budget") {
+      if (!argument) {
+        const limit = settings.agent.spendCeilingUsd;
+        await answer(limit > 0
+          ? `Each agent run pauses to ask at ${formatUsd(limit)}. Use /budget <USD> to change it, or /budget 0 to turn it off.`
+          : "There is no per-run spend limit. Use /budget <USD> to set one.");
+        return;
+      }
+      const next = await setSpendCeiling(Number(argument));
       setSettings(next);
-      await answer(`Claude harness model set to ${next.agent.claudeModel}.`);
+      await answer(next.agent.spendCeilingUsd > 0 ? `Per-run spend limit set to ${formatUsd(next.agent.spendCeilingUsd)}.` : "Per-run spend limit turned off.");
+      return;
+    }
+    if (command === "/compact") {
+      const current = engineRef.current;
+      if (!current) { await answer("Open a video, with an OpenRouter key configured, first."); return; }
+      setLoader({ source: "Editor", stage: "Compacting conversation" });
+      try { await answer(await current.compact() ? "Compacted the earlier conversation." : "There is nothing to compact yet."); }
+      finally { setLoader(null); }
       return;
     }
     if (!project || !media) { await answer("Open a video first with /open <path>."); return; }
@@ -501,7 +633,7 @@
     if (command === "/revert") { if (!argument) { await answer("Usage: /revert <VERSION>"); return; } await changeVersion(argument); return; }
     if (command === "/export") { openExportPanel(argument); return; }
     await answer(`Unknown command ${command}. Type / to see commands.`);
-  }, [answer, applyEdit, changeVersion, exit, media, openAssetBrowser, openExportPanel, openModelPicker, openMusicBrowser, openProjectsBrowser, openVideo, project, selection, settings.agent.claudeModel, settings.agent.permissionMode, toggleChatFocus]);
+  }, [answer, applyEdit, changeVersion, exit, media, openAssetBrowser, openExportPanel, openModelPicker, openMusicBrowser, openProjectsBrowser, openVideo, project, selection, settings.agent.permissionMode, settings.agent.spendCeilingUsd, agentRunning, toggleChatFocus]);
 
   const submit = useCallback(async () => {
     const request = input.trim();
@@ -513,45 +645,37 @@
     }
     setInput(""); setInputCursor(0); setOverlay(null); addUiMessage("user", request);
     if (request.startsWith("/")) { try { await handleCommand(request); } catch (error) { await answer(errorMessage(error)); } return; }
-    if (!project || !media) { await answer("Open a video first with /open <path>."); return; }
-
-    setLoader({ source: agentModel, stage: "Understanding your request" });
+    if (!project || !media || !editor) { await answer("Open a video first with /open <path>."); return; }
+    const agent = engineRef.current;
+    if (!agent) { await answer("Add an OpenRouter API key with dumbeditor setup to talk to the agent."); return; }
+
+    // Text sent while the agent is running steers it; otherwise it starts a run.
+    editor.setPlayhead(currentTimeRef.current);
+    editor.setSelection(selection);
     try {
-      await project.nameFromFirstRequest(request);
-      await project.register();
-      await project.addChat("user", request);
-      const before = project.current.id;
-      const result = await runEditorAgent({
-        request, store: project, media, currentTime: currentTimeRef.current, selection,
-        requestApproval, requestChoice,
-        onCost: (kind, costUsd) => setUsage((current) => ({
-          totalUsd: current.totalUsd + costUsd,
-          lunaUsd: current.lunaUsd + (kind === "luna" ? costUsd : 0),
-          assetUsd: current.assetUsd + (kind === "asset" ? costUsd : 0),
-          harnessUsd: current.harnessUsd + (kind === "harness" ? costUsd : 0),
-          entries: current.entries + 1,
-        })),
-        onStage: (stage) => setLoader(stage.startsWith("SANDBOX · ")
-          ? { source: "Sandbox", stage: stage.slice("SANDBOX · ".length) }
-          : { source: agentModel, stage }),
-      });
-      await refreshProjectData(project);
-      if (result.versionId !== before) {
-        setMedia(result.media); setRevision((value) => value + 1); movePlayhead(0); setSelection({ in: null, out: null });
+      if (!agent.running) {
+        await project.nameFromFirstRequest(request);
+        await project.register();
       }
-      setLoader({ source: agentModel, stage: "Writing response" });
-      await answer(result.message, result.model); setStatus(`${result.model} · ${result.toolCalls} tools`);
+      await project.addChat("user", request);
+      agent.submit(request);
     } catch (error) { await answer(errorMessage(error)); setStatus(`${agentModel} request failed`); }
-    finally { setLoader(null); }
-  }, [addUiMessage, agentModel, answer, busy, handleCommand, input, media, movePlayhead, project, refreshProjectData, requestApproval, requestChoice, selection, suggestionIndex, suggestions]);
+  }, [addUiMessage, agentModel, answer, busy, editor, handleCommand, input, media, project, selection, setOverlay, suggestionIndex, suggestions]);
 
   useInput((character, key) => {
-    if (key.ctrl && character === "c") { exit(); return; }
+    if (key.ctrl && character === "c") {
+      if (engineRef.current?.running) engineRef.current.abort();
+      else exit();
+      return;
+    }
     if (isFocusReport(character)) return;
     if (overlay === "approval") {
-      if (key.escape) { resolveApproval(false); return; }
-      if (key.leftArrow || key.rightArrow || key.tab) { setApprovalAllow((value) => !value); return; }
-      if (key.return) { resolveApproval(approvalAllow); return; }
+      if (!approval) return;
+      const options = approvalOptions(approval);
+      if (key.escape) { resolveApproval("deny"); return; }
+      if (key.leftArrow || key.upArrow) { setApprovalIndex((value) => (value - 1 + options.length) % options.length); return; }
+      if (key.rightArrow || key.downArrow || key.tab) { setApprovalIndex((value) => (value + 1) % options.length); return; }
+      if (key.return) { resolveApproval(approvalDecision(approval, approvalIndex)); return; }
       return;
     }
     if (overlay === "choice" && choice) {
@@ -770,6 +894,7 @@
     if (key.escape) {
       if (overlay) setOverlay(null);
       else if (chatFocused) setChatFocused(false);
+      else if (agentRunning && input.length === 0) engineRef.current?.abort();
       else { setInput(""); setInputCursor(0); }
       return;
     }
@@ -883,7 +1008,7 @@
           : overlay === "assets" ? <AssetPanel assets={assets} selectedIndex={assetIndex} playing={assetPlaying}
               onPlaybackEnd={stopAssetPlayback}
               width={terminal.columns - 2} height={layout.playerRows} />
-          : overlay === "approval" && approval ? <ApprovalPanel request={approval} allowSelected={approvalAllow}
+          : overlay === "approval" && approval ? <ApprovalPanel request={approval} options={approvalOptions(approval)} selectedIndex={approvalIndex}
               width={terminal.columns - 2} height={layout.playerRows} />
           : overlay === "choice" && choice ? <ChoicePanel request={choice} state={choicePanel}
               width={terminal.columns - 2} height={layout.playerRows} />
@@ -920,8 +1045,8 @@
         : <InputPanel value={input} cursor={inputCursor} width={terminal.columns - 2} busy={busy} />}
       <Box height={1} minHeight={1} overflow="hidden">
         <Text dimColor wrap="truncate-end">{loader
-          ? `${loader.source} is working · ${agentModel} ${formatUsd(usage.lunaUsd)} · Harness ${formatUsd(usage.harnessUsd)} · Assets ${formatUsd(usage.assetUsd)} · Total ${formatUsd(usage.totalUsd)} · ${videoMutationActive ? "video updating · ↑/↓ chat" : "↑/↓ chat · ←/→ seek · Ctrl+P play"}`
-          : `${status} · ${agentModel} ${formatUsd(usage.lunaUsd)} · Harness ${formatUsd(usage.harnessUsd)} · Assets ${formatUsd(usage.assetUsd)} · Total ${formatUsd(usage.totalUsd)} · Enter to send · Ctrl+C to quit`}</Text>
+          ? `${loader.source} is working · ${agentModel} ${formatUsd(usage.lunaUsd)} · Assets ${formatUsd(usage.assetUsd)} · Total ${formatUsd(usage.totalUsd)} · ${agentRunning ? "Enter steers · Esc stops" : videoMutationActive ? "video updating · ↑/↓ chat" : "↑/↓ chat · ←/→ seek · Ctrl+P play"}`
+          : `${status} · ${agentModel} ${formatUsd(usage.lunaUsd)} · Assets ${formatUsd(usage.assetUsd)} · Total ${formatUsd(usage.totalUsd)} · Enter to send · Ctrl+C to quit`}</Text>
       </Box>
     </Box>
   );
```

- [ ] **Step 7: Drop the Claude SDK dependency and the old test**

```bash
npm uninstall @anthropic-ai/claude-agent-sdk
```

Apply this change to `package.json`:

```diff
--- a/package.json
+++ b/package.json
@@ -17,7 +17,7 @@
     "build": "tsup",
     "check": "tsc --noEmit",
     "dev": "tsx src/cli.tsx",
-    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/luna.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/transcription.test.js",
+    "test": "tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/tests/time.test.js .test-dist/tests/preview.test.js .test-dist/tests/editor.test.js .test-dist/tests/advanced-editor.test.js .test-dist/tests/export.test.js .test-dist/tests/commands.test.js .test-dist/tests/music.test.js .test-dist/tests/layout.test.js .test-dist/tests/model-picker.test.js .test-dist/tests/projects.test.js .test-dist/tests/text-layout.test.js .test-dist/tests/keys.test.js .test-dist/tests/pi-layer.test.js .test-dist/tests/compaction.test.js .test-dist/tests/editor-state.test.js .test-dist/tests/actions.test.js .test-dist/tests/session-store.test.js .test-dist/tests/engine.test.js .test-dist/tests/live-openrouter.test.js .test-dist/tests/terminal-layers.test.js .test-dist/tests/transcription.test.js",
     "quality": "npm run check && npm test && npm run build",
     "release:check": "npm run quality && npm pack --dry-run",
     "prepublishOnly": "npm run quality"
@@ -50,7 +50,6 @@
     "node": ">=22.19.0"
   },
   "dependencies": {
-    "@anthropic-ai/claude-agent-sdk": "^0.3.276",
     "@anthropic-ai/sandbox-runtime": "^0.0.77",
     "@earendil-works/pi-agent-core": "1.0.0",
     "@earendil-works/pi-ai": "1.0.0",
```

(`npm uninstall` removes the dependency line and updates `package-lock.json`; the remaining change is dropping `luna.test.js` from the `test` script.)

- [ ] **Step 8: Update the README**

The README now describes the OpenRouter-only agent, steering and stopping, the spend limit and compaction, the new commands and keys, `session.jsonl`, and removes the Claude harness:

Apply this change to `README.md`:

```diff
--- a/README.md
+++ b/README.md
@@ -74,12 +74,11 @@
 
 ## Requirements and platform support
 
-- Node.js 20.11 or newer
+- Node.js 22.19 or newer
 - `ffmpeg` and `ffprobe` on `PATH`
 - `ffplay` on `PATH` for preview audio and catalog music auditioning
-- An OpenAI API key for the default editor agent
-- An optional OpenRouter key for alternate agents and image, music, or video generation
-- An optional Anthropic API key for the Claude coding harness
+- An OpenRouter API key for the editor agent and for image, music, and video generation
+- An optional OpenAI API key for speech transcription and text to speech
 
 Common FFmpeg installations:
 
@@ -121,11 +120,12 @@
 - Automatic transcription, speaker-aware subtitle options, and burned captions
 - Image, speech, music, and video asset generation through configured provider models
 - Searchable CC BY 4.0 music with preview, source, license, attribution, and modification records
-- Ask and automatic permission modes for model and parameter changes
-- Optional Claude coding harness and isolated Python or JavaScript workspace tools
+- A streaming agent you can watch, steer by typing, and stop with Esc, with context compaction and sessions that resume after a restart
+- Ask and automatic permission modes for paid generation and custom code, plus a per-run spend limit
+- Isolated Python or JavaScript workspace tools
 - Immutable versions with undo, revert, branches, export, and configurable retention
 - Interactive model catalogs with capability-specific prices
-- Persistent agent, harness, and asset cost ledgers
+- Persistent agent and asset cost ledgers
 
 ## Projects and source safety
 
@@ -135,7 +135,7 @@
 
 ## Ask the editor agent
 
-Write normal requests. The configured editor model receives the active version, media details, playhead, marks, and project conversation. It can inspect sampled frames, call several tools in sequence, recover from a failed tool call, and summarize the versions and assets it created. After a rendered mutation, the runtime requires the model to inspect output frames before it can finish the run.
+Write normal requests. The configured editor model sees the active version, media details, playhead, marks, and the project conversation, and it is told again whenever you move the playhead or change marks, so "cut here" works. It can inspect sampled frames, call several tools in sequence, list and revert its own versions, recover from a failed tool call, and summarize the versions and assets it created. Everything it does streams into the conversation as it happens. Type while it works to steer it, press Esc to stop it. After a rendered mutation, the runtime asks the model to inspect output frames before it can finish the run.
 
 ```text
 remove the first two seconds and mute the last five
@@ -147,23 +147,20 @@
 generate a five second establishing shot of a rainy city for this project
 ```
 
-The base editor agent defaults to OpenAI `gpt-6-luna`. `/model` can move the base agent to any tool-capable OpenRouter text model, and that provider selection controls the real editing runtime, API key, usage ledger, and UI model name. DumbEditor does not impose a reasoning-round, tool-call, mutation, or output-token cap on the main agent. It continues until it finishes or the user cancels. The default models are:
+The editor agent runs on OpenRouter and defaults to `openai/gpt-6-luna`. `/model` can move it to any OpenRouter text model that supports tool calling and image input. Long sessions are compacted automatically when the conversation passes 60% of the model's context window, or on demand with `/compact`; a run that spends more than the per-run limit pauses and asks to continue (`/budget`, $5 by default). The default models are:
 
 | Capability | Default |
 | --- | --- |
-| Base agent (OpenAI) | `gpt-6-luna` |
+| Base agent (OpenRouter) | `openai/gpt-6-luna` |
 | OpenAI transcription | `gpt-transcribe` |
 | OpenAI speech | `gpt-4o-mini-tts` |
-| Base agent alternative (OpenRouter) | `openai/gpt-6-luna` |
 | Image | `google/gemini-3.1-flash-lite-image` |
 | Music | `google/lyria-3-clip-preview` |
 | Video | `google/veo-3.1-lite` |
 
 Provider catalogs and prices change. `/model` loads the current catalog and displays each capability in its billing unit before selection.
 
-The editor agent may override a configured specialist model and pass provider-specific parameters for one request. In the default `ask` permission mode, DumbEditor displays the provider, model, and parameters and waits for Allow once or Deny. `/permissions auto` lets DumbEditor proceed automatically. The selected defaults remain unchanged unless you change them through `/model`.
-
-For work that needs new code or an unfamiliar tool chain, the editor agent can delegate a bounded task to Claude Agent SDK. Claude works inside the current project's agent workspace, can read the active video, and uses its own tool permission classifier in auto mode. The integration is optional and only appears when an Anthropic key is configured.
+The editor agent may override a configured specialist model and pass provider-specific parameters for one request. In the default `ask` permission mode, DumbEditor shows what the agent wants to do and waits for Allow once, Allow this session, or Deny before it generates paid assets, uses a model override, runs a custom FFmpeg graph, or runs a script. `/permissions auto` lets DumbEditor proceed automatically. The selected defaults remain unchanged unless you change them through `/model`.
 
 When asked to add subtitles without a supplied file, the editor agent extracts the audio in short chunks, transcribes it with the configured OpenAI transcription model, creates a timed SRT in the project workspace, and burns it into a new version. Chunked processing keeps long recordings below individual upload limits. Cue timing is estimated within each chunk because the durable default transcription model returns text rather than word timestamps. The agent can request `gpt-4o-transcribe-diarize` when speaker labels are useful; the model switch goes through the active permission policy and produces speaker-timed SRT cues.
 
@@ -188,7 +185,8 @@
 /assets
 /model
 /permissions [ask|auto]
-/harness-model [MODEL]
+/budget [USD]
+/compact
 /status
 /play
 /pause
@@ -227,13 +225,13 @@
 
 ### Model browser
 
-`/model` opens with capabilities first: Base agent, Image, Audio, Music, Video, Transcription, and Speech. Pick Base agent, then choose OpenAI or OpenRouter, then search the provider's model catalog. OpenRouter base-agent results are limited to models that advertise tool calling and image input because editing depends on tools and visual frame audits. Other capabilities show the providers DumbEditor can execute for that media type. Text shows input and output token prices; transcription shows its duration rate; speech and audio show their provider billing units; image uses image, megapixel, token, or request rates; music shows song or clip rates; video shows the live SKU range and billing unit.
+`/model` opens with capabilities first: Base agent, Image, Audio, Music, Video, Transcription, and Speech. Pick Base agent, then search the OpenRouter model catalog. Base-agent results are limited to models that advertise tool calling and image input because editing depends on tools and visual frame audits. Other capabilities show the providers DumbEditor can execute for that media type. Text shows input and output token prices; transcription shows its duration rate; speech and audio show their provider billing units; image uses image, megapixel, token, or request rates; music shows song or clip rates; video shows the live SKU range and billing unit.
 
-### Agent permissions and coding harness
+### Agent permissions, spend limit, and context
 
-`/permissions ask` is the default. A centered approval popup appears before a one-run model change, custom provider parameters, or Claude harness delegation. Use Left, Right, or Tab to choose, Enter to confirm, and Escape to deny. `/permissions auto` allows these operations without the DumbEditor popup; Claude's SDK permission classifier still evaluates its internal tool calls.
+`/permissions ask` is the default. A centered approval popup appears before paid asset generation, a model or parameter override, a custom FFmpeg graph, or a script. Use Left, Right, or Tab to choose, Enter to confirm, and Escape to deny. Allow this session skips the popup for that action until you quit. `/permissions auto` allows these operations without a popup.
 
-`/harness-model` shows the configured Claude model. `/harness-model <MODEL>` changes it. Harness runs have a bounded turn count and cost budget, and their reported cost is added to the project ledger.
+`/budget` shows the per-run spend limit and `/budget <USD>` changes it. When one agent run reaches the limit it pauses and asks whether to continue; `/budget 0` turns the limit off. `/compact` summarizes earlier conversation now, keeping a record of what the agent saw in inspected frames.
 
 ## Controls
 
@@ -249,8 +247,8 @@
 | `Enter` | Send, complete, or select |
 | `PageUp` / `PageDown` | Scroll chat history without moving the input cursor |
 | `Ctrl+G` | Expand chat over the player or return to the video |
-| `Esc` | Minimize expanded chat, clear input, or close a panel |
-| `Ctrl+C` | Quit and terminate preview processes |
+| `Esc` | Stop the agent when the input is empty, minimize expanded chat, clear input, or close a panel |
+| `Ctrl+C` | Stop the agent while it works; otherwise quit and terminate preview processes |
 | `Ctrl+O` | Open or close the project asset browser |
 
 While an agent request runs, its current stage appears in the header above the video. Chat scrolling, seeking, volume, and play/pause remain available during planning, tool review, transcription, and asset generation. DumbEditor pauses preview transport only while FFmpeg is rendering or validating a changed video and while the new version is being saved.
@@ -259,7 +257,7 @@
 
 The right sidebar lists generated images, video, speech, music, subtitles, and agent workspace files. Each generated asset records its provider model and cost when the provider returns billing data; estimates are marked with `~`. Catalog assets retain their source page, exact license link, and required attribution. "Royalty-free" is treated as a licensing or payment term rather than a claim that an asset has no conditions. Press `Ctrl+O` or run `/assets` to browse the full list, use Up and Down to select an asset, and press Space to play audio, music, or video. Image and video assets have an inline preview. Start typing to close the browser, restore the main video player, and continue the text in chat.
 
-The chat footer shows the configured editor model by name alongside its running cost, harness cost, asset cost, and total. These values are stored in the source video's `.dumbeditor` project and survive restarts. Editor-model cost includes every Responses API round in a tool loop, including cached input and reasoning output reported by the API. If a media provider reports a charge for an empty generation, that failed attempt is also retained in the asset cost ledger without inventing an asset.
+The chat footer shows the configured editor model by name alongside its running cost, asset cost, and total. These values are stored in the source video's `.dumbeditor` project and survive restarts. Editor-model cost is the charge OpenRouter reports for every request in a run, including cached input and reasoning output; when OpenRouter does not report one, the catalog price is used and marked `~`. If a media provider reports a charge for an empty generation, that failed attempt is also retained in the asset cost ledger without inventing an asset.
 
 ## Preview backend
 
@@ -286,14 +284,12 @@
   Agent --> Assets[Asset providers]
   Agent --> Tools[Validated edit tools]
   Agent --> Compose[Custom FFmpeg composition]
-  Agent --> Claude[Optional Claude coding harness]
   Agent --> Sandbox[Optional isolated scripts]
   Assets --> Workspace[Project workspace]
   Workspace --> Tools
   Tools --> FFmpeg
   Compose --> FFmpeg
   Sandbox --> Workspace
-  Claude --> Workspace
   FFmpeg --> Version[Probed immutable version]
   Version --> Preview[Terminal preview]
 ```
@@ -306,7 +302,7 @@
   chat.jsonl
   versions/
   agent/
-    context.jsonl
+    session.jsonl
     workspace/
       assets.json
       assets/
@@ -316,12 +312,10 @@
   ...archived project session...
 ```
 
-The readable transcript stays in `chat.jsonl`. Raw response items and tool results are appended to the agent ledger. Generated assets and supporting files persist in the project workspace.
+The readable transcript stays in `chat.jsonl`. The agent's full conversation, including tool calls, results, and compaction summaries, is appended to `agent/session.jsonl`, so a project resumes where it left off. Generated assets and supporting files persist in the project workspace. Versions the agent has seen are pinned and survive retention pruning.
 
 The agent uses prepared tools for common work and can build a custom FFmpeg filter graph for combinations that do not have a dedicated command. Filter graph inputs are limited to the active video and registered workspace assets. It can send multiple extracted frames to its vision input to inspect the source and audit each rendered result. When a creative decision has several useful directions, the agent can open a native terminal choice picker and receive either a selected option or a custom answer before continuing.
 
-The optional Claude harness gives the editor model a coding specialist with file, search, and shell tools scoped to the project's `agent/workspace/files` directory. Its shell runs in the Claude SDK sandbox with network disabled, unsandboxed commands forbidden, the active video and project assets readable, only that files directory writable, and provider credentials removed from child commands. DumbEditor owns the outer approval policy, version store, asset ledger, and cost ledger. Claude returns created workspace files to the editor model, which remains responsible for applying validated edits and auditing the video output.
-
 The agent can also write subtitle files, notes, and scripts inside the workspace. Python and JavaScript scripts run through Anthropic's lightweight Sandbox Runtime, the same open source runtime developed for Claude Code. It uses native OS isolation without a container: a dedicated restricted user and Windows Filtering Platform fence on Windows, Seatbelt on macOS, and bubblewrap plus seccomp on Linux. The active video is read-only, only the current agent workspace is writable, networking is disabled, and API keys are withheld. `dumbeditor setup` performs the one-time Windows sandbox installation with one UAC prompt.
 
 The packaged [`skills`](skills) are loaded into the editor agent on every run. They document the verified video, asset, audio, music, licensing, and workspace workflows. Explicit generation requests remain generation requests: if a provider returns no media, the agent reports that failure and labels any catalog alternative as a separate fallback.
```

- [ ] **Step 9: Verify: automated**

```bash
npx tsc --noEmit
npm run quality
```

Expected: `tsc` prints nothing; `npm run quality` runs undefined tests with 0 failed (one skipped: the live test) and finishes with `Build success`.

```bash
node dist/cli.js --version
node dist/cli.js --help
```

Expected: the help lists `/budget [USD]` and `/compact` and does not list `/harness-model`.

- [ ] **Step 10: Verify: manual, in a real terminal**

These behaviours need a person at a terminal with an OpenRouter key. Make a test video, run setup once, then work through the list:

```bash
ffmpeg -y -f lavfi -i testsrc2=size=640x360:rate=24:duration=12 -f lavfi -i sine=frequency=440:duration=12 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest test.mp4
node dist/cli.js setup
node dist/cli.js test.mp4
```

| # | Do this | Expected |
| --- | --- | --- |
| 1 | `describe this video` | Text appears progressively, not all at once; a `▸ Inspect ... frame(s)` line, then `✓`; the footer cost rises |
| 2 | Move the playhead with Left/Right, press `[` and `]`, then `cut from the in mark to the out mark` | The agent cuts exactly the marked range without asking where |
| 3 | `remove the last two seconds` | `▸ Remove ...`, `✓ v0001: ...`, the preview updates, then an audit (`▸ Inspect ...`) before the answer |
| 4 | During a longer request type `actually keep three seconds instead` and press Enter | Status says `Queued`; the agent changes course after its current step |
| 5 | Start a request and press Esc with an empty input | `Stopped.`; no half-made version appears in the sidebar |
| 6 | `generate an image of a cat` with `/permissions ask` | Approval popup with Allow once / Allow this session / Deny; Esc denies and the agent explains |
| 7 | `/budget 0.001`, then any request | Pauses with `Spend limit reached`; Stop ends the run with `Stopped at the spend limit` |
| 8 | `/compact` | `Compacted the earlier conversation.` or `There is nothing to compact yet.` |
| 9 | Quit, relaunch the same file, ask `what did you just do?` | The agent remembers the earlier session |
| 10 | `/undo`, then ask `what version are we on?` | The agent reports the version you reverted to |
| 11 | Unset `OPENROUTER_API_KEY` and launch | `Add an OpenRouter API key with dumbeditor setup...`; slash commands such as `/clip-remove 1 2` still work |
| 12 | On macOS or Linux: type, press Backspace, switch windows | Backspace deletes; no `[I`/`[O` appears (the earlier hotfix still holds) |

- [ ] **Step 11: Commit**

```bash
git add -A src tests README.md package.json package-lock.json
git commit -m "feat: run the editor on the agent engine and remove the Claude harness"
```

## Task 8: CI on Windows and macOS, release check and handover

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: CI that runs the whole suite (real FFmpeg video, the engine, the registry) on Windows and macOS as well as Linux. Before this, those two runners only ran `--help` and `--version`.

- [ ] **Step 1: Run the full suite on every platform in CI**

The new tests render real video, so the Windows and macOS runners need FFmpeg:

```diff
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -34,7 +34,14 @@
           node-version: 22.19.0
           cache: npm
       - run: npm ci
+      - name: Install FFmpeg (macOS)
+        if: runner.os == 'macOS'
+        run: brew install ffmpeg
+      - name: Install FFmpeg (Windows)
+        if: runner.os == 'Windows'
+        run: choco install ffmpeg -y --no-progress
       - run: npm run check
+      - run: npm test
       - run: npm run build
       - run: node dist/cli.js --version
       - run: node dist/cli.js --help
```

- [ ] **Step 2: Release check**

```bash
npm run release:check
```

Expected: quality passes, and `npm pack --dry-run` lists `dist/cli.js`, `README.md`, `LICENSE`, `THIRD_PARTY.md` and `skills/*/SKILL.md`, and no `src/` or `tests/` files.

- [ ] **Step 3: Linux as a macOS stand-in (optional but recommended)**

If WSL is available, repeat `npm ci && npm test && npm run build` there with Node 22.19 or newer (the Node 22.11 left in `~/audit-tools` from the earlier audit is too old for pi). A pass there plus the manual checklist in Task 7 is the closest check available to a real Mac before CI runs on one.

- [ ] **Step 4: Commit and review**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the full test suite on Windows and macOS"
git log --oneline fix/mac-input..HEAD
```

Expected: seven commits (Tasks 1 to 6, 7 and 8 each one). Do not push or publish: review the branch first.

## Self-review notes

- **Spec coverage:** sections 4 to 8 map to Tasks 3 to 6 (actions, state, engine, events, session store, compaction, cost, tools); section 9 (errors, retries) to Tasks 2 and 6; section 10 (UI adapter) to Task 7; section 11 (dependencies, Node) to Tasks 1 and 7; section 12 (testing) to every task plus Task 8; section 13 (migration order) is this task list.
- **Known gaps by design:** the Ink behaviour is verified by the Task 7 checklist, not by automated tests; the OpenRouter `usage.cost` field and the Anthropic-compatible path are verified by the opt-in live test, not offline.
