import type { ModelProvider, OpenRouterSlot } from "./settings.js";

export interface ProviderModel {
  id: string;
  name: string;
}

interface CatalogPayload {
  data?: Array<{
    id?: string;
    name?: string;
    architecture?: { output_modalities?: string[] };
  }>;
  error?: { message?: string };
}

export async function listProviderModels(provider: ModelProvider, slot: OpenRouterSlot): Promise<ProviderModel[]> {
  return provider === "openai" ? listOpenAIModels() : listOpenRouterModels(slot);
}

async function listOpenAIModels(): Promise<ProviderModel[]> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OpenAI key missing. Run dumbeditor setup.");
  const payload = await fetchCatalog("https://api.openai.com/v1/models", key);
  return normalize(payload)
    .filter((model) => /^(gpt-|o\d|chatgpt-)/i.test(model.id))
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
    ? [{ id: item.id, name: item.name?.trim() || item.id }]
    : []);
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
