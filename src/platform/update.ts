import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDirectory } from "../core/config.js";

const PACKAGE = "dumbeditor";
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TAG = "latest";
export const updateStatePath = join(configDirectory, "update.json");

/** What the last look at the npm registry found, and which release line (npm dist-tag) this install follows. */
export interface UpdateState { checkedAt: number; latest: string; tag: string }

export interface UpdateDeps {
  version: string;
  /** The folder the running copy lives in. */
  packageRoot: string;
  platform: NodeJS.Platform;
  fetch: typeof fetch;
  /** Runs a program with the terminal attached and resolves with its exit code. */
  run: (command: string, args: string[]) => Promise<number>;
  now: () => number;
  statePath: string;
  log: (line: string) => void;
}

export function defaultUpdateDeps(version: string, packageRoot: string): UpdateDeps {
  return {
    version, packageRoot, platform: process.platform, fetch, now: Date.now, statePath: updateStatePath,
    log: (line) => console.log(line),
    run: (command, args) => new Promise((done) => {
      // Windows needs a shell to start npm.cmd. The arguments are fixed words and a checked tag, never user text.
      const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
      child.once("error", () => done(1));
      child.once("close", (code) => done(code ?? 1));
    }),
  };
}

/** Compares "1.2.3" style versions; a release is newer than its own pre-releases ("0.2.0" > "0.2.0-next.1"). */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core = "", pre] = value.trim().replace(/^v/, "").split("-", 2);
    const numbers = core.split(".").map((part) => Number.parseInt(part, 10) || 0);
    return { numbers: [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0], pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = left.numbers[index]! - right.numbers[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

/** The version npm calls `tag` for the package, or null when the registry cannot be reached or answers oddly. */
export async function fetchTagVersion(tag: string, fetchImpl: typeof fetch, timeoutMs = 3000): Promise<string | null> {
  try {
    const response = await fetchImpl(`https://registry.npmjs.org/${PACKAGE}/${encodeURIComponent(tag)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" && VERSION.test(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

export async function readUpdateState(path: string): Promise<UpdateState | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<UpdateState>;
    if (typeof value.checkedAt !== "number" || typeof value.latest !== "string" || typeof value.tag !== "string") return null;
    return { checkedAt: value.checkedAt, latest: value.latest, tag: value.tag };
  } catch {
    return null;
  }
}

async function writeUpdateState(path: string, state: UpdateState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state)}\n`, "utf8");
}

/** A folder with .git is a source checkout (a developer's copy); it is updated with git, not npm. */
export function installKind(packageRoot: string): "source" | "npx" | "npm" {
  if (existsSync(join(packageRoot, ".git"))) return "source";
  return /[\\/]_npx[\\/]/.test(packageRoot) ? "npx" : "npm";
}

/** The line to show when a newer version exists, else null. */
export function updateNotice(version: string, state: UpdateState | null): string | null {
  if (!state || compareVersions(state.latest, version) <= 0) return null;
  const channel = state.tag === DEFAULT_TAG ? "" : ` --tag ${state.tag}`;
  return `DumbEditor ${state.latest} is available (you have ${version}). Run: dumbeditor update${channel}`;
}

/** Looks at the registry at most once a day, never throws, and gives up quickly. Reads the saved answer first so the caller can use it at once. */
export async function refreshUpdateState(deps: UpdateDeps): Promise<UpdateState | null> {
  const saved = await readUpdateState(deps.statePath);
  const tag = saved?.tag ?? DEFAULT_TAG;
  if (saved && deps.now() - saved.checkedAt < DAY_MS && saved.checkedAt <= deps.now()) return saved;
  const latest = await fetchTagVersion(tag, deps.fetch);
  if (!latest) return saved;
  const state = { checkedAt: deps.now(), latest, tag };
  await writeUpdateState(deps.statePath, state).catch(() => undefined);
  return state;
}

/** Checks are off in CI, for people who set DUMBEDITOR_NO_UPDATE_CHECK, and for source checkouts. */
export function updateChecksEnabled(env: NodeJS.ProcessEnv, packageRoot: string): boolean {
  if (env.DUMBEDITOR_NO_UPDATE_CHECK || env.CI) return false;
  return installKind(packageRoot) !== "source";
}

/** `dumbeditor update [--tag name]`: installs the newest version npm has. Returns the exit code. */
export async function runUpdate(args: string[], deps: UpdateDeps): Promise<number> {
  const tagFlag = args.indexOf("--tag");
  const requested = tagFlag >= 0 ? args[tagFlag + 1] : undefined;
  const extra = tagFlag < 0 ? args : args.filter((_, index) => index !== tagFlag && index !== tagFlag + 1);
  if (extra.length > 0 || (tagFlag >= 0 && !requested)) {
    deps.log("Usage: dumbeditor update [--tag <name>]");
    return 1;
  }
  if (requested !== undefined && !TAG.test(requested)) {
    deps.log(`"${requested}" is not a valid release tag.`);
    return 1;
  }
  const kind = installKind(deps.packageRoot);
  if (kind === "source") {
    deps.log("This copy runs from a source folder. Update it with: git pull && npm install && npm run build");
    return 1;
  }
  if (kind === "npx") {
    deps.log("You are running DumbEditor through npx, which fetches the newest version by itself: npx dumbeditor@latest\nTo keep it installed: npm install -g dumbeditor");
    return 0;
  }

  const saved = await readUpdateState(deps.statePath);
  const tag = requested ?? saved?.tag ?? DEFAULT_TAG;
  const latest = await fetchTagVersion(tag, deps.fetch, 8000);
  if (!latest) {
    deps.log("Could not reach the npm registry. Check your connection and try again.");
    return 1;
  }
  if (compareVersions(latest, deps.version) <= 0) {
    deps.log(`DumbEditor ${deps.version} is up to date.`);
    await writeUpdateState(deps.statePath, { checkedAt: deps.now(), latest, tag }).catch(() => undefined);
    return 0;
  }
  deps.log(`Updating DumbEditor ${deps.version} -> ${latest}`);
  const code = await deps.run("npm", ["install", "-g", `${PACKAGE}@${tag}`]);
  if (code !== 0) {
    deps.log(`npm could not finish (exit ${code}). Try it yourself: npm install -g ${PACKAGE}@${tag}\nIf the error says EACCES, see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally`);
    return code;
  }
  await writeUpdateState(deps.statePath, { checkedAt: deps.now(), latest, tag }).catch(() => undefined);
  deps.log(`Updated to ${latest}. Run dumbeditor --version to confirm.`);
  return 0;
}
