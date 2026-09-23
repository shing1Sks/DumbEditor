import type { ChatMessage, DirectEdit, Selection } from "../types.js";
import { readSettings } from "./settings.js";

const DEFAULT_MODEL = "gpt-6-luna";

type FunctionCall = { type: "function_call"; name: string; arguments: string };
type OutputMessage = { type: "message"; content?: Array<{ type?: string; text?: string }> };
type ResponsePayload = { output?: Array<FunctionCall | OutputMessage>; output_text?: string; error?: { message?: string } };

export type OpenAIDecision =
  | { kind: "edit"; edit: DirectEdit; model: string }
  | { kind: "message"; message: string; model: string };

export async function askOpenAI(options: {
  request: string;
  duration: number;
  currentTime: number;
  selection: Selection;
  history: ChatMessage[];
  signal?: AbortSignal;
}): Promise<OpenAIDecision> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OpenAI API key is missing. Run dumbeditor setup.");
  const settings = await readSettings();
  const model = settings.models.openai.text || DEFAULT_MODEL;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildRequest(options, model)),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const payload = await response.json().catch(() => ({})) as ResponsePayload;
  if (!response.ok) throw new Error(`OpenAI request failed: ${payload.error?.message ?? `HTTP ${response.status}`}`);
  return parseOpenAIResponse(payload, model);
}

export function parseOpenAIResponse(payload: ResponsePayload, model = DEFAULT_MODEL): OpenAIDecision {
  const call = payload.output?.find((item): item is FunctionCall => item.type === "function_call");
  if (!call) {
    const message = payload.output_text
      ?? payload.output?.flatMap((item) => item.type === "message" ? item.content ?? [] : []).map((item) => item.text ?? "").join("").trim();
    if (message) return { kind: "message", message, model };
    throw new Error("The OpenAI model did not return an edit or explanation.");
  }
  let args: Record<string, unknown>;
  try { args = JSON.parse(call.arguments) as Record<string, unknown>; }
  catch { throw new Error("The OpenAI model returned malformed edit arguments."); }

  if (call.name === "remove_ranges") {
    const ranges = validateRanges(args.ranges);
    return { kind: "edit", edit: { action: "remove", ranges }, model };
  }
  if (call.name === "keep_range" || call.name === "mute_range") {
    const range = validateRange(args);
    return { kind: "edit", edit: call.name === "keep_range" ? { action: "trim", range } : { action: "mute", range }, model };
  }
  if (call.name === "change_speed") {
    const range = validateRange(args);
    const factor = finiteNumber(args.factor, "factor");
    if (factor < 0.25 || factor > 16) throw new Error("The OpenAI model returned a speed outside 0.25x–16x.");
    return { kind: "edit", edit: { action: "speed", range, factor }, model };
  }
  if (call.name === "crop_video") {
    const width = integer(args.width, "width");
    const height = integer(args.height, "height");
    const x = optionalInteger(args.x, "x");
    const y = optionalInteger(args.y, "y");
    return { kind: "edit", edit: { action: "crop", width, height, ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) }, model };
  }
  if (call.name === "answer_user") {
    if (typeof args.message !== "string" || !args.message.trim()) throw new Error("The OpenAI model returned an empty answer.");
    return { kind: "message", message: args.message.trim(), model };
  }
  throw new Error(`The OpenAI model selected an unknown action: ${call.name}`);
}

function buildRequest(options: Parameters<typeof askOpenAI>[0], model: string) {
  const selected = options.selection.in !== null && options.selection.out !== null
    ? `${options.selection.in.toFixed(3)}s to ${options.selection.out.toFixed(3)}s`
    : "none";
  const recent = options.history.slice(-20).map((message) => `${message.role}: ${message.content}`).join("\n") || "none";
  return {
    model,
    reasoning: { effort: "low" },
    store: false,
    instructions: [
      "You control DumbEditor, a deterministic CLI video editor.",
      "Understand natural phrasing and choose exactly one function. Convert all time references to seconds.",
      "Use current playhead/selection when the user says here, this part, this section, before, or after.",
      "For unsupported work, questions, or ambiguity, call answer_user with one short useful message. Never invent completed work.",
    ].join(" "),
    input: `Video duration: ${options.duration.toFixed(3)} seconds\nPlayhead: ${options.currentTime.toFixed(3)} seconds\nSelected range: ${selected}\nRecent conversation:\n${recent}\n\nUser request: ${options.request}`,
    tools: TOOLS,
    tool_choice: "required",
    parallel_tool_calls: false,
  };
}

const rangeProperties = { start: { type: "number", description: "Start time in seconds" }, end: { type: "number", description: "End time in seconds" } };
const rangeSchema = { type: "object", properties: rangeProperties, required: ["start", "end"], additionalProperties: false };
const TOOLS = [
  tool("remove_ranges", "Remove one or more time ranges from the video", { type: "object", properties: { ranges: { type: "array", minItems: 1, items: rangeSchema } }, required: ["ranges"], additionalProperties: false }),
  tool("keep_range", "Keep only one time range and discard everything outside it", rangeSchema),
  tool("mute_range", "Mute the audio in one time range", rangeSchema),
  tool("change_speed", "Speed up or slow down one time range", { type: "object", properties: { ...rangeProperties, factor: { type: "number", minimum: 0.25, maximum: 16 } }, required: ["start", "end", "factor"], additionalProperties: false }),
  tool("crop_video", "Crop the whole video to a pixel rectangle", { type: "object", properties: { width: { type: "integer", minimum: 2 }, height: { type: "integer", minimum: 2 }, x: { type: ["integer", "null"], minimum: 0 }, y: { type: ["integer", "null"], minimum: 0 } }, required: ["width", "height", "x", "y"], additionalProperties: false }),
  tool("answer_user", "Answer briefly when no supported video edit should run", { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false }),
];

function tool(name: string, description: string, parameters: object) { return { type: "function", name, description, strict: true, parameters }; }
function finiteNumber(value: unknown, label: string): number { const number = Number(value); if (!Number.isFinite(number)) throw new Error(`The OpenAI model returned an invalid ${label}.`); return number; }
function integer(value: unknown, label: string): number { const number = finiteNumber(value, label); if (!Number.isInteger(number) || number < 0) throw new Error(`The OpenAI model returned an invalid ${label}.`); return number; }
function optionalInteger(value: unknown, label: string): number | undefined { return value === null || value === undefined ? undefined : integer(value, label); }
function validateRange(value: Record<string, unknown>) { const start = finiteNumber(value.start, "start time"); const end = finiteNumber(value.end, "end time"); if (Math.abs(end - start) < 0.01) throw new Error("The OpenAI model returned an empty time range."); return { start: Math.min(start, end), end: Math.max(start, end) }; }
function validateRanges(value: unknown) { if (!Array.isArray(value) || value.length === 0) throw new Error("The OpenAI model returned no time ranges."); return value.map((range) => { if (!range || typeof range !== "object") throw new Error("The OpenAI model returned an invalid time range."); return validateRange(range as Record<string, unknown>); }); }
