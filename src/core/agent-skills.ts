import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = ["video-editing", "asset-generation", "audio-music", "agent-workspace"] as const;

let cachedSkills: Promise<string> | undefined;

export function loadAgentSkills(): Promise<string> {
  cachedSkills ??= readAgentSkills();
  return cachedSkills;
}

async function readAgentSkills(): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const roots = [
    join(moduleDirectory, "..", "skills"),
    join(moduleDirectory, "..", "..", "skills"),
    join(process.cwd(), "skills"),
  ];
  for (const root of roots) {
    try {
      const contents = await Promise.all(SKILLS.map(async (name) => {
        const source = await readFile(join(root, name, "SKILL.md"), "utf8");
        return `## ${name}\n${stripFrontmatter(source).trim()}`;
      }));
      return contents.join("\n\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return "";
}

function stripFrontmatter(source: string): string {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}
