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

export interface DumbEditorSettings {
  schemaVersion: 1;
  welcomeShown: boolean;
  agent: {
    provider: ModelProvider;
    permissionMode: AgentPermissionMode;
    claudeModel: string;
    claudeMaxBudgetUsd: number;
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
    provider: "openai",
    permissionMode: "ask",
    claudeModel: "claude-sonnet-4-6",
    claudeMaxBudgetUsd: 0.5,
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

export async function setClaudeHarnessModel(model: string): Promise<DumbEditorSettings> {
  const value = cleanModel(model, "");
  if (!value) throw new Error("Claude model IDs cannot be empty or contain spaces.");
  const settings = await readSettings();
  settings.agent.claudeModel = value;
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
      provider: raw.agent?.provider === "openrouter" ? "openrouter" : "openai",
      permissionMode: raw.agent?.permissionMode === "auto" ? "auto" : "ask",
      claudeModel: cleanModel(raw.agent?.claudeModel, DEFAULT_SETTINGS.agent.claudeModel),
      claudeMaxBudgetUsd: finiteBudget(raw.agent?.claudeMaxBudgetUsd, DEFAULT_SETTINGS.agent.claudeMaxBudgetUsd),
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

function finiteBudget(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 20 ? value : fallback;
}

function cleanModel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() && !/\s/.test(value) ? value.trim() : fallback;
}
