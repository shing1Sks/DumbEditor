import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const OPENROUTER_SLOTS = ["text", "image", "audio", "music", "video"] as const;
export type OpenRouterSlot = typeof OPENROUTER_SLOTS[number];
export type ModelProvider = "openai" | "openrouter";

export interface DumbEditorSettings {
  schemaVersion: 1;
  welcomeShown: boolean;
  models: {
    openai: { text: string };
    openrouter: Record<OpenRouterSlot, string>;
  };
}

export const DEFAULT_SETTINGS: DumbEditorSettings = {
  schemaVersion: 1,
  welcomeShown: false,
  models: {
    openai: { text: "gpt-6-luna" },
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

export async function setDefaultModel(provider: ModelProvider, slot: OpenRouterSlot, model: string): Promise<DumbEditorSettings> {
  const value = model.trim();
  if (!value || value.length > 200 || /\s/.test(value)) throw new Error("Model IDs cannot be empty or contain spaces.");
  if (provider === "openai" && slot !== "text") throw new Error("OpenAI currently uses the text slot for editor requests.");
  const settings = await readSettings();
  if (provider === "openai") settings.models.openai.text = value;
  else settings.models.openrouter[slot] = value;
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
    models: {
      openai: { text: cleanModel(raw.models?.openai?.text, DEFAULT_SETTINGS.models.openai.text) },
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

function cleanModel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() && !/\s/.test(value) ? value.trim() : fallback;
}
