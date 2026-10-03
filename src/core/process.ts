import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveBinary } from "./binaries.js";

const runningProcesses = new Set<ChildProcess>();

export interface ProcessResult {
  stdout: Buffer;
  stderr: string;
}

export async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveBinary(command), args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    runningProcesses.add(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    let settled = false;
    const maxOutput = options.maxOutputBytes ?? 16 * 1024 * 1024;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill();
          finish(new Error(`${command} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : null;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      runningProcesses.delete(child);
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize <= maxOutput) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize <= maxOutput) stderr.push(chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`${command} exited with code ${code}\n${Buffer.concat(stderr).toString("utf8").slice(-4000)}`));
    });
  });
}

export function spawnQuiet(command: string, args: string[], cwd?: string): ChildProcessWithoutNullStreams {
  const child = spawn(resolveBinary(command), args, {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  runningProcesses.add(child);
  child.once("close", () => runningProcesses.delete(child));
  child.once("error", () => runningProcesses.delete(child));
  return child;
}

export function trackProcess<T extends ChildProcess>(child: T): T {
  runningProcesses.add(child);
  child.once("close", () => runningProcesses.delete(child));
  child.once("error", () => runningProcesses.delete(child));
  return child;
}

/**
 * Ask a process to stop, and force it if it has not exited a moment later. On Linux and macOS `kill()` is a polite
 * SIGTERM that FFmpeg does not act on while it is blocked writing to a pipe nobody reads, so it would stay alive and
 * keep this process (or a test run) from ending.
 */
function stop(child: ChildProcess): void {
  if (!child.killed) child.kill();
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1500);
  force.unref();
  child.once("close", () => clearTimeout(force));
}

export function terminateProcess(child: ChildProcess | null | undefined): void {
  if (!child) return;
  runningProcesses.delete(child);
  stop(child);
}

/** Stop work owned by this editor instance when the user quits. */
export function terminateRunningProcesses(): void {
  for (const child of runningProcesses) stop(child);
  runningProcesses.clear();
}
