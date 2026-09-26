import { writeFile } from "node:fs/promises";
import type { AgentAsset, AgentWorkspace, AssetKind } from "./agent-workspace.js";
import { readSettings } from "./settings.js";

interface ImageResponse {
  data?: Array<{ b64_json?: string; media_type?: string; url?: string }>;
  error?: { message?: string };
  usage?: ProviderUsage;
}

interface VideoJob {
  id?: string;
  polling_url?: string;
  status?: string;
  unsigned_urls?: string[];
  error?: string | { message?: string };
  usage?: ProviderUsage;
}

interface MusicResponse {
  choices?: Array<{ message?: MusicMessage }>;
  error?: { message?: string };
  usage?: ProviderUsage;
}

interface ProviderUsage { cost?: number; total_cost?: number }

interface MusicMessage {
  audio?: AudioMedia;
  content?: string | Array<Record<string, unknown>>;
}

interface AudioMedia { data?: string; url?: string; format?: string }

export interface GenerateAssetOptions {
  prompt: string;
  workspace: AgentWorkspace;
  duration?: number;
  voice?: string;
  provider?: "openai" | "openrouter";
  model?: string;
  providerOptions?: Record<string, unknown>;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
}

export class AssetGenerationError extends Error {
  constructor(
    message: string,
    readonly provider: "openai" | "openrouter",
    readonly model: string,
    readonly costUsd?: number,
  ) {
    super(message);
    this.name = "AssetGenerationError";
  }
}

export async function generateAsset(kind: Exclude<AssetKind, "file">, options: GenerateAssetOptions): Promise<AgentAsset> {
  const prompt = options.prompt.trim();
  if (!prompt) throw new Error("Asset prompt cannot be empty.");
  if (prompt.length > 8_000) throw new Error("Asset prompts are limited to 8,000 characters.");
  await options.workspace.initialize();
  const settings = await readSettings();
  const requestedModel = normalizedModel(options.model);

  if (kind === "image") {
    const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
    const provider = options.provider ?? (requestedModel?.includes("/") ? "openrouter" : openrouterKey && !requestedModel ? "openrouter" : "openai");
    if (provider === "openrouter") {
      if (!openrouterKey) throw new Error("OpenRouter image generation needs an OpenRouter key. Run dumbeditor setup.");
      return generateOpenRouterImage(requestedModel ?? settings.models.openrouter.image, openrouterKey, options);
    }
    return generateOpenAIImage(requestedModel ?? "gpt-image-1-mini", prompt, options);
  }

  if (kind === "audio") {
    const openAIKey = process.env.OPENAI_API_KEY?.trim();
    if (!openAIKey) throw new Error("Speech generation needs an OpenAI key. Run dumbeditor setup.");
    if (options.provider === "openrouter") throw new Error("Speech generation currently uses the OpenAI speech endpoint.");
    return generateOpenAISpeech(requestedModel ?? settings.models.openai.speech, openAIKey, options);
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error(`${kind} generation needs an OpenRouter key. Run dumbeditor setup.`);
  if (options.provider === "openai") throw new Error(`${kind} generation currently uses OpenRouter.`);
  if (kind === "video") return generateOpenRouterVideo(requestedModel ?? settings.models.openrouter.video, apiKey, options);
  return generateOpenRouterMusic(requestedModel ?? settings.models.openrouter.music, apiKey, options);
}

async function generateOpenRouterImage(model: string, apiKey: string, options: GenerateAssetOptions): Promise<AgentAsset> {
  options.onStage?.(`Generating image with ${model}`);
  const payload = await requestJson<ImageResponse>("https://openrouter.ai/api/v1/images", apiKey, {
    model,
    prompt: options.prompt,
    aspect_ratio: "1:1",
    ...providerOptions(options, ["model", "prompt"]),
  }, options.signal);
  const image = payload.data?.[0];
  if (!image) throw new Error("OpenRouter returned no generated image.");
  const mediaType = image.media_type ?? "image/png";
  const extension = imageExtension(mediaType);
  const path = options.workspace.assetPath("image", extension);
  if (image.b64_json) await writeBase64(path, image.b64_json, 60_000_000);
  else if (image.url) await download(image.url, path, apiKey, 60_000_000, options.signal);
  else throw new Error("OpenRouter returned an image without bytes or a URL.");
  return options.workspace.registerAsset({ kind: "image", path, source: "generated", description: options.prompt, model,
    ...providerCost(payload.usage) });
}

async function generateOpenAIImage(model: string, prompt: string, options: GenerateAssetOptions): Promise<AgentAsset> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("Image generation needs an OpenAI or OpenRouter key. Run dumbeditor setup.");
  options.onStage?.(`Generating image with ${model}`);
  const payload = await requestJson<ImageResponse>("https://api.openai.com/v1/images/generations", apiKey, {
    model,
    prompt,
    size: "1024x1024",
    quality: "low",
    ...providerOptions(options, ["model", "prompt"]),
  }, options.signal);
  const image = payload.data?.[0];
  if (!image?.b64_json) throw new Error("OpenAI returned no generated image bytes.");
  const path = options.workspace.assetPath("image", ".png");
  await writeBase64(path, image.b64_json, 60_000_000);
  const promptTokens = Math.ceil(prompt.length / 4);
  return options.workspace.registerAsset({ kind: "image", path, source: "generated", description: prompt, model,
    costUsd: 0.005 + promptTokens * 2 / 1_000_000, costEstimated: true });
}

async function generateOpenAISpeech(model: string, apiKey: string, options: GenerateAssetOptions): Promise<AgentAsset> {
  options.onStage?.(`Generating speech with ${model}`);
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: options.prompt, voice: options.voice ?? "marin", response_format: "mp3",
      ...providerOptions(options, ["model", "input"]) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(await responseError(response, "OpenAI speech request failed"));
  const path = options.workspace.assetPath("audio", ".mp3");
  await writeResponse(path, response, 120_000_000);
  const textTokens = Math.ceil(options.prompt.length / 4);
  const estimatedSeconds = Math.max(1, options.prompt.trim().split(/\s+/).length / 2.5);
  const audioTokens = estimatedSeconds * 25;
  return options.workspace.registerAsset({ kind: "audio", path, source: "generated", description: options.prompt, model,
    costUsd: textTokens * 0.60 / 1_000_000 + audioTokens * 12 / 1_000_000, costEstimated: true });
}

async function generateOpenRouterMusic(model: string, apiKey: string, options: GenerateAssetOptions): Promise<AgentAsset> {
  options.onStage?.(`Generating music with ${model}`);
  const payload = await requestJson<MusicResponse>("https://openrouter.ai/api/v1/chat/completions", apiKey, {
    model,
    modalities: ["text", "audio"],
    messages: [{ role: "user", content: options.prompt }],
    usage: { include: true },
    ...providerOptions(options, ["model", "messages", "modalities", "stream", "stream_options", "usage"]),
  }, options.signal);
  const media = findAudio(payload.choices?.[0]?.message);
  if (!media) throw new AssetGenerationError(
    `${model} returned no audio data. OpenRouter accepted the request, but the upstream music generation produced an empty result.`,
    "openrouter",
    model,
    providerCost(payload.usage).costUsd,
  );
  const extension = audioExtension(media.format);
  const path = options.workspace.assetPath("music", extension);
  if (media.data) await writeBase64(path, media.data, 180_000_000);
  else if (media.url) await download(media.url, path, apiKey, 180_000_000, options.signal);
  else throw new Error("The selected music model returned no downloadable audio.");
  return options.workspace.registerAsset({ kind: "music", path, source: "generated", description: options.prompt, model,
    ...providerCost(payload.usage) });
}

async function generateOpenRouterVideo(model: string, apiKey: string, options: GenerateAssetOptions): Promise<AgentAsset> {
  options.onStage?.(`Submitting video generation to ${model}`);
  let job = await requestJson<VideoJob>("https://openrouter.ai/api/v1/videos", apiKey, {
    model,
    prompt: options.prompt,
    duration: Math.max(1, Math.min(15, Math.round(options.duration ?? 5))),
    resolution: "720p",
    aspect_ratio: "16:9",
    generate_audio: false,
    ...providerOptions(options, ["model", "prompt"]),
  }, options.signal);
  const pollingUrl = openRouterUrl(job.polling_url ?? (job.id ? `/api/v1/videos/${job.id}` : ""));
  if (!pollingUrl) throw new Error("OpenRouter returned no video polling URL.");
  const deadline = Date.now() + 15 * 60_000;
  while (!["completed", "failed", "cancelled", "expired"].includes(job.status ?? "") && Date.now() < deadline) {
    options.onStage?.(`Generating video · ${job.status ?? "pending"}`);
    await delay(2_000, options.signal);
    job = await getJson<VideoJob>(pollingUrl, apiKey, options.signal);
  }
  if (job.status !== "completed") throw new Error(videoJobError(job));
  const contentUrl = openRouterUrl(job.unsigned_urls?.[0] ?? (job.id ? `/api/v1/videos/${job.id}/content` : ""));
  if (!contentUrl) throw new Error("OpenRouter completed the video but returned no content URL.");
  options.onStage?.("Downloading generated video");
  const path = options.workspace.assetPath("video", ".mp4");
  await download(contentUrl, path, apiKey, 600_000_000, options.signal);
  return options.workspace.registerAsset({ kind: "video", path, source: "generated", description: options.prompt, model,
    ...providerCost(job.usage) });
}

function providerCost(usage: ProviderUsage | undefined): { costUsd?: number; costEstimated?: boolean } {
  const value = usage?.cost ?? usage?.total_cost;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? { costUsd: value, costEstimated: false }
    : {};
}

function providerOptions(options: GenerateAssetOptions, reserved: string[]): Record<string, unknown> {
  if (!options.providerOptions) return {};
  const entries = Object.entries(options.providerOptions);
  if (entries.length > 30 || JSON.stringify(options.providerOptions).length > 10_000) throw new Error("Provider options are too large.");
  const blocked = new Set(reserved);
  return Object.fromEntries(entries.filter(([key]) => !blocked.has(key) && /^[a-z][a-z0-9_]{0,63}$/i.test(key)));
}

async function requestJson<T extends { error?: unknown }>(url: string, apiKey: string, body: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const payload = await response.json().catch(() => ({})) as T;
  if (!response.ok) throw new Error(apiErrorMessage(payload.error) ?? `${url} failed with HTTP ${response.status}.`);
  return payload;
}

async function getJson<T extends { error?: string | { message?: string } }>(url: string, apiKey: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, ...(signal ? { signal } : {}) });
  const payload = await response.json().catch(() => ({})) as T;
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : payload.error?.message ?? `Request failed with HTTP ${response.status}.`);
  return payload;
}

function findAudio(message: MusicMessage | undefined): AudioMedia | undefined {
  if (!message) return undefined;
  const direct = audioMedia(message.audio);
  if (direct) return direct;
  if (typeof message.content === "string") return audioMedia(message.content);
  if (!Array.isArray(message.content)) return undefined;
  for (const part of message.content) {
    const media = audioMedia(part.audio) ?? audioMedia(part.audio_url) ?? audioMedia(part.inline_data)
      ?? audioMedia(part.inlineData) ?? audioMedia(part.file_data) ?? audioMedia(part);
    if (media) return media;
  }
  return undefined;
}

function audioMedia(value: unknown): AudioMedia | undefined {
  if (typeof value === "string") return audioString(value);
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const format = typeof record.format === "string" ? record.format
    : typeof record.mime_type === "string" ? record.mime_type
      : typeof record.mimeType === "string" ? record.mimeType : undefined;
  const dataValue = typeof record.data === "string" ? record.data
    : typeof record.b64_json === "string" ? record.b64_json : undefined;
  const urlValue = typeof record.url === "string" ? record.url
    : typeof record.uri === "string" ? record.uri : undefined;
  if (dataValue) return audioString(dataValue, format) ?? { data: dataValue, ...(format ? { format } : {}) };
  if (urlValue) return audioString(urlValue, format) ?? { url: urlValue, ...(format ? { format } : {}) };
  return undefined;
}

function audioString(value: string, format?: string): AudioMedia | undefined {
  if (value.startsWith("data:audio/")) {
    const match = /^data:audio\/([^;,]+)(?:;[^,]*)?;base64,(.+)$/s.exec(value);
    return match ? { data: match[2]!, format: match[1]! } : undefined;
  }
  if (/^https:\/\//i.test(value)) return { url: value, ...(format ? { format } : {}) };
  return undefined;
}

function normalizedModel(value: string | undefined): string | undefined {
  const model = value?.trim();
  if (!model || ["null", "undefined", "default", "none"].includes(model.toLowerCase())) return undefined;
  return model;
}

function apiErrorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

async function download(url: string, path: string, apiKey: string, maxBytes: number, signal?: AbortSignal): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Generated asset URLs must use HTTPS.");
  const isOpenRouter = parsed.hostname === "openrouter.ai" || parsed.hostname.endsWith(".openrouter.ai");
  const response = await fetch(parsed, {
    headers: isOpenRouter ? { Authorization: `Bearer ${apiKey}` } : {},
    redirect: "follow",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(await responseError(response, "Asset download failed"));
  await writeResponse(path, response, maxBytes);
}

async function writeResponse(path: string, response: Response, maxBytes: number): Promise<void> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new Error("Generated asset is larger than DumbEditor allows.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("Generated asset response was empty.");
  if (bytes.length > maxBytes) throw new Error("Generated asset is larger than DumbEditor allows.");
  await writeFile(path, bytes);
}

async function writeBase64(path: string, value: string, maxBytes: number): Promise<void> {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) throw new Error("Generated asset data was empty.");
  if (bytes.length > maxBytes) throw new Error("Generated asset is larger than DumbEditor allows.");
  await writeFile(path, bytes);
}

function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
}

function openRouterUrl(value: string): string | undefined {
  if (!value) return undefined;
  const url = new URL(value, "https://openrouter.ai");
  return url.origin === "https://openrouter.ai" ? url.toString() : undefined;
}

function imageExtension(mediaType: string): string {
  if (mediaType.includes("svg")) return ".svg";
  if (mediaType.includes("jpeg")) return ".jpg";
  if (mediaType.includes("webp")) return ".webp";
  return ".png";
}

function audioExtension(format?: string): string {
  const normalized = format?.toLowerCase() ?? "";
  if (normalized.includes("wav")) return ".wav";
  if (normalized.includes("pcm")) return ".pcm";
  if (normalized.includes("ogg")) return ".ogg";
  if (normalized.includes("flac")) return ".flac";
  if (normalized.includes("aac")) return ".aac";
  return ".mp3";
}

function videoJobError(job: VideoJob): string {
  const detail = typeof job.error === "string" ? job.error : job.error?.message;
  if (detail) return `Video generation failed: ${detail}`;
  return job.status ? `Video generation ended with status ${job.status}.` : "Video generation timed out.";
}

async function responseError(response: Response, prefix: string): Promise<string> {
  const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
  return `${prefix}: ${payload?.error?.message ?? `HTTP ${response.status}`}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("Operation cancelled.")); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("Operation cancelled.")); }, { once: true });
  });
}
