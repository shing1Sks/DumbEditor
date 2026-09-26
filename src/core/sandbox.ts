import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, relative } from "node:path";
import {
  SandboxManager,
  VENDORED_SRT_WIN_EXE,
  checkWindowsSandboxStatusAsync,
  installWindowsSandboxAsync,
  resolveSrtWin,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { AgentWorkspace } from "./agent-workspace.js";
import { runProcess } from "./process.js";

export type SandboxLanguage = "python" | "javascript";

export async function localSandboxStatus(): Promise<{ available: boolean; detail: string }> {
  if (!SandboxManager.isSupportedPlatform()) return { available: false, detail: `unsupported platform ${process.platform}` };
  if (process.platform !== "win32") {
    const dependencies = await SandboxManager.checkDependenciesAsync().catch(() => ({ errors: ["dependency check failed"] }));
    const errors = "errors" in dependencies && Array.isArray(dependencies.errors) ? dependencies.errors : [];
    return errors.length === 0
      ? { available: true, detail: "Anthropic Sandbox Runtime" }
      : { available: false, detail: errors.join("; ") };
  }
  try {
    const status = await checkWindowsSandboxStatusAsync({ srtWin: windowsHelper() });
    const available = status.user.provisioned && status.user.credPresent && status.user.inSandboxGroup && status.user.hiddenFromLogon
      && status.wfp.state !== "absent";
    return available
      ? { available: true, detail: "Anthropic Sandbox Runtime (Windows isolated user)" }
      : { available: false, detail: "Windows sandbox setup has not been completed; run dumbeditor setup" };
  } catch {
    return { available: false, detail: "Windows sandbox setup has not been completed; run dumbeditor setup" };
  }
}

export async function setupLocalSandbox(onStage?: (message: string) => void): Promise<{ available: boolean; detail: string }> {
  const current = await localSandboxStatus();
  if (current.available || process.platform !== "win32") return current;
  onStage?.("Setting up the local agent sandbox. Windows will show one UAC prompt...");
  const installed = await installWindowsSandboxAsync({ srtWin: windowsHelper() });
  if (installed.cancelled) return { available: false, detail: "sandbox setup was cancelled at the UAC prompt" };
  const next = await localSandboxStatus();
  if (!next.available) throw new Error(`Sandbox installation did not become ready: ${next.detail}`);
  return next;
}

export async function runSandboxScript(options: {
  language: SandboxLanguage;
  workspace: AgentWorkspace;
  workspacePath: string;
  activeVideoPath: string;
  arguments: string[];
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string; runtime: string }> {
  const status = await localSandboxStatus();
  if (!status.available) throw new Error(`${status.detail}.`);
  await options.workspace.readText(options.workspacePath);
  const scriptPath = await options.workspace.resolveFilePath(options.workspacePath);
  const executable = await runtimeExecutable(options.language);
  const config = sandboxConfig(options.workspace, options.activeVideoPath, executable);
  await SandboxManager.initialize(config);
  const commandId = `dumbeditor-${randomUUID()}`;
  try {
    const command = shellCommand([executable, scriptPath, options.activeVideoPath, ...options.arguments]);
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      command,
      process.platform === "win32" ? "powershell" : undefined,
      undefined,
      options.signal,
      options.workspace.root,
      { commandId, commandText: `${options.language} ${relative(options.workspace.filesDirectory, scriptPath)}` },
    );
    const executablePath = wrapped.argv[0];
    if (!executablePath) throw new Error("Sandbox runtime returned no executable.");
    const result = await runProcess(executablePath, wrapped.argv.slice(1), {
      cwd: options.workspace.root,
      env: wrapped.env,
      timeoutMs: 10 * 60_000,
      maxOutputBytes: 4_000_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return {
      stdout: result.stdout.toString("utf8"),
      stderr: SandboxManager.annotateStderrWithSandboxFailures(commandId, result.stderr),
      runtime: status.detail,
    };
  } finally {
    SandboxManager.cleanupAfterCommand();
    await SandboxManager.reset().catch(() => undefined);
  }
}

function sandboxConfig(workspace: AgentWorkspace, activeVideoPath: string, executable: string): SandboxRuntimeConfig {
  const isWindows = process.platform === "win32";
  return {
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
    filesystem: {
      denyRead: isWindows ? [] : [homedir()],
      allowRead: [workspace.root, activeVideoPath, dirname(executable)],
      allowWrite: [workspace.root],
      denyWrite: [activeVideoPath],
    },
    credentials: {
      envVars: ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"]
        .map((name) => ({ name, mode: "deny" as const })),
    },
    ...(isWindows ? { windows: { srtWin: { path: VENDORED_SRT_WIN_EXE } } } : {}),
  };
}

async function runtimeExecutable(language: SandboxLanguage): Promise<string> {
  if (language === "javascript") return process.execPath;
  const configured = process.env.DUMBEDITOR_PYTHON?.trim();
  if (configured) return configured;
  const command = process.platform === "win32" ? "where.exe" : "which";
  const result = await runProcess(command, [process.platform === "win32" ? "python.exe" : "python3"], { timeoutMs: 5_000, maxOutputBytes: 32_000 });
  const first = result.stdout.toString("utf8").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!first) throw new Error("Python was not found. Set DUMBEDITOR_PYTHON to its executable path.");
  return first;
}

function shellCommand(args: string[]): string {
  return args.map((value) => process.platform === "win32" ? powerShellQuote(value) : posixQuote(value)).join(" ");
}

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function windowsHelper() {
  return resolveSrtWin({ path: VENDORED_SRT_WIN_EXE });
}
