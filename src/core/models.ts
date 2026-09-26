import type { ModelProvider, ModelSlot, OpenRouterSlot } from "./settings.js";

export interface ProviderModel {
  id: string;
  name: string;
  inputPrice?: string;
  outputPrice?: string;
}

interface CatalogPricing {
  prompt?: string | number;
  completion?: string | number;
  input?: string | number;
  output?: string | number;
  image?: string | number;
  audio?: string | number;
  audio_output?: string | number;
  request?: string | number;
}

interface CatalogModel {
  id?: string;
  name?: string;
  description?: string;
  endpoints?: string;
  links?: { details?: string };
  architecture?: { output_modalities?: string[] };
  pricing?: CatalogPricing;
  pricing_skus?: Record<string, string | number>;
}

interface CatalogPayload {
  data?: CatalogModel[];
  error?: { message?: string };
}

export interface BillingLine {
  billable?: string;
  unit?: string;
  cost_usd?: string | number;
  variant?: string;
}

interface ImageEndpointsPayload {
  endpoints?: Array<{ pricing?: BillingLine[] }>;
  error?: { message?: string };
}

interface ModelEndpointsPayload {
  data?: { endpoints?: Array<{ pricing?: CatalogPricing }> };
  error?: { message?: string };
}

const OPENAI_TOKEN_PRICES: Record<string, { inputPrice: string; outputPrice: string }> = {
  "gpt-6-luna": { inputPrice: "$0.10", outputPrice: "$0.50" },
  "gpt-6-sol": { inputPrice: "$2.00", outputPrice: "$10.00" },
  "gpt-6-astra": { inputPrice: "$10.00", outputPrice: "$50.00" },
};
const OPENAI_AUDIO_PRICES: Record<string, { inputPrice: string; outputPrice: string }> = {
  "gpt-transcribe": { inputPrice: "$0.0045", outputPrice: "/min" },
  "gpt-4o-mini-tts": { inputPrice: "$0.60/M tok", outputPrice: "$12.00/M tok" },
};
const CATALOG_CACHE_MS = 5 * 60_000;
const catalogCache = new Map<string, { at: number; models: ProviderModel[] }>();

export async function listProviderModels(provider: ModelProvider, slot: ModelSlot): Promise<ProviderModel[]> {
  const cacheKey = `${provider}:${slot}`;
  const cached = catalogCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CATALOG_CACHE_MS) return cached.models.map((model) => ({ ...model }));
  const models = provider === "openai" ? await listOpenAIModels(slot) : await listOpenRouterModels(slot as OpenRouterSlot);
  catalogCache.set(cacheKey, { at: Date.now(), models });
  return models.map((model) => ({ ...model }));
}

async function listOpenAIModels(slot: ModelSlot): Promise<ProviderModel[]> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OpenAI key missing. Run dumbeditor setup.");
  const payload = await fetchCatalog("https://api.openai.com/v1/models", key);
  return normalize(payload, slot)
    .filter((model) => matchesOpenAISlot(model.id, slot))
    .map((model) => ({ ...model, ...(slot === "text" ? openAIPrice(model.id) : openAIAudioPrice(model.id)) }))
    .sort((a, b) => openAIModelRank(a.id, slot) - openAIModelRank(b.id, slot) || a.id.localeCompare(b.id));
}

async function listOpenRouterModels(slot: OpenRouterSlot): Promise<ProviderModel[]> {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
  if (slot === "audio") {
    const [audio, speech] = await Promise.all([
      fetchCatalog("https://openrouter.ai/api/v1/models?output_modalities=audio&sort=most-popular", undefined, headers),
      fetchCatalog("https://openrouter.ai/api/v1/models?output_modalities=speech&sort=most-popular", undefined, headers),
    ]);
    const payload = { data: [...(audio.data ?? []), ...(speech.data ?? [])] };
    const models = uniqueModels(normalize(payload, slot))
      .filter((model) => !/lyria|music|song/i.test(`${model.id} ${model.name}`))
      .slice(0, 100);
    return attachAudioPrices(models, payload, headers);
  }
  const querySlot = slot === "music" ? "audio" : slot;
  const endpoint = slot === "image"
    ? "https://openrouter.ai/api/v1/images/models"
    : slot === "video"
      ? "https://openrouter.ai/api/v1/videos/models"
      : `https://openrouter.ai/api/v1/models?output_modalities=${encodeURIComponent(querySlot)}&sort=most-popular`;
  const payload = await fetchCatalog(endpoint, undefined, headers);
  let models = normalize(payload, slot);
  if (slot === "image") models = await attachImagePrices(models, payload, headers);
  if (slot === "music") models = models.filter((model) => /lyria|music|song/i.test(`${model.id} ${model.name}`));
  return uniqueModels(models).slice(0, 100);
}

async function fetchCatalog(url: string, bearer?: string, extraHeaders?: Record<string, string>): Promise<CatalogPayload> {
  return fetchJson<CatalogPayload>(url, bearer, extraHeaders);
}

async function fetchJson<T extends { error?: { message?: string } }>(url: string, bearer?: string, extraHeaders?: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...extraHeaders },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as T;
  if (!response.ok) throw new Error(payload.error?.message ?? `Model catalog request failed with HTTP ${response.status}.`);
  return payload;
}

function normalize(payload: CatalogPayload, slot: ModelSlot): ProviderModel[] {
  return (payload.data ?? []).flatMap((item) => item.id
    ? [{
      id: item.id,
      name: item.name?.trim() || item.id,
      ...priceFields(item.pricing, item.pricing_skus, slot, item.description, item.architecture?.output_modalities),
    }]
    : []);
}

function openAIPrice(id: string): Partial<ProviderModel> {
  const direct = OPENAI_TOKEN_PRICES[id];
  if (direct) return direct;
  const base = Object.keys(OPENAI_TOKEN_PRICES).find((model) => id.startsWith(`${model}-`));
  return base ? OPENAI_TOKEN_PRICES[base] ?? {} : {};
}

function openAIAudioPrice(id: string): Partial<ProviderModel> {
  return OPENAI_AUDIO_PRICES[id] ?? {};
}

function matchesOpenAISlot(id: string, slot: ModelSlot): boolean {
  if (slot === "transcription") return /transcribe|whisper/i.test(id);
  if (slot === "speech") return /tts/i.test(id);
  return /^(gpt-|o\d|chatgpt-)/i.test(id) && !/transcribe|tts|audio/i.test(id);
}

function openAIModelRank(id: string, slot: ModelSlot): number {
  if (slot === "transcription") return id === "gpt-transcribe" ? 0 : 10;
  if (slot === "speech") return id === "gpt-4o-mini-tts" ? 0 : 10;
  return modelRank(id);
}

function priceFields(
  pricing: CatalogPricing | undefined,
  skus: Record<string, string | number> | undefined,
  slot: ModelSlot,
  description?: string,
  outputModalities?: string[],
): Partial<ProviderModel> {
  if (slot === "video") return formatVideoPriceFields(skus);
  if (slot === "music") return formatMusicPriceFields(description);
  if (slot === "audio") {
    const speechByCharacter = outputModalities?.includes("speech") && Number(pricing?.completion ?? 0) === 0;
    const inputPrice = formatPerMillionPrice(pricing?.audio ?? pricing?.prompt);
    const outputPrice = speechByCharacter ? undefined : formatPerMillionPrice(pricing?.audio_output ?? pricing?.completion);
    const unit = speechByCharacter ? "/M char" : "/M tok";
    return {
      ...(inputPrice ? { inputPrice: `${inputPrice}${unit}` } : {}),
      ...(outputPrice ? { outputPrice: `${outputPrice}${unit}` } : {}),
    };
  }
  const inputPrice = formatPerMillionPrice(pricing?.prompt ?? pricing?.input);
  const outputPrice = formatPerMillionPrice(pricing?.completion ?? pricing?.output);
  return {
    ...(inputPrice ? { inputPrice } : {}),
    ...(outputPrice ? { outputPrice } : {}),
  };
}

export function formatPerMillionPrice(value: string | number | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const price = Number(value) * 1_000_000;
  if (!Number.isFinite(price) || price < 0) return undefined;
  return formatCurrency(price);
}

export function formatVideoPriceFields(skus?: Record<string, string | number>): Partial<ProviderModel> {
  if (!skus) return {};
  const groups = new Map<string, number[]>();
  for (const [key, rawValue] of Object.entries(skus)) {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0) continue;
    const rate = videoSkuRate(key, value);
    if (!rate) continue;
    const values = groups.get(rate.unit) ?? [];
    values.push(rate.price);
    groups.set(rate.unit, values);
  }
  const preferredUnit = ["/sec", "/M tok", "/MP·sec", "/gen", "/img"].find((unit) => groups.has(unit));
  if (!preferredUnit) return {};
  const values = [...new Set(groups.get(preferredUnit))].sort((a, b) => a - b);
  const low = values[0];
  const high = values.at(-1);
  if (low === undefined || high === undefined) return {};
  return {
    inputPrice: `${formatCurrency(low)}${preferredUnit}`,
    ...(high > low ? { outputPrice: `${formatCurrency(high)}${preferredUnit}` } : {}),
  };
}

export function formatImagePriceFields(lines: BillingLine[]): Partial<ProviderModel> {
  const inputPrice = summarizeBillingLines(lines.filter((line) => line.billable?.startsWith("input_")));
  const outputPrice = summarizeBillingLines(lines.filter((line) => line.billable?.startsWith("output_")));
  return {
    ...(inputPrice ? { inputPrice } : {}),
    ...(outputPrice ? { outputPrice } : {}),
  };
}

function videoSkuRate(key: string, value: number): { price: number; unit: string } | undefined {
  if (/cents_per_megapixel_second/i.test(key)) return { price: value / 100, unit: "/MP·sec" };
  if (/cents_per_(?:video_output_)?second|cents_per_second_output/i.test(key)) return { price: value / 100, unit: "/sec" };
  if (/duration_seconds|per-video-second/i.test(key)) return { price: value, unit: "/sec" };
  if (/video_tokens/i.test(key)) return { price: value * 1_000_000, unit: "/M tok" };
  if (/minimum_cents_per_generation/i.test(key)) return { price: value / 100, unit: "/gen" };
  if (/cents_per_image_input/i.test(key)) return { price: value / 100, unit: "/img" };
  if (key === "generate") return { price: value, unit: "/gen" };
  return undefined;
}

function formatMusicPriceFields(description?: string): Partial<ProviderModel> {
  const match = description?.match(/priced at\s+\$([0-9]+(?:\.[0-9]+)?)\s+per\s+(song|clip)/i);
  if (!match?.[1] || !match[2]) return {};
  return { inputPrice: formatCurrency(Number(match[1])), outputPrice: `per ${match[2].toLowerCase()}` };
}

function summarizeBillingLines(lines: BillingLine[]): string | undefined {
  const units = ["image", "megapixel", "token", "request"];
  for (const unit of units) {
    const values = lines
      .filter((line) => line.unit === unit)
      .map((line) => Number(line.cost_usd))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .map((value) => unit === "token" ? value * 1_000_000 : value)
      .sort((a, b) => a - b);
    const low = values[0];
    const high = values.at(-1);
    if (low === undefined || high === undefined) continue;
    const suffix = unit === "image" ? "/img" : unit === "megapixel" ? "/MP" : unit === "token" ? "/M tok" : "/req";
    return high > low ? `${formatCurrency(low)}–${formatCurrency(high)}${suffix}` : `${formatCurrency(low)}${suffix}`;
  }
  return undefined;
}

function summarizePerMillion(values: Array<string | number | undefined>, suffix: string): string | undefined {
  const prices = values
    .map((value) => value === undefined ? Number.NaN : Number(value) * 1_000_000)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const low = prices[0];
  const high = prices.at(-1);
  if (low === undefined || high === undefined) return undefined;
  return high > low ? `${formatCurrency(low)}–${formatCurrency(high)}${suffix}` : `${formatCurrency(low)}${suffix}`;
}

async function attachImagePrices(
  models: ProviderModel[],
  payload: CatalogPayload,
  headers?: Record<string, string>,
): Promise<ProviderModel[]> {
  const catalog = new Map((payload.data ?? []).flatMap((item) => item.id ? [[item.id, item] as const] : []));
  return mapConcurrent(models, 8, async (model) => {
    const endpoint = catalog.get(model.id)?.endpoints;
    if (!endpoint) return model;
    try {
      const url = new URL(endpoint, "https://openrouter.ai");
      if (url.origin !== "https://openrouter.ai") return model;
      const detail = await fetchJson<ImageEndpointsPayload>(url.toString(), undefined, headers);
      const lines = (detail.endpoints ?? []).flatMap((item) => item.pricing ?? []);
      return { ...model, ...formatImagePriceFields(lines) };
    } catch {
      return model;
    }
  });
}

async function attachAudioPrices(
  models: ProviderModel[],
  payload: CatalogPayload,
  headers?: Record<string, string>,
): Promise<ProviderModel[]> {
  const catalog = new Map((payload.data ?? []).flatMap((item) => item.id ? [[item.id, item] as const] : []));
  return mapConcurrent(models, 8, async (model) => {
    const item = catalog.get(model.id);
    const endpoint = item?.links?.details;
    if (!endpoint) return model;
    try {
      const url = new URL(endpoint, "https://openrouter.ai");
      if (url.origin !== "https://openrouter.ai") return model;
      const detail = await fetchJson<ModelEndpointsPayload>(url.toString(), undefined, headers);
      const prices = (detail.data?.endpoints ?? []).flatMap((entry) => entry.pricing ? [entry.pricing] : []);
      if (prices.length === 0) return model;
      const speechByCharacter = item.architecture?.output_modalities?.includes("speech")
        && prices.every((price) => Number(price.completion ?? 0) === 0);
      const suffix = speechByCharacter ? "/M char" : "/M tok";
      const inputPrice = summarizePerMillion(prices.map((price) => speechByCharacter ? price.prompt : price.audio ?? price.prompt), suffix);
      const outputPrice = speechByCharacter
        ? undefined
        : summarizePerMillion(prices.map((price) => price.audio_output ?? price.completion), suffix);
      return {
        ...model,
        ...(inputPrice ? { inputPrice } : {}),
        ...(outputPrice ? { outputPrice } : {}),
      };
    } catch {
      return model;
    }
  });
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) results[index] = await work(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function formatCurrency(price: number): string {
  if (price === 0) return "$0";
  if (price >= 1) return `$${price.toFixed(2)}`;
  if (price >= 0.1) return `$${price.toFixed(2)}`;
  if (price >= 0.01) return `$${trimZeros(price.toFixed(4))}`;
  if (price >= 0.0001) return `$${trimZeros(price.toFixed(6))}`;
  return `$${price.toPrecision(2)}`;
}

function trimZeros(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  let trimmed = fraction;
  while (trimmed.length > 2 && trimmed.endsWith("0")) trimmed = trimmed.slice(0, -1);
  return trimmed ? `${whole}.${trimmed}` : whole ?? value;
}

function uniqueModels(models: ProviderModel[]): ProviderModel[] {
  const seen = new Set<string>();
  return models.filter((model) => !seen.has(model.id) && Boolean(seen.add(model.id)));
}

function modelRank(id: string): number {
  if (id === "gpt-6-luna") return 0;
  if (id === "gpt-6-sol") return 1;
  if (id === "gpt-6-astra") return 2;
  return 10;
}
