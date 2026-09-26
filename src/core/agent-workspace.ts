import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

export type AssetKind = "image" | "video" | "audio" | "music" | "file";

export interface AgentAsset {
  id: string;
  kind: AssetKind;
  path: string;
  source: "generated" | "catalog" | "agent";
  description: string;
  model?: string;
  license?: string;
  sourceUrl?: string;
  createdAt: string;
}

const MAX_TEXT_BYTES = 1_000_000;

export class AgentWorkspace {
  readonly assetsDirectory: string;
  readonly filesDirectory: string;
  private readonly manifestPath: string;

  constructor(readonly root: string) {
    this.root = resolve(root);
    this.assetsDirectory = join(this.root, "assets");
    this.filesDirectory = join(this.root, "files");
    this.manifestPath = join(this.root, "assets.json");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.assetsDirectory, { recursive: true }),
      mkdir(this.filesDirectory, { recursive: true }),
    ]);
  }

  assetPath(kind: AssetKind, extension: string): string {
    const safeExtension = /^\.[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : ".bin";
    return join(this.assetsDirectory, `${kind}-${Date.now()}-${randomUUID().slice(0, 8)}${safeExtension}`);
  }

  async registerAsset(asset: Omit<AgentAsset, "id" | "createdAt">): Promise<AgentAsset> {
    const path = this.assertInside(asset.path);
    const registered: AgentAsset = {
      ...asset,
      path,
      id: `asset_${randomUUID().slice(0, 12)}`,
      createdAt: new Date().toISOString(),
    };
    const assets = await this.assets();
    assets.push(registered);
    await writeFile(this.manifestPath, `${JSON.stringify(assets, null, 2)}\n`, "utf8");
    return registered;
  }

  async assets(): Promise<AgentAsset[]> {
    try {
      const parsed = JSON.parse(await readFile(this.manifestPath, "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isAgentAsset) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async asset(id: string): Promise<AgentAsset> {
    const asset = (await this.assets()).find((item) => item.id === id);
    if (!asset) throw new Error(`Agent asset ${id} was not found.`);
    this.assertInside(asset.path);
    return asset;
  }

  async writeText(relativePath: string, content: string): Promise<string> {
    if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) throw new Error("Agent files are limited to 1 MB.");
    const path = this.resolveRelative(this.filesDirectory, relativePath);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
    return path;
  }

  async readText(relativePath: string): Promise<string> {
    const path = this.resolveRelative(this.filesDirectory, relativePath);
    const content = await readFile(path, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) throw new Error("Agent files are limited to 1 MB.");
    return content;
  }

  async listFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.filesDirectory, { recursive: true, withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(this.filesDirectory, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async resolveFilePath(relativePath: string): Promise<string> {
    const path = this.resolveRelative(this.filesDirectory, relativePath);
    await access(path);
    return path;
  }

  async registerWorkspaceFile(kind: AssetKind, relativePath: string, description: string): Promise<AgentAsset> {
    const path = await this.resolveFilePath(relativePath);
    const details = await stat(path);
    if (!details.isFile() || details.size === 0) throw new Error("The workspace output is empty or is not a file.");
    if (details.size > 600_000_000) throw new Error("Workspace assets are limited to 600 MB.");
    return this.registerAsset({ kind, path, source: "agent", description });
  }

  private resolveRelative(base: string, requested: string): string {
    if (!requested.trim() || isAbsolute(requested) || requested.includes("\0")) throw new Error("Agent paths must be relative.");
    const path = resolve(base, requested);
    const child = relative(resolve(base), path);
    if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Agent path escapes its workspace.");
    return path;
  }

  private assertInside(requested: string): string {
    const path = resolve(requested);
    const child = relative(this.root, path);
    if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Asset path escapes the agent workspace.");
    return path;
  }
}

function isAgentAsset(value: unknown): value is AgentAsset {
  if (!value || typeof value !== "object") return false;
  const asset = value as Partial<AgentAsset>;
  return typeof asset.id === "string"
    && ["image", "video", "audio", "music", "file"].includes(asset.kind ?? "")
    && typeof asset.path === "string"
    && typeof asset.description === "string"
    && typeof asset.createdAt === "string"
    && typeof extname(asset.path) === "string";
}
