import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = ["video-editing", "asset-generation", "audio-music", "agent-workspace"] as const;

export interface AgentSkill {
  name: string;
  description: string;
  body: string;
}

let cachedSkills: Promise<AgentSkill[]> | undefined;

export function loadAgentSkills(): Promise<AgentSkill[]> {
  cachedSkills ??= readAgentSkills();
  return cachedSkills;
}

/** Names and one-line descriptions for the system prompt; the agent loads a body with read_skill. */
export function skillIndex(skills: readonly AgentSkill[]): string {
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
}

async function readAgentSkills(): Promise<AgentSkill[]> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const roots = [
    join(moduleDirectory, "..", "skills"),
    join(moduleDirectory, "..", "..", "skills"),
    join(process.cwd(), "skills"),
  ];
  for (const root of roots) {
    try {
      return await Promise.all(SKILLS.map(async (name) => parseSkill(name, await readFile(join(root, name, "SKILL.md"), "utf8"))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [];
}

export function parseSkill(name: string, source: string): AgentSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  const description = match?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? name;
  return { name, description, body: source.slice(match?.[0].length ?? 0).trim() };
}
