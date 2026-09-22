import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ChatMessage, ProjectState, VersionEntry } from "../types.js";
import { probeMedia } from "./media.js";

const STATE_FILE = "project.json";
const CHAT_FILE = "chat.jsonl";

export class ProjectStore {
  private constructor(private state: ProjectState) {}

  static async open(sourcePath: string): Promise<ProjectStore> {
    const absoluteSource = resolve(sourcePath);
    const media = await probeMedia(absoluteSource);
    const slug = basename(absoluteSource, extname(absoluteSource)).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 48) || "video";
    const hash = createHash("sha256").update(absoluteSource.toLowerCase()).digest("hex").slice(0, 8);
    const projectDir = join(dirname(absoluteSource), ".dumbeditor", `${slug}-${hash}`);
    const statePath = join(projectDir, STATE_FILE);
    await mkdir(join(projectDir, "versions"), { recursive: true });
    await mkdir(join(projectDir, "agent"), { recursive: true });

    try {
      const state = JSON.parse(await readFile(statePath, "utf8")) as ProjectState;
      if (state.schemaVersion !== 1 || resolve(state.sourcePath) !== absoluteSource) throw new Error("Project state does not match source");
      return new ProjectStore(state);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }

    const first: VersionEntry = {
      id: "v0000",
      parentId: null,
      filePath: absoluteSource,
      action: "Original",
      request: "Opened source video",
      createdAt: new Date().toISOString(),
      duration: media.duration,
    };
    const state: ProjectState = {
      schemaVersion: 1,
      sourcePath: absoluteSource,
      projectDir,
      currentVersionId: first.id,
      nextVersion: 1,
      createdAt: new Date().toISOString(),
      versions: [first],
    };
    const store = new ProjectStore(state);
    await store.save();
    return store;
  }

  get snapshot(): Readonly<ProjectState> {
    return this.state;
  }

  get current(): VersionEntry {
    const version = this.state.versions.find((item) => item.id === this.state.currentVersionId);
    if (!version) throw new Error("Current version is missing from project history");
    return version;
  }

  nextOutputPath(extension = ".mp4"): string {
    const id = this.makeVersionId(this.state.nextVersion);
    return join(this.state.projectDir, "versions", `${id}${extension}`);
  }

  async commit(options: { outputPath: string; action: string; request: string; duration: number; agent?: boolean }): Promise<VersionEntry> {
    const id = this.makeVersionId(this.state.nextVersion);
    const expected = resolve(this.nextOutputPath(extname(options.outputPath) || ".mp4"));
    let finalPath = resolve(options.outputPath);
    if (finalPath !== expected) {
      await copyFile(finalPath, expected);
      finalPath = expected;
    }
    const entry: VersionEntry = {
      id,
      parentId: this.state.currentVersionId,
      filePath: finalPath,
      action: options.action,
      request: options.request,
      createdAt: new Date().toISOString(),
      duration: options.duration,
      ...(options.agent === undefined ? {} : { agent: options.agent }),
    };
    this.state.versions.push(entry);
    this.state.currentVersionId = id;
    this.state.nextVersion += 1;
    await this.save();
    return entry;
  }

  async revert(reference: string): Promise<VersionEntry> {
    const normalized = reference.trim().toLowerCase();
    const numeric = /^\d+$/.test(normalized) ? `v${normalized.padStart(4, "0")}` : normalized;
    const matches = this.state.versions.filter((version) => version.id.toLowerCase().startsWith(numeric));
    if (matches.length !== 1) throw new Error(matches.length === 0 ? `Version ${reference} was not found` : `Version ${reference} is ambiguous`);
    const version = matches[0];
    if (!version) throw new Error(`Version ${reference} was not found`);
    this.state.currentVersionId = version.id;
    await this.save();
    return version;
  }

  history(limit = 8): VersionEntry[] {
    if (!Number.isFinite(limit)) return [...this.state.versions].reverse();
    const count = Math.max(0, Math.floor(limit));
    if (count === 0) return [];
    return this.state.versions.slice(-count).reverse();
  }

  async exportCurrent(destination: string): Promise<string> {
    const output = resolve(destination);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(this.current.filePath, output);
    return output;
  }

  async addChat(role: ChatMessage["role"], content: string): Promise<void> {
    const message: ChatMessage = { role, content, at: new Date().toISOString() };
    await appendFile(join(this.state.projectDir, CHAT_FILE), `${JSON.stringify(message)}\n`, "utf8");
  }

  async chatHistory(): Promise<ChatMessage[]> {
    try {
      const raw = await readFile(join(this.state.projectDir, CHAT_FILE), "utf8");
      return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ChatMessage);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  createAgentWorkspace(): string {
    return join(this.state.projectDir, "agent", `${Date.now()}-${randomUUID().slice(0, 8)}`);
  }

  private makeVersionId(value: number): string {
    return `v${String(value).padStart(4, "0")}`;
  }

  private async save(): Promise<void> {
    await writeFile(join(this.state.projectDir, STATE_FILE), `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }
}
