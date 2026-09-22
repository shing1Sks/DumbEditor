import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config, parse } from "dotenv";

export const userConfigPath = join(homedir(), ".dumbeditor", ".env");

export function loadEnvironment(packageRoot: string): void {
  for (const path of [userConfigPath, join(process.cwd(), ".env"), join(packageRoot, ".env")]) {
    if (existsSync(path)) config({ path, override: false, quiet: true });
  }
}

export async function runSetup(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Setup needs an interactive terminal so API keys can be entered without echoing them.");
  }
  const saved = await readSavedConfig();
  process.stdout.write("DumbEditor setup\nAPI keys are stored locally and are never printed.\n\n");

  const openai = await promptSecret(`OpenAI API key${saved.OPENAI_API_KEY ? " (Enter keeps saved key)" : ""}: `);
  const openaiKey = openai || saved.OPENAI_API_KEY;
  if (!openaiKey) throw new Error("An OpenAI API key is required.");

  const jevKey = saved.TYPESAFE_API_KEY || saved.JEV;
  const lines = [
    "# DumbEditor user configuration",
    `OPENAI_API_KEY=${JSON.stringify(openaiKey)}`,
    "OPENAI_MODEL=gpt-6-luna",
    ...(jevKey ? [`TYPESAFE_API_KEY=${JSON.stringify(jevKey)}`] : []),
    ...(saved.OPENROUTER_API_KEY ? [`OPENROUTER_API_KEY=${JSON.stringify(saved.OPENROUTER_API_KEY)}`] : []),
    "",
  ];
  await mkdir(dirname(userConfigPath), { recursive: true });
  await writeFile(userConfigPath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`\nSaved configuration to ${userConfigPath}\n`);
}

async function readSavedConfig(): Promise<Record<string, string>> {
  try {
    return parse(await readFile(userConfigPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function promptSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    const wasRaw = input.isRaw;
    let value = "";
    let settled = false;

    const restore = () => {
      input.off("data", onData);
      input.setRawMode?.(Boolean(wasRaw));
      input.pause();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      restore();
      output.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString()) {
        if (character === "\u0003") return finish(new Error("Setup cancelled."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
        } else if (character >= " ") {
          value += character;
          output.write("•");
        }
      }
    };

    output.write(prompt);
    input.resume();
    input.setEncoding("utf8");
    input.setRawMode?.(true);
    input.on("data", onData);
  });
}
