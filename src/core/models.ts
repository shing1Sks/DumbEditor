import type { ModelProvider, OpenRouterSlot } from "./settings.js";

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
  request?: string | number;
}

interface CatalogModel {
  id?: string;
  name?: string;
  architecture?: { output_modalities?: string[] };
  pricing?: CatalogPricing;
  pricing_skus?: Record<string, string | number>;
}

interface CatalogPayload {
  data?: CatalogModel[];
  error?: { message?: string };
}

const OPENAI_TOKEN_PRICES: Record<string, { inputPrice: string; outputPrice: string }> = {
  "gpt-6-luna": { inputPrice: "$0.10", outputPrice: "$0.50" },
  "gpt-6-sol": { inputPrice: "$2.00", outputPrice: "$10.00" },
  "gpt-6-astra": { inputPrice: "$10.00", outputPrice: "$50.00" },
};

export async function listProviderModels(provider: ModelProvider, slot: OpenRouterSlot): Promise<ProviderModel[]> {
  return provider === "openai" ? listOpenAIModels() : listOpenRouterModels(slot);
}

async function listOpenAIModels(): Promise<ProviderModel[]> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OpenAI key missing. Run dumbeditor setup.");
  const payload = await fetchCatalog("https://api.openai.com/v1/models", key);
  return normalize(payload)
    .filter((model) => /^(gpt-|o\d|chatgpt-)/i.test(model.id))
    .map((model) => ({ ...model, ...openAIPrice(model.id) }))
    .sort((a, b) => modelRank(a.id) - modelRank(b.id) || a.id.localeCompare(b.id));
}

async function listOpenRouterModels(slot: OpenRouterSlot): Promise<ProviderModel[]> {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
  const querySlot = slot === "music" ? "audio" : slot;
  const endpoint = slot === "image"
    ? "https://openrouter.ai/api/v1/images/models"
    : slot === "video"
      ? "https://openrouter.ai/api/v1/videos/models"
      : `https://openrouter.ai/api/v1/models?output_modalities=${encodeURIComponent(querySlot)}&sort=most-popular`;
  const payload = await fetchCatalog(endpoint, undefined, headers);
  let models = normalize(payload);
  if (slot === "music") models = models.filter((model) => /lyria|music|song/i.test(`${model.id} ${model.name}`));
  return uniqueModels(models).slice(0, 100);
}

async function fetchCatalog(url: string, bearer?: string, extraHeaders?: Record<string, string>): Promise<CatalogPayload> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...extraHeaders },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as CatalogPayload;
  if (!response.ok) throw new Error(payload.error?.message ?? `Model catalog request failed with HTTP ${response.status}.`);
  return payload;
}

function normalize(payload: CatalogPayload): ProviderModel[] {
  return (payload.data ?? []).flatMap((item) => item.id
    ? [{
      id: item.id,
      name: item.name?.trim() || item.id,
      ...priceFields(item.pricing, item.pricing_skus),
    }]
    : []);
}

function openAIPrice(id: string): Partial<ProviderModel> {
  const direct = OPENAI_TOKEN_PRICES[id];
  if (direct) return direct;
  const base = Object.keys(OPENAI_TOKEN_PRICES).find((model) => id.startsWith(`${model}-`));
  return base ? OPENAI_TOKEN_PRICES[base] ?? {} : {};
}

function priceFields(pricing?: CatalogPricing, skus?: Record<string, string | number>): Partial<ProviderModel> {
  const inputPrice = formatPerMillionPrice(pricing?.prompt ?? pricing?.input);
  const outputPrice = formatPerMillionPrice(pricing?.completion ?? pricing?.output)
    ?? formatSpecialPrice(skus)
    ?? formatPerMillionPrice(pricing?.image ?? pricing?.audio ?? pricing?.request);
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

function formatSpecialPrice(skus?: Record<string, string | number>): string | undefined {
  if (!skus) return undefined;
  const units: Array<[string, string]> = [
    ["per-song", "/song"],
    ["per_image", "/image"],
    ["per-image", "/image"],
    ["per-video-second", "/sec"],
    ["per-audio-second", "/sec"],
    ["per-minute", "/min"],
    ["per-request", "/request"],
  ];
  for (const [key, suffix] of units) {
    const value = skus[key];
    const price = Number(value);
    if (value !== undefined && Number.isFinite(price) && price >= 0) return `${formatCurrency(price)}${suffix}`;
  }
  return undefined;
}

function formatCurrency(price: number): string {
  if (price === 0) return "$0";
  if (price >= 0.01) return `$${price.toFixed(2)}`;
  if (price >= 0.0001) return `$${price.toFixed(4)}`;
  return `$${price.toPrecision(2)}`;
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
