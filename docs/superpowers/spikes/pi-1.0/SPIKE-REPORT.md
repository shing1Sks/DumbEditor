# pi 1.0 spike for DumbEditor: verified report

Date: 2026-10-02. Everything below was compiled (`tsc`, strict) and run. Nothing touched the network:
tests use pi's faux provider plus a local fake OpenRouter HTTP server (`src/fake-openrouter.ts`) that
pi's REAL `openai-completions` and `anthropic-messages` adapters talk to.

## 0. Environment and exact versions

- Node **v24.19.0**, npm 11.1.0, Windows 11. Folder: `C:\Users\SHREYASH KUMAR SINGH\AppData\Local\Temp\pi-spike`
- Run: `npm test` (= `tsx --test src/*.test.ts`, node:test runner) and `npm run typecheck` (= `tsc -p .`, noEmit).
- Result at time of writing: **82 tests, 82 pass, 0 fail**; `tsc` clean. (models 13, cost 11, engine-loop 17, engine-hooks 14, engine-transcript 14, compaction 13.)
- Pinned in package.json (exact, no carets):

```
@earendil-works/pi-ai@1.0.0
@earendil-works/pi-agent-core@1.0.0
typebox@1.3.27                      (pi-ai AND pi-agent-core both pin typebox 1.3.27 exactly; npm dedupes to one copy)
tsx@4.23.15   typescript@7.0.2   @types/node@26.6.4      (dev)
```

`npm ls --depth=0`:

```
pi-spike@1.0.0
+-- @earendil-works/pi-agent-core@1.0.0
+-- @earendil-works/pi-ai@1.0.0
+-- @types/node@26.6.4
+-- tsx@4.23.15
+-- typebox@1.3.27
`-- typescript@7.0.2
```

Transitive pi-related (from `npm ls --all`): `@earendil-works/pi-telemetry@1.0.0` (dep of pi-ai), `openai@7.19.0`,
`@anthropic-ai/sdk@0.124.0` (the installed one; the source clone's package.json says 0.129.0, so the clone is slightly
ahead of the published tarball; all tests ran against the INSTALLED package, the clone was only read).
pi source clone read: `/tmp/pi-scratch/pi-mono` @ `de7e675`. License: MIT, "Copyright (c) 2025 Mario Zechner".

## 1. Files

```
src/models.ts            createEditorModels, openRouterModel, createStreamFn (+ mergeStreamOptions, normalizeAbort, withOpenRouterRoutingPayload)
src/cost.ts              createCostTracker
src/events.ts            EngineEvent union + mapAgentEvent
src/tools.ts             toolFromJsonSchema (raw JSON schema -> AgentTool, optional strict validation)
src/editor-state.ts      createEditorStateSync (<editor_state> only when revision changed)
src/prompt.ts            replaceSystemPrompt
src/compaction.ts        vendored+adapted pi compaction: shouldCompact, findCutIndex, compact
src/fake-openrouter.ts   local fake server for chat-completions SSE and anthropic-messages SSE (test helper)
src/test-helpers.ts      faux setup, toolUse(), deferred(), summarize()
src/models.test.ts  src/cost.test.ts  src/engine-loop.test.ts (a-e)  src/engine-hooks.test.ts (f-h)
src/engine-transcript.test.ts (i-j)  src/compaction.test.ts
```

## 2. Verified API cheat sheet

### Imports (all verified; package `exports` map in pi-ai: `.`, `./models`, `./compat`, `./providers/*`, `./api/*`, `./utils/*`, `./oauth`)

```ts
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall,
         validateToolArguments, normalizeContext, getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools,
         createAssistantMessageEventStream, contentText, uuidv7, retryAssistantCall,
         type Model, type Models, type MutableModels, type Usage, type AssistantMessage, type SystemMessage,
         type SimpleStreamOptions, type AuthContext, type OpenRouterRouting } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { estimateContextTokens, estimateMessageTokens, calculateContextTokens } from "@earendil-works/pi-ai/utils/estimate"; // NOT exported from the root
import { Agent, type AgentTool, type AgentEvent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";            // also re-exported by pi-ai root: `Type`
import { Compile } from "typebox/compile";
```

No global registry any more: `createModels()` returns a `MutableModels`; `models.setProvider(provider)`; the old global API is only under `pi-ai/compat`.

### API keys (OpenRouter)

`openrouterProvider()` = `createProvider({ id:"openrouter", auth:{ apiKey: envApiKeyAuth("OpenRouter API key",["OPENROUTER_API_KEY"]), oauth }, models:[catalog], api:{ "anthropic-messages", "openai-completions" } })`.
Key resolution order in `Models`: per-request `options.apiKey` > stored credential > ambient (`authContext.env("OPENROUTER_API_KEY")`).
Programmatic, no process.env (what `createEditorModels` does, verified incl. with a conflicting `process.env.OPENROUTER_API_KEY`):

```ts
const authContext: AuthContext = { env: async (n) => n === "OPENROUTER_API_KEY" ? apiKey : undefined, fileExists: async () => false };
const models = createModels({ authContext }); models.setProvider(openrouterProvider());
```

Other ways that also work by construction: `createModels({ credentials })` with an `InMemoryCredentialStore` seeded via `modify("openrouter", async () => ({type:"api_key", key}))` (async), or `Agent({ getApiKey: p => key })`, or `options.apiKey` in a StreamFn. Wire check against the real adapter: `Authorization: Bearer <key>` (chat) / `x-api-key` (anthropic path), `x-session-id` header when `sessionId` set (OpenRouter), `provider: {require_parameters:true}` in the chat body.

### Model catalog facts (installed 1.0.0 catalog)

- `models.getModel("openrouter", id)` -> `Model | undefined`; 399 chat models: 384 `openai-completions` (baseUrl `https://openrouter.ai/api/v1`), **15 `anthropic-messages`** (baseUrl `https://openrouter.ai/api`, no `/v1`; they are the `anthropic/claude-*` ids without a suffix, e.g. `anthropic/claude-sonnet-4.6`, `-opus-4.x/5`, `-fable-5`, `-haiku-4.5`), plus 14 `anthropic/...:batch` ids that are on openai-completions.
- Model literal that works for unknown ids (`openRouterModel`): `{ id, name, api:"openai-completions", provider:"openrouter", baseUrl:"https://openrouter.ai/api/v1", reasoning:false, input:["text","image"], cost:{input:0,output:0,cacheRead:0,cacheWrite:0} /* $/M tokens */, contextWindow:128000, maxTokens:16384, compat:{ thinkingFormat:"openrouter", sendSessionAffinityHeaders:true } }`. pi's openai-completions adapter auto-detects OpenRouter from provider id/baseUrl (developer role, `cache_control` "anthropic" format for `anthropic/*` ids, `x-session-id` affinity), so the literal needs no more compat.
- `compat.openRouterRouting` copy: `{...base, compat:{...base.compat, openRouterRouting:{...prev, require_parameters:true}}}`; catalog object and its `compat` are never mutated (tested; the catalog `compat` object itself is shared so it must be copied too).

### Shapes

```ts
Usage = { input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost:{input,output,cacheRead,cacheWrite,total} }  // cost in USD, computed from the CATALOG price
AssistantMessage = { role:"assistant", content:(text|thinking|toolCall)[], api, provider, model, responseId?, responseModel?, thinkingLevel?, usage, stopReason:"pending"|"stop"|"length"|"toolUse"|"error"|"aborted"|"deferred", errorMessage?, timestamp }
ToolResultMessage = { role:"toolResult", toolCallId, toolName, content:(text|image)[], details?, usage?, isError, timestamp }
UserMessage = { role:"user", content: string | (text|image)[], timestamp }
SystemMessage = { role:"system", content: string|text[], sections?:Record<string,string|null>, toolsAdded?:Tool[], toolsRemoved?:{name}[], timestamp }
ImageContent = { type:"image", data:<base64>, mimeType }
```
Everything is plain JSON. Only key whose value is `undefined` in a live transcript: `toolResult.usage` (dropped by JSON; harmless).

### Agent

```ts
new Agent({ initialState:{ systemPrompt, model, thinkingLevel:"off", tools, messages }, streamFn, sessionId, getApiKey,
  toolExecution:"parallel"|"sequential", beforeToolCall, afterToolCall, finishTurn, prepareRequest,
  prepareNextTurn /* (signal)=>{messages?,context?,model?,thinkingLevel?}|undefined */, prepareNextTurnWithContext,
  steeringMode, followUpMode, transformContext, convertToLlm, onPayload, onResponse, onProviderStreamEvent, thinkingBudgets, transport, maxRetryDelayMs })
```
- `StreamFn = (model, TranscriptContext, SimpleStreamOptions?) => AssistantMessageEventStream | Promise<...>`; `models.streamSimple.bind(models)` satisfies it. NOTE the possible Promise: `await fn(...)` before `.result()`.
- The loop calls `streamFn(model, ctx, { ...config, apiKey, signal })`. What actually reaches the provider from the Agent: `apiKey, signal, reasoning, sessionId, onPayload, onResponse, onProviderStreamEvent, transport:"auto", thinkingBudgets, maxRetryDelayMs`. **Nothing else**: `maxRetries, cacheRetention, timeoutMs, maxTokens, temperature, headers, metadata, fetch, env` can only be set in a StreamFn wrapper.
- Public: `agent.prompt(string | AgentMessage | AgentMessage[])`, `.prompt(text, images)`, `.continue()`, `.steer(msg)`, `.followUp(msg)`, `.abort()`, `.waitForIdle()`, `.signal`, `.reset()`, `.state.{messages,tools,model,thinkingLevel,systemPrompt(read-only),isStreaming,pendingToolCalls,errorMessage}`, `.subscribe((event, signal)=>...)` (awaited in order; `prompt()` resolves only after awaited `agent_end` listeners).
- `agent.state.messages = arr` / `.tools = arr` copy the array.
- Events: `agent_start, turn_start, message_start/update/end, tool_execution_start/update/end, turn_end{message,toolResults}, agent_end{messages}` (the `messages` are only this run's new messages).

### Tools (a)

```ts
const parameters = Type.Unsafe<TArgs>(rawJsonSchema);          // returns the raw object unchanged: JSON.stringify(parameters) === JSON.stringify(raw)
const tool: AgentTool<typeof parameters, TDetails> = { name, label, description, parameters,
  execute: async (toolCallId, args, signal, onUpdate) => ({ content:[{type:"text",text},{type:"image",data,mimeType}], details }) };
```
`src/tools.ts#toolFromJsonSchema` wraps this and adds `strict`. Throwing from `execute` (or returning `isError:true`) becomes a toolResult with `isError:true`.

### Faux provider

```ts
const faux = fauxProvider({ tokensPerSecond?, models?:[{id,contextWindow,...}] });     // provider id "faux", api = random "faux:<ts>:<rand>"
const models = createModels(); models.setProvider(faux.provider); const model = faux.getModel();
faux.setResponses([ fauxAssistantMessage("text"), fauxAssistantMessage([fauxToolCall("name", {..}, {id:"c1"})], {stopReason:"toolUse"}),
                    (context, options, state, model) => AssistantMessage /* factory: inspect the exact request */ ]);
faux.state.callCount; faux.getPendingResponseCount();
```
Steps are consumed one per model call (including summarizer calls). Usage is ESTIMATED by the faux (chars/4 of the serialized prompt/output); `cost` is always 0; you cannot script usage numbers (the estimate overwrites it), so unit-test usage-dependent logic (compaction thresholds) with hand-built messages.

## 3. Findings per task item

### 1. models.ts: works as specified, plus two things you must know
- `createEditorModels({apiKey})`, `openRouterModel(models,id)`, `createStreamFn(models, defaults)`: all tested (13 tests).
- `createStreamFn` merge rule: per-call values win, **`undefined` never clobbers a default** (the Agent always sends `sessionId: undefined`, `onPayload: undefined`...), `headers` shallow-merged, `onPayload/onResponse/onProviderStreamEvent` chained (defaults first). Verified with faux that signal, sessionId, reasoning, transport arrive intact next to `maxRetries:3, cacheRetention:"short"`.
- **pi's default is NO retries** (`maxRetries ?? 0` in `utils/provider-retry.ts`; the adapters call the SDK with `maxRetries:0` and retry themselves). Tested against a fake server returning 503 twice: without `maxRetries` 1 request and an error; with `maxRetries:3` success on the 3rd request. Retry covers only failures BEFORE the stream starts; a mid-stream drop ends the run with `stopReason:"error"`. The Agent class has no agent-level retry (pi's `retryAssistantCall` exists in pi-ai but coding-agent wires it, not Agent); recipe in section 4.
- **`compat.openRouterRouting` only affects `openai-completions` models.** The 15 catalog `anthropic/*` models are `anthropic-messages` and ignore it (verified: the request body has no `provider` field). The compat flag is still set on them (as requested) but is a no-op. `withOpenRouterRoutingPayload()` (an `onPayload` hook) injects `provider:{require_parameters:true}` into the anthropic payload; the injection is tested, but whether OpenRouter's `/messages` endpoint accepts/honours `provider` is UNVERIFIED (no network).

### 2. cost.ts
- chat-completions: `onProviderStreamEvent(data, model)` receives the **raw parsed `ChatCompletionChunk`** before pi touches it (`openai-completions.ts:554`). pi's own `parseChunkUsage` (`:1511`) ignores `usage.cost`; the hook is the only way to see it. Tested through the real adapter against the fake server: 5 data events arrive (comment lines and `[DONE]` do not), the last one has `choices: []` and `usage.cost`.
- anthropic-messages: `data` is the raw Anthropic `RawMessageStreamEvent` (`anthropic-messages.ts:664`): `message_start` (has `message.id` and input usage), `content_block_*`, `message_delta` (usage), `message_stop`. Verified order through the real adapter. **Whether OpenRouter's Anthropic-compatible endpoint puts `usage.cost` in `message_delta` CANNOT be verified without network**; `cost.ts` checks `message_start.message.usage.cost` and `message_delta.usage.cost` if present, otherwise falls back to the estimate.
- The OpenRouter wire shape of the final usage chunk (`usage.cost`, `is_byok`, `cost_details.upstream_inference_cost`) is from OpenRouter's documentation/memory, NOT captured from the live service. The fake server imitates it. Do one live smoke call with a real key before relying on it.
- Matching: by `message.responseId` (chat: `chunk.id`; anthropic: `message_start.message.id`). Chat path is safe under parallel requests; the anthropic path remembers the "current" id from `message_start`, so use one tracker per sequential request lane (Agent lane vs compaction lane).
- API: `tracker.onProviderStreamEvent` (pass as Agent option or StreamFn default) and `tracker.takeCost(assistantMessage) -> {costUsd, estimated, source, byok?, upstreamCostUsd?}`; fallback `usage.cost.total` with `estimated:true`. Full-stack test: Agent + real adapter + fake server, `takeCost` at `message_end`. Memory bounded (64 pending).

### 3. Engine loop (a-j): everything works, with these caveats
- **a** raw schema via `Type.Unsafe` works; `required`, nullable `["integer","null"]`, `additionalProperties:false`, enum, minimum all enforced. **Gotcha: validation is lenient.** pi runs `Value.Convert` plus its own coercion first: `"12"`->12, 7->"7", `[1]`->`["1"]`, and **`null` for a non-nullable required integer becomes 0, for a non-nullable string becomes ""** and passes. Use `toolFromJsonSchema({strict:true})` (checks the raw schema in `prepareArguments`, before coercion) if you want exactness. Nullable unions keep `null`.
- **b** image blocks in a tool result reach the next request intact; `onUpdate` produces `tool_execution_update` events. Also verified through the real adapters: openai-completions puts the image on the wire as a `data:image/jpeg;base64,...` URL, anthropic-messages emits a `tool_result` block containing the image. The JPEG in tests is a placeholder byte string (never decoded).
- **c** `toolExecution:"sequential"` verified (B starts only after A ends); default parallel verified; per-tool `executionMode:"sequential"` forces the whole batch sequential. In parallel mode `tool_execution_end` events arrive in COMPLETION order (immediately-failing calls first) while toolResult messages stay in assistant order: key UI state by `callId`.
- **d** `beforeToolCall(ctx, signal)` may await a promise; `{block:true, reason}` yields an `isError` toolResult whose text is the reason; the tool never runs. `tool_execution_start` fires BEFORE the hook, so the UI sees the call as pending while waiting for approval (`agent.state.pendingToolCalls.has(id)`). **The hook must honour the signal itself**: the loop awaits it forever otherwise. If the signal aborted by the time it returns, the loop discards the hook's reason and writes `"Operation aborted"`.
- **e** `steer()` during a tool: delivered after the WHOLE batch (the second tool call still runs), before the next request. Exact transcript: `assistant(toolUse a,b), toolResult a, toolResult b, user(steer), assistant`.
  `abort()` mid-tool: the tool's `signal` is `agent.signal` and flips to aborted; run ends; `agent_end` last assistant has `stopReason:"aborted"`, `errorMessage:"Request was aborted"`, `agent.state.errorMessage` set. **Transcript after abort in sequential mode:**
  ```
  system, user:go, assistant(toolUse):call:A#a call:B#b, toolResult#a(error):A aborted, assistant(aborted):(empty)
  ```
  i.e. call **B has no toolResult** (sequential mode stops after the aborted call). In parallel mode every call gets a result ("A aborted", "B aborted"). When you send an orphaned transcript to pi's real adapter it inserts a synthetic `tool` message `"No result provided"` for B and drops the empty aborted assistant message (verified on the wire). So resuming is safe, but the saved transcript itself keeps the orphan.
  **Gotcha: the loop always makes one more model request after an abort during tools.** With bare `models.streamSimple` that request fails in auth resolution and is reported as `stopReason:"error"`, "This operation was aborted". `createStreamFn` fixes this (short-circuits an already-aborted signal into a proper `aborted` message without any model call, and converts error->aborted when the signal fired mid-setup). If you do not use `createStreamFn`, pass `{abortRequested:true}` to `mapAgentEvent`.
- **f** `finishTurn` + `agent.steer(nudge)` + `return undefined` continues the loop (steer queue is polled right after `finishTurn`); capped at 2 nudges; final transcript:
  ```
  system, user:edit the timeline, assistant(toolUse):call:edit, toolResult:edit ok,
  assistant(stop):"done 1", user:[system nudge 1/2] ..., assistant(stop):"done 2", user:[system nudge 2/2] ..., assistant(stop):"done 3"
  ```
  **Gotcha: `finishTurn` also runs for `toolUse`, `error` and `aborted` turns.** Guard with `message.stopReason === "stop" && !signal?.aborted`; an unguarded `steer()` on an error turn stays queued after the run ends and leaks into the next run (tested; `agent.clearAllQueues()` is the cleanup). `{action:"continue"}` exists but has no message and loops forever if unconditional.
- **g** `<editor_state>` only on revision change: `prepareNextTurn` returning `{messages:[...]}` appends the message WITH lifecycle events (lands in `agent.state.messages` right after the toolResults). It is **not called before the first request of a run**: use `wrapPrompt()` (`agent.prompt([stateMsg, userMsg])`). Verified: not re-appended when the revision is unchanged (3 requests, exactly 2 state messages), and `syncFromTranscript()` prevents a duplicate after loading a saved transcript. `prepareRequest` runs before every request including the first but anything it adds to `context` is request-local (not in `agent.state.messages`): fine for ephemeral hints, wrong for persisted state. Transcript:
  ```
  system, user:<editor_state revision="1">..., user:cut the intro, assistant(toolUse):edit, toolResult, user:<editor_state revision="2">..., assistant(toolUse):read, toolResult, assistant(stop)
  ```
- **h** `initialState.systemPrompt + tools` become `messages[0] = {role:"system", content, toolsAdded:[{name,description,parameters}], timestamp:0}` (declaration = name/description/parameters only; the raw JSON schema is preserved). `agent.state.systemPrompt` is a read-only replay (assignment throws). Ways to change it between runs, all tested: append a system message with `content` (adds instructions), `sections:{name: string|null}` (replace/remove named blocks), or `replaceSystemPrompt(agent, prompt)` (collapses all system messages into one new head, keeping tools). **Tool list:** `agent.state.tools = [...]`; before the next request pi diffs executable tools against the transcript's declarations and inserts a `{role:"system", toolsAdded, toolsRemoved}` message before the new prompt; unchanged declarations (same JSON) insert nothing. A call to a tool that is no longer executable returns `"Tool X not found"` (isError).
- **i** save/load: `JSON.stringify(agent.state.messages)` -> `JSON.parse` -> `new Agent({initialState:{messages}})` or `agent.state.messages = loaded`. Lossless (image content, usage, thinking blocks); stable under a second round trip. A transcript starting with a system message is used as is; with unchanged tools no delta message is added. `continue()` works from a user/toolResult tail; throws `Cannot continue from message role: assistant` on an assistant tail (also after an error turn: recipe `agent.state.messages = msgs.slice(0,-1); await agent.continue()`, tested).
- **j** `mapAgentEvent` (src/events.ts) tested end to end. Surfacing: **`agent.prompt()` never rejects for provider errors or aborts.** The run ends `turn_end` then `agent_end`; the last assistant message in `agent_end.messages` carries `stopReason:"error"|"aborted"` and `errorMessage` ("Request was aborted" for aborts; the provider error text otherwise); `agent.state.errorMessage` is set from `turn_end`. A throwing streamFn is caught by `Agent` and turned into an empty assistant message with `stopReason:"error"`, `errorMessage` = the exception text. A partial text response aborted mid-stream is kept in the transcript (content so far, stopReason "aborted"). Also: `stopReason:"length"` with tool calls: pi refuses to execute them ("output token limit... Re-issue", isError) rather than run truncated arguments.
  Sample mapped stream (compressed): `thinking_delta, text_delta, tool_start{callId,name,args}, tool_progress{callId,partial}, tool_end{callId,ok,result}, turn_end{usage:{input,output,cacheRead,cacheWrite,totalTokens,estimatedCostUsd,responseId?,stopReason}}, text_delta, turn_end, run_end{reason:"done"}`.

### 4. compaction.ts
- Vendored/adapted from `packages/coding-agent/src/core/compaction/{compaction,utils}.ts` (MIT, header credits `earendil-works/pi`, "Copyright (c) 2025 Mario Zechner"). No session classes; summarizer goes through an injected `streamFn` (or a `completeSimple`-style `complete`); `cacheRetention:"none"`, `maxTokens = min(0.8*reserveTokens(16384), model.maxTokens)` as in pi; tool results truncated to 2000 chars; checkpoint format = pi's (Goal, Constraints & Preferences, Progress/Done/In Progress/Blocked, Key Decisions, Next Steps, Critical Context) + **`## Visual findings`** (also in the UPDATE prompt, "preserve every existing entry"). Images are replaced by `[N image(s) omitted: image/jpeg]` markers in the serialized conversation so the summarizer knows where frames were (pi's serializer would silently drop image-only tool results).
- `estimateContextTokens`/`calculateContextTokens`/`estimateMessageTokens` are NOT exported from the pi-ai root; import from `@earendil-works/pi-ai/utils/estimate` (works, tested).
- `shouldCompact(messages, window, {thresholdRatio=0.6})`: `estimateContextTokens(messages).tokens > window*ratio` (strictly greater); uses last non-aborted/non-error assistant usage with `totalTokens>0`, plus chars/4 for later messages (images = 1200 tokens). pi-ai ignores an assistant's usage when a newer-timestamped message precedes it, so the summary message gets a timestamp newer than every kept message: the stale pre-compaction usage of kept assistants can't instantly retrigger compaction (tested).
- `findCutIndex(messages, keepRecentTokens=20000)`: pi's algorithm; candidates are user/assistant messages only; property-tested on 150 random transcripts x 7 budgets (including >20 cuts landing on assistant messages with tool calls): never a toolResult/system cut, never an orphaned call or result. Returns the first conversation index when everything fits.
- `compact(messages, opts)` returns `{summaryMessage, keptMessages, tokensBefore, systemMessage, messages, summary, usage}` where `messages = [replayed system head, summaryMessage, ...keptMessages]` is ready for `new Agent({initialState:{messages}})`. The summary is a plain `user` message (no custom role). It collapses all system messages into one replayed head (prompt, sections, tool declarations) so tool deltas in summarized history aren't lost. Throws `NothingToCompactError` when nothing is before the cut. A leading summary message from an earlier compaction is auto-detected and passed as `<previous-summary>` with the UPDATE prompt. Differences from pi: single summary call even for split turns (pi makes a second "turn prefix" call), no file-operation tracking, no branch summaries.
- Tests: (i) threshold/ratio/trailing-estimate/aborted-usage cases; (ii) invariants + property test; (iii) exactly one summarizer call (`faux.state.callCount === 1`) whose prompt contains "Visual findings", the serialized text, no image data (no `/9j/` bytes), 2000-char truncation, `cacheRetention:"none"`, `maxTokens:13107`, signal forwarded; error/length/tool-call/abort responses throw; (iv) real Agent transcript -> compact -> JSON round trip -> new Agent continues with transcript `[system, summary, ...kept, user]`.

## 5. Things that do NOT work as the docs/README suggest (blunt)

1. README quick start (`streamFn: models.streamSimple.bind(models)`) mis-reports aborts-during-tools as errors and does nothing for retries/caching defaults. Use `createStreamFn`.
2. pi's retry default is 0. The adapters' doc comment says the SDK default is 2; irrelevant, pi forces 0 and uses its own helper. You must pass `maxRetries`. No mid-stream retry anywhere in Agent.
3. `compat.openRouterRouting` is silently ignored for anthropic-messages models (15 catalog Claude ids).
4. Tool-argument validation coerces instead of rejecting (null -> 0 / "" for non-nullable fields). Nullable unions are fine. Strictness is opt-in (`prepareArguments`).
5. Sequential abort leaves unanswered tool calls in the saved transcript (adapters patch it at send time with "No result provided"). If you want a clean transcript, append your own synthetic `toolResult` messages for missing ids after an abort.
6. `finishTurn` is called for error/aborted/toolUse turns, and a steer queued there is not cleared.
7. `prepareNextTurn` is not called before the first request; `prepareRequest` changes aren't persisted.
8. Faux provider: usage is estimated (len/4) and cost 0 (can't script usage); an empty response queue yields an error "No more faux responses queued"; the abort gotcha DOES reproduce with faux, because it comes from the `Models` layer (auth resolution) in front of the provider, not from the provider.
9. `StreamFn` may return a Promise, so TypeScript forces `await` before `.result()`.
10. Parallel tool completion events are not in call order.
11. `typescript@7.0.2` (the native compiler) + `tsx@4.23.15` + Node 24 worked without any config beyond `allowImportingTsExtensions` + `noEmit`; imports in `src/` use explicit `.ts` extensions.

## 6. Not verified (no network / no real key)

- Live OpenRouter wire formats (cost field, `provider` in `/messages`), real JPEG decoding, real rate-limit behaviour, whether `anthropic/*` via `/api/v1/messages` returns `usage.cost`.
- Concurrency of two Agents sharing one `Models` (not exercised).
- `thinking` levels against a real reasoning model (only the `reasoning` option plumbing).
