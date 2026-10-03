import type { ProviderModel } from "../../core/models.js";
import type { DumbEditorSettings, ModelProvider, ModelSlot, OpenAISlot, OpenRouterSlot } from "../../core/settings.js";

export type ModelCapability = "agent" | "image" | "audio" | "music" | "video" | "transcription" | "speech";
export type ModelPickerStep = "capability" | "provider" | "models";

export interface CapabilityDefinition {
  id: ModelCapability;
  label: string;
  detail: string;
  slot: ModelSlot;
  providers: ModelProvider[];
}

export const MODEL_CAPABILITIES: CapabilityDefinition[] = [
  { id: "agent", label: "Base agent", detail: "plans edits and runs tools", slot: "text", providers: ["openrouter"] },
  { id: "image", label: "Image", detail: "generated overlays and artwork", slot: "image", providers: ["openrouter"] },
  { id: "audio", label: "Audio", detail: "generated sound and speech", slot: "audio", providers: ["openrouter"] },
  { id: "music", label: "Music", detail: "generated background music", slot: "music", providers: ["openrouter"] },
  { id: "video", label: "Video", detail: "generated clips", slot: "video", providers: ["openrouter"] },
  { id: "transcription", label: "Transcription", detail: "speech to subtitles", slot: "transcription", providers: ["openai"] },
  { id: "speech", label: "Speech", detail: "text to speech", slot: "speech", providers: ["openai"] },
];

export interface ModelPickerState {
  step: ModelPickerStep;
  capability: ModelCapability;
  provider: ModelProvider | null;
  slot: ModelSlot;
  models: ProviderModel[];
  query: string;
  selectedIndex: number;
  loading: boolean;
  error: string | null;
}

export function initialModelPicker(): ModelPickerState {
  return {
    step: "capability",
    capability: "agent",
    provider: null,
    slot: "text",
    models: [],
    query: "",
    selectedIndex: 0,
    loading: false,
    error: null,
  };
}

export function capabilityDefinition(capability: ModelCapability): CapabilityDefinition {
  return MODEL_CAPABILITIES.find((item) => item.id === capability) ?? MODEL_CAPABILITIES[0]!;
}

export function filteredPickerModels(picker: ModelPickerState): ProviderModel[] {
  const query = picker.query.trim().toLowerCase();
  if (!query) return picker.models;
  return picker.models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query));
}

export function modelPricePresentation(provider: ModelProvider | null, slot: ModelSlot): {
  first: string;
  second: string;
  note: string;
} {
  if (provider === "openai" && slot === "transcription") {
    return { first: "PRICE", second: "BASIS", note: "Transcription pricing is estimated from audio duration." };
  }
  if (provider === "openai" && slot === "speech") {
    return { first: "TEXT INPUT", second: "AUDIO OUTPUT", note: "Speech prices show the provider's text and audio token rates." };
  }
  if (provider === "openrouter" && slot === "image") {
    return { first: "INPUT RATE", second: "OUTPUT RATE", note: "Image rates show their billing unit; ranges cover provider variants." };
  }
  if (provider === "openrouter" && slot === "audio") {
    return { first: "INPUT RATE", second: "OUTPUT RATE", note: "Audio rates show whether billing uses tokens or input characters." };
  }
  if (provider === "openrouter" && slot === "music") {
    return { first: "PRICE", second: "BASIS", note: "Music prices are per generated song or clip." };
  }
  if (provider === "openrouter" && slot === "video") {
    return { first: "FROM", second: "UP TO", note: "Video rates vary by resolution, audio, input type, and generation mode." };
  }
  return { first: "INPUT / 1M", second: "OUTPUT / 1M", note: "Token prices are USD per 1M tokens." };
}

export function configuredModel(settings: DumbEditorSettings, provider: ModelProvider | null, slot: ModelSlot): string {
  if (provider === "openai") return settings.models.openai[slot as OpenAISlot] ?? "";
  if (provider === "openrouter") return settings.models.openrouter[slot as OpenRouterSlot] ?? "";
  return "";
}

export function providerName(provider: ModelProvider | null): string {
  return provider === "openrouter" ? "OpenRouter" : "OpenAI";
}

export function configuredCapability(settings: DumbEditorSettings, capability: CapabilityDefinition): string {
  if (capability.id === "agent") return `${providerName(settings.agent.provider)} | ${settings.models[settings.agent.provider].text}`;
  const provider = capability.providers[0]!;
  return `${providerName(provider)} | ${configuredModel(settings, provider, capability.slot)}`;
}
