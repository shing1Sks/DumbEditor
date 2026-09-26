import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ChatMessage, ProjectState, VersionEntry } from "../types.js";
import { probeMedia } from "./media.js";
import { createUsageEntry, isUsageEntry, summarizeUsage, type UsageEntry, type UsageSummary } from "./usage.js";

const STATE_FILE = "project.json";
const CHAT_FILE = "chat.jsonl";
const AGENT_CONTEXT_FILE = "context.jsonl";
const USAGE_FILE = "usage.jsonl";
const PROJECT_REGISTRY_FILE = "projects.json";
export const DEFAULT_VERSION_LIMIT = 5;

export interface ProjectSummary {
  name: string;
  sourcePath: string;
  projectDir: string;
  createdAt: string;
  updatedAt: string;
  currentVersionId: string;
  versionCount: number;
}

export class ProjectStore {
  private constructor(private state: ProjectState) {}

  static async open(sourcePath: string): Promise<ProjectStore> {
    const absoluteSource = resolve(sourcePath);
    const media = await probeMedia(absoluteSource);
    const { projectDir } = projectLocation(absoluteSource);
    const statePath = join(projectDir, STATE_FILE);
    await mkdir(join(projectDir, "versions"), { recursive: true });
    await mkdir(join(projectDir, "agent"), { recursive: true });

    try {
      const state = JSON.parse(await readFile(statePath, "utf8")) as ProjectState;
      if (state.schemaVersion !== 1 || resolve(state.sourcePath) !== absoluteSource) throw new Error("Project state does not match source");
      state.versionLimit = normalizeVersionLimit(state.versionLimit);
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
      updatedAt: new Date().toISOString(),
      versionLimit: DEFAULT_VERSION_LIMIT,
      versions: [first],
    };
    const store = new ProjectStore(state);
    await store.save();
    return store;
  }

  /** Start a clean session while retaining any meaningful current project as an archive. */
  static async fresh(sourcePath: string): Promise<ProjectStore> {
    const absoluteSource = resolve(sourcePath);
    await probeMedia(absoluteSource);
    const { projectRoot, projectDir } = projectLocation(absoluteSource);
    try {
      const state = JSON.parse(await readFile(join(projectDir, STATE_FILE), "utf8")) as ProjectState;
      const meaningful = state.versions.length > 1 || Boolean(state.name?.trim());
      if (meaningful) {
        const archiveDir = join(projectRoot, `${basename(projectDir)}-${archiveTimestamp(new Date())}`);
        await rename(projectDir, archiveDir);
        relocateProjectState(state, projectDir, archiveDir);
        state.updatedAt = new Date().toISOString();
        await writeFile(join(archiveDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");
      } else {
        await rm(projectDir, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return ProjectStore.open(absoluteSource);
  }

  static async openProject(projectDirectory: string): Promise<ProjectStore> {
    const projectDir = resolve(projectDirectory);
    const state = JSON.parse(await readFile(join(projectDir, STATE_FILE), "utf8")) as ProjectState;
    if (state.schemaVersion !== 1) throw new Error("Unsupported DumbEditor project format.");
    await probeMedia(state.sourcePath);
    relocateProjectState(state, state.projectDir, projectDir);
    state.versionLimit = normalizeVersionLimit(state.versionLimit);
    await mkdir(join(projectDir, "versions"), { recursive: true });
    await mkdir(join(projectDir, "agent"), { recursive: true });
    return new ProjectStore(state);
  }

  static async listProjects(nearSourcePath?: string): Promise<ProjectSummary[]> {
    const registered = await readProjectRegistry();
    const directories = new Set(registered.map((project) => resolve(project.projectDir)));
    if (nearSourcePath) {
      const { projectRoot } = projectLocation(resolve(nearSourcePath));
      try {
        for (const entry of await readdir(projectRoot, { withFileTypes: true })) {
          if (entry.isDirectory()) directories.add(join(projectRoot, entry.name));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const summaries = (await Promise.all([...directories].map(readProjectSummary))).filter((value): value is ProjectSummary => value !== null);
    const unique = [...new Map(summaries.map((project) => [project.projectDir.toLowerCase(), project])).values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    await writeProjectRegistry(unique);
    return unique;
  }

  /** Remove only DumbEditor's derived state for one source. The source media is never touched. */
  static async clean(sourcePath: string): Promise<string> {
    const absoluteSource = resolve(sourcePath);
    await probeMedia(absoluteSource);
    const { projectRoot, projectDir } = projectLocation(absoluteSource);
    const child = relative(projectRoot, projectDir);
    if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Refusing to clean a project outside the source's .dumbeditor directory.");
    await rm(projectDir, { recursive: true, force: true });
    return projectDir;
  }

  get snapshot(): Readonly<ProjectState> {
    return this.state;
  }

  get current(): VersionEntry {
    const version = this.state.versions.find((item) => item.id === this.state.currentVersionId);
    if (!version) throw new Error("Current version is missing from project history");
    return version;
  }

  get versionLimit(): number {
    return normalizeVersionLimit(this.state.versionLimit);
  }

  get name(): string {
    return projectDisplayName(this.state);
  }

  get summary(): ProjectSummary {
    return summaryFromState(this.state);
  }

  async nameFromFirstRequest(request: string): Promise<string> {
    if (!this.state.name?.trim()) {
      this.state.name = `${requestTitle(request)} · ${formatProjectTimestamp(this.state.createdAt)}`;
      await this.save();
    }
    return this.name;
  }

  async register(): Promise<void> {
    const projects = await readProjectRegistry();
    const summary = this.summary;
    const next = projects.filter((project) => resolve(project.projectDir).toLowerCase() !== resolve(summary.projectDir).toLowerCase());
    next.push(summary);
    await writeProjectRegistry(next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
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
    await this.pruneVersions();
    await this.save();
    return entry;
  }

  async setVersionLimit(limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Version limit must be a whole number from 1 to 100.");
    this.state.versionLimit = limit;
    await this.pruneVersions();
    await this.save();
    return limit;
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

  async addChat(role: ChatMessage["role"], content: string, label?: string): Promise<void> {
    const message: ChatMessage = { role, content, at: new Date().toISOString(), ...(label ? { label } : {}) };
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

  async searchChat(query: string, limit = 20): Promise<ChatMessage[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const count = Math.max(1, Math.min(50, Math.floor(limit)));
    return (await this.chatHistory())
      .filter((message) => message.content.toLowerCase().includes(normalized))
      .slice(-count);
  }

  async appendAgentContext(direction: "response" | "tool", items: unknown[]): Promise<void> {
    if (items.length === 0) return;
    const path = join(this.state.projectDir, "agent", AGENT_CONTEXT_FILE);
    const at = new Date().toISOString();
    const lines = items.map((item) => JSON.stringify({ at, direction, item })).join("\n");
    await appendFile(path, `${lines}\n`, "utf8");
  }

  async appendUsage(entry: Omit<UsageEntry, "id" | "at">): Promise<UsageEntry> {
    const recorded = createUsageEntry(entry);
    await appendFile(join(this.state.projectDir, USAGE_FILE), `${JSON.stringify(recorded)}\n`, "utf8");
    return recorded;
  }

  async usageEntries(): Promise<UsageEntry[]> {
    try {
      const raw = await readFile(join(this.state.projectDir, USAGE_FILE), "utf8");
      return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown).filter(isUsageEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async usageSummary(): Promise<UsageSummary> {
    return summarizeUsage(await this.usageEntries());
  }

  createAgentWorkspace(): string {
    return join(this.state.projectDir, "agent", "workspace");
  }

  private makeVersionId(value: number): string {
    return `v${String(value).padStart(4, "0")}`;
  }

  private async pruneVersions(): Promise<void> {
    const original = this.state.versions.find((version) => version.parentId === null) ?? this.state.versions[0];
    if (!original) return;
    const edits = this.state.versions.filter((version) => version.id !== original.id);
    if (edits.length <= this.versionLimit) return;

    const keepIds = new Set<string>();
    if (this.state.currentVersionId !== original.id) keepIds.add(this.state.currentVersionId);
    for (let index = edits.length - 1; index >= 0 && keepIds.size < this.versionLimit; index -= 1) {
      const version = edits[index];
      if (version) keepIds.add(version.id);
    }
    const kept = edits.filter((version) => keepIds.has(version.id));
    const removed = edits.filter((version) => !keepIds.has(version.id));
    const retainedIds = new Set([original.id, ...kept.map((version) => version.id)]);
    for (const version of kept) if (version.parentId && !retainedIds.has(version.parentId)) version.parentId = original.id;
    this.state.versions = [original, ...kept];
    await Promise.all(removed.map((version) => this.removeVersionFile(version.filePath)));
  }

  private async removeVersionFile(filePath: string): Promise<void> {
    const versionsDirectory = resolve(this.state.projectDir, "versions");
    const output = resolve(filePath);
    const childPath = relative(versionsDirectory, output);
    if (!childPath || childPath.startsWith("..") || isAbsolute(childPath)) return;
    await unlink(output).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private async save(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    await writeFile(join(this.state.projectDir, STATE_FILE), `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }
}

function normalizeVersionLimit(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 100 ? Number(value) : DEFAULT_VERSION_LIMIT;
}

function projectLocation(absoluteSource: string): { projectRoot: string; projectDir: string } {
  const slug = basename(absoluteSource, extname(absoluteSource)).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 48) || "video";
  const hash = createHash("sha256").update(absoluteSource.toLowerCase()).digest("hex").slice(0, 8);
  const projectRoot = resolve(dirname(absoluteSource), ".dumbeditor");
  return { projectRoot, projectDir: resolve(projectRoot, `${slug}-${hash}`) };
}

function relocateProjectState(state: ProjectState, previousDirectory: string, projectDirectory: string): void {
  const oldDirectory = resolve(previousDirectory);
  const nextDirectory = resolve(projectDirectory);
  for (const version of state.versions) {
    const child = relative(oldDirectory, resolve(version.filePath));
    if (child && !child.startsWith("..") && !isAbsolute(child)) version.filePath = join(nextDirectory, child);
  }
  state.projectDir = nextDirectory;
}

function summaryFromState(state: ProjectState): ProjectSummary {
  return {
    name: projectDisplayName(state),
    sourcePath: resolve(state.sourcePath),
    projectDir: resolve(state.projectDir),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt ?? state.createdAt,
    currentVersionId: state.currentVersionId,
    versionCount: state.versions.length,
  };
}

async function readProjectSummary(projectDirectory: string): Promise<ProjectSummary | null> {
  try {
    const projectDir = resolve(projectDirectory);
    const state = JSON.parse(await readFile(join(projectDir, STATE_FILE), "utf8")) as ProjectState;
    if (state.schemaVersion !== 1 || !state.sourcePath) return null;
    relocateProjectState(state, state.projectDir, projectDir);
    return summaryFromState(state);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function projectDisplayName(state: ProjectState): string {
  return state.name?.trim() || `${basename(state.sourcePath, extname(state.sourcePath))} · ${formatProjectTimestamp(state.createdAt)}`;
}

function requestTitle(request: string): string {
  const clean = request.replace(/\s+/g, " ").trim().replace(/[.!?,;:]+$/g, "");
  if (!clean) return "Untitled edit";
  return clean.length <= 64 ? clean : `${clean.slice(0, 61).trimEnd()}…`;
}

function formatProjectTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function archiveTimestamp(date: Date): string {
  return `${formatProjectTimestamp(date.toISOString()).replace(/[-: ]/g, "")}-${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function projectRegistryPath(): string {
  const directory = process.env.DUMBEDITOR_CONFIG_DIR?.trim() || join(homedir(), ".dumbeditor");
  return join(directory, PROJECT_REGISTRY_FILE);
}

async function readProjectRegistry(): Promise<ProjectSummary[]> {
  try {
    const value = JSON.parse(await readFile(projectRegistryPath(), "utf8")) as { projects?: ProjectSummary[] };
    return Array.isArray(value.projects) ? value.projects.filter(isProjectSummary) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

async function writeProjectRegistry(projects: ProjectSummary[]): Promise<void> {
  const path = projectRegistryPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, projects }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function isProjectSummary(value: unknown): value is ProjectSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const project = value as Partial<ProjectSummary>;
  return typeof project.name === "string" && typeof project.sourcePath === "string" && typeof project.projectDir === "string"
    && typeof project.createdAt === "string" && typeof project.updatedAt === "string"
    && typeof project.currentVersionId === "string" && typeof project.versionCount === "number";
}
