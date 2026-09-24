import { writeFile } from "node:fs/promises";
import type { AgentAsset, AgentWorkspace, AssetKind } from "./agent-workspace.js";
import { readSettings } from "./settings.js";

interface ImageResponse {
  data?: Array<{ b64_json?: string; media_type?: string; url?: string }>;
  error?: { message?: string };
}

interface VideoJob {
  id?: string;
  polling_url?: string;
  status?: string;
  unsigned_urls?: string[];
  error?: string | { message?: string };
}

interface MusicResponse {
  choices?: Array<{ message?: MusicMessage }>;
  error?: { message?: string };
}

interface MusicMessage {
  audio?: { data?: string; url?: string; format?: string };
  content?: string | Array<Record<string, unknown>>;
}

export interface GenerateAssetOptions {
  prompt: string;
  workspace: AgentWorkspace;
  duration?: number;
  voice?: string;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
}

export async function generateAsset(kind: Exclude<AssetKind, "file">, options: GenerateAssetOptions): Promise<AgentAsset> {
  const prompt = options.prompt.trim();
  if (!prompt) throw new Error("Asset prompt cannot be empty.");
  if (prompt.length > 8_000) throw new Error("Asset prompts are limited to 8,000 characters.");
  await options.workspace.initialize();
  const settings = await readSettings();

  if (kind === "image") {
    const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
    return openrouterKey
      ? generateOpenRouterImage(settings.models.openrouter.image, openrouterKey, options)
      : generateOpenAIImage(prompt, options);
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error(`${kind} generation needs an OpenRouter key. Run dumbeditor setup.`);
  if (kind === "video") return generateOpenRouterVideo(settings.models.openrouter.video, apiKey, options);
  if (kind === "audio") return generateOpenRouterSpeech(settings.models.openrouter.audio, apiKey, options);
  return generateOpenRouterMusic(settings.models.openrouter.music, apiKey, options);
}

async function generateOpenRouterImage(model: string, apiKey: string, options: GenerateAssetOptions): Promise<AgentAsset> {
  options.onStage?.(`Generating image with ${model}`);
  const payload = await requestJson<ImageResponse>("https://openrouter.ai/api/v1/images", apiKey, {
    model,
    prompt: options.prompt,
    aspect_ratio: "1:1",
  }, options.signal);
  const image = payload.data?.[0];
  if (!image) throw new Error("OpenRouter returned no generated image.");
  const mediaType = image.media_type ?? "image/png";
  const extension = imageExtension(mediaType);
  const path = options.workspace.assetPath("image", extension);
  if (image.b64_json) await writeBase64(path, image.b64_json, 60_000_000);
  else if (image.url) await download(image.url, path, apiKey, 60_000_000, options.signal);
  else throw new Error("OpenRouter returned an image without bytes or a URL.");
  return options.workspace.registerAsset({ kind: "image", path, source: "generated", description: options.prompt, model });
}

async function generateOpenAIImage(prompt: string, options: GenerateAssetOptions): Promise<AgentAsset> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("Image generation needs an OpenAI or OpenRouter key. Run dumbeditor setup.");
  const model = "gpt-image-1-mini";
  options.onStage?.(`Generating image with ${model}`);
  const payload = await requestJson<ImageResponse>("https://api.openai.com/v1/images/generations", apiKey, {
    model,
    prompt,
    size: "1024x1024",
    quality: "low",
  }, options.signal);
  const image = payload.data?.[0];
  if (!image?.b64_json) throw new Error("OpenAI returned no generated image bytes.");
  const path = options.workspace.assetPath("image", ".png");
  await writeBase64(path, image.b64_json, 60_000_000);
  return options.workspace.registerAsset({ kind: "image", path, source: "generated", description: prompt, model });
}

async function generateOpenRouterSpeech(model: string, apiKey: string, options: GenerateAssetOptions): Promise<AgentAsset> {
  options.onStage?.(`Generating speech with ${model}`);
  const response = await fetch("https://openrouter.ai/api/v1/audio/speech", {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ model, input: options.prompt, voice: options.voice ?? "alloy", response_format: "mp3" }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(await responseError(response, "OpenRouter speech request failed"));
  const path = options.workspace.assetPath("audio", ".mp3");
  await writeResponse(path, response, 120_000_000);
  return options.workspace.registerAsset({ kind: "audio", path, source: "generated", description: options.prompt, model });
}

async function generateOpenRouterMusic(model: string, apiKey: string, options: GenerateAssetOptions): Promise<AgentAsset> {
  options.onStage?.(`Generating music with ${model}`);
  const payload = await requestJson<MusicResponse>("https://openrouter.ai/api/v1/chat/completions", apiKey, {
    model,
    modalities: ["text", "audio"],
    messages: [{ role: "user", content: options.prompt }],
  }, options.signal);
  const media = findAudio(payload.choices?.[0]?.message);
  if (!media) throw new Error("The selected music model returned no audio data.");
  const extension = audioExtension(media.format);
  const path = options.workspace.assetPath("music", extension);
  if (media.data) await writeBase64(path, media.data, 180_000_000);
  else if (media.url) await download(media.url, path, apiKey, 180_000_000, options.signal);
  else throw new Error("The selected music model returned no downloadable audio.");
  return options.workspace.registerAsset({ kind: "music", path, source: "generated", description: options.prompt, model });
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
  return options.workspace.registerAsset({ kind: "video", path, source: "generated", description: options.prompt, model });
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

function findAudio(message: MusicMessage | undefined): { data?: string; url?: string; format?: string } | undefined {
  if (!message) return undefined;
  if (message.audio?.data || message.audio?.url) return message.audio;
  if (!Array.isArray(message.content)) return undefined;
  for (const part of message.content) {
    const audio = part.audio as Record<string, unknown> | undefined;
    const data = typeof part.data === "string" ? part.data : typeof audio?.data === "string" ? audio.data : undefined;
    const url = typeof part.url === "string" ? part.url : typeof audio?.url === "string" ? audio.url : undefined;
    const format = typeof part.format === "string" ? part.format : typeof audio?.format === "string" ? audio.format : undefined;
    if (data || url) return { ...(data ? { data } : {}), ...(url ? { url } : {}), ...(format ? { format } : {}) };
  }
  return undefined;
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
  if (format === "wav") return ".wav";
  if (format === "pcm") return ".pcm";
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
