import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const OPENROUTER_SLOTS = ["text", "image", "audio", "music", "video"] as const;
export type OpenRouterSlot = typeof OPENROUTER_SLOTS[number];
export const OPENAI_SLOTS = ["text", "transcription", "speech"] as const;
export type OpenAISlot = typeof OPENAI_SLOTS[number];
export type ModelSlot = OpenRouterSlot | OpenAISlot;
export type ModelProvider = "openai" | "openrouter";
export type AgentPermissionMode = "ask" | "auto";
export const MAX_SPEND_CEILING_USD = 1000;

export interface DumbEditorSettings {
  schemaVersion: 1;
  welcomeShown: boolean;
  agent: {
    /** Always "openrouter": the agent runs on OpenRouter only. */
    provider: ModelProvider;
    permissionMode: AgentPermissionMode;
    /** Pause and ask to continue when one agent run has spent this much. 0 disables the limit. */
    spendCeilingUsd: number;
  };
  models: {
    openai: Record<OpenAISlot, string>;
    openrouter: Record<OpenRouterSlot, string>;
  };
}

export const DEFAULT_SETTINGS: DumbEditorSettings = {
  schemaVersion: 1,
  welcomeShown: false,
  agent: {
    provider: "openrouter",
    permissionMode: "ask",
    spendCeilingUsd: 5,
  },
  models: {
    openai: {
      text: "gpt-6-luna",
      transcription: "gpt-transcribe",
      speech: "gpt-4o-mini-tts",
    },
    openrouter: {
      text: "openai/gpt-6-luna",
      image: "google/gemini-3.1-flash-lite-image",
      audio: "openai/gpt-audio-mini",
      music: "google/lyria-3-clip-preview",
      video: "google/veo-3.1-lite",
    },
  },
};

const configDirectory = process.env.DUMBEDITOR_CONFIG_DIR?.trim() || join(homedir(), ".dumbeditor");
export const settingsPath = join(configDirectory, "settings.json");

export async function readSettings(): Promise<DumbEditorSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Partial<DumbEditorSettings>;
    return normalizeSettings(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_SETTINGS);
    if (error instanceof SyntaxError) throw new Error(`DumbEditor settings are invalid: ${settingsPath}`);
    throw error;
  }
}

export async function writeSettings(settings: DumbEditorSettings): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function setDefaultModel(provider: ModelProvider, slot: ModelSlot, model: string): Promise<DumbEditorSettings> {
  const value = model.trim();
  if (!value || value.length > 200 || /\s/.test(value)) throw new Error("Model IDs cannot be empty or contain spaces.");
  const settings = await readSettings();
  if (provider === "openai") {
    if (!OPENAI_SLOTS.includes(slot as OpenAISlot)) throw new Error(`OpenAI does not support the ${slot} slot.`);
    settings.models.openai[slot as OpenAISlot] = value;
  } else {
    if (!OPENROUTER_SLOTS.includes(slot as OpenRouterSlot)) throw new Error(`OpenRouter does not support the ${slot} slot.`);
    settings.models.openrouter[slot as OpenRouterSlot] = value;
  }
  await writeSettings(settings);
  return settings;
}

export async function setBaseAgentModel(provider: ModelProvider, model: string): Promise<DumbEditorSettings> {
  if (provider !== "openrouter") throw new Error("The editor agent runs on OpenRouter only.");
  const value = model.trim();
  if (!value || value.length > 200 || /\s/.test(value)) throw new Error("Model IDs cannot be empty or contain spaces.");
  const settings = await readSettings();
  settings.models[provider].text = value;
  settings.agent.provider = provider;
  await writeSettings(settings);
  return settings;
}

export async function setAgentPermissionMode(permissionMode: AgentPermissionMode): Promise<DumbEditorSettings> {
  const settings = await readSettings();
  settings.agent.permissionMode = permissionMode;
  await writeSettings(settings);
  return settings;
}

export async function setSpendCeiling(usd: number): Promise<DumbEditorSettings> {
  if (!Number.isFinite(usd) || usd < 0 || usd > MAX_SPEND_CEILING_USD) throw new Error(`The spend limit must be between 0 and ${MAX_SPEND_CEILING_USD} dollars (0 turns it off).`);
  const settings = await readSettings();
  settings.agent.spendCeilingUsd = usd;
  await writeSettings(settings);
  return settings;
}

/** Returns true only for the first no-argument launch. */
export async function markWelcomeShown(): Promise<boolean> {
  const settings = await readSettings();
  if (settings.welcomeShown) return false;
  settings.welcomeShown = true;
  await writeSettings(settings);
  return true;
}

function normalizeSettings(raw: Partial<DumbEditorSettings>): DumbEditorSettings {
  const openrouter = raw.models?.openrouter;
  return {
    schemaVersion: 1,
    welcomeShown: raw.welcomeShown === true,
    agent: {
      provider: "openrouter",
      permissionMode: raw.agent?.permissionMode === "auto" ? "auto" : "ask",
      spendCeilingUsd: spendCeiling(raw.agent?.spendCeilingUsd, DEFAULT_SETTINGS.agent.spendCeilingUsd),
    },
    models: {
      openai: {
        text: cleanModel(raw.models?.openai?.text, DEFAULT_SETTINGS.models.openai.text),
        transcription: cleanModel(raw.models?.openai?.transcription, DEFAULT_SETTINGS.models.openai.transcription),
        speech: cleanModel(raw.models?.openai?.speech, DEFAULT_SETTINGS.models.openai.speech),
      },
      openrouter: {
        text: cleanModel(openrouter?.text, DEFAULT_SETTINGS.models.openrouter.text),
        image: cleanModel(openrouter?.image, DEFAULT_SETTINGS.models.openrouter.image),
        audio: cleanModel(openrouter?.audio, DEFAULT_SETTINGS.models.openrouter.audio),
        music: cleanModel(openrouter?.music, DEFAULT_SETTINGS.models.openrouter.music),
        video: cleanModel(openrouter?.video, DEFAULT_SETTINGS.models.openrouter.video),
      },
    },
  };
}

function spendCeiling(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SPEND_CEILING_USD ? value : fallback;
}

function cleanModel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() && !/\s/.test(value) ? value.trim() : fallback;
}
