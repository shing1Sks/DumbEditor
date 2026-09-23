import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { findMusicTrack, type MusicTrack } from "./music-catalog.js";
import { terminateProcess, trackProcess } from "./process.js";

export interface MusicSelection {
  schemaVersion: 1;
  trackId: string | null;
  updatedAt: string | null;
}

export interface MusicPreviewOptions {
  volume?: number;
  startSeconds?: number;
  durationSeconds?: number;
  onEnd?: (track: MusicTrack) => void;
  onError?: (error: Error, track: MusicTrack) => void;
}

interface SpawnedMusicPreview {
  process: ChildProcess;
  errorOutput: () => string;
}

export type MusicPreviewSpawner = (track: MusicTrack, args: readonly string[]) => SpawnedMusicPreview;

const configDirectory = process.env.DUMBEDITOR_CONFIG_DIR?.trim() || join(homedir(), ".dumbeditor");
export const musicSelectionPath = join(configDirectory, "music-selection.json");

export async function readMusicSelection(path = musicSelectionPath): Promise<MusicSelection> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<MusicSelection>;
    const track = typeof raw.trackId === "string" ? findMusicTrack(raw.trackId) : null;
    return {
      schemaVersion: 1,
      trackId: track?.id ?? null,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySelection();
    if (error instanceof SyntaxError) throw new Error(`DumbEditor music selection is invalid: ${path}`);
    throw error;
  }
}

export async function selectMusicTrack(reference: string, path = musicSelectionPath): Promise<MusicSelection> {
  const track = findMusicTrack(reference);
  if (!track) throw new Error(`Music track "${reference}" was not found.`);
  return writeMusicSelection({ schemaVersion: 1, trackId: track.id, updatedAt: new Date().toISOString() }, path);
}

export async function clearMusicSelection(path = musicSelectionPath): Promise<MusicSelection> {
  return writeMusicSelection({ schemaVersion: 1, trackId: null, updatedAt: new Date().toISOString() }, path);
}

export async function selectedMusicTrack(path = musicSelectionPath): Promise<MusicTrack | null> {
  const selection = await readMusicSelection(path);
  return selection.trackId ? findMusicTrack(selection.trackId) : null;
}

export function musicPreviewArguments(track: MusicTrack, options: MusicPreviewOptions = {}): string[] {
  const volume = boundedNumber(options.volume, 70, 0, 100, "Music preview volume");
  const start = boundedNumber(options.startSeconds, 0, 0, track.durationSeconds, "Music preview start");
  const duration = boundedNumber(options.durationSeconds, 30, 1, 120, "Music preview duration");
  const available = track.durationSeconds - start;
  if (available <= 0) throw new Error("Music preview start must be before the end of the track.");
  return [
    "-nostdin", "-nodisp", "-autoexit", "-loglevel", "error",
    "-ss", start.toFixed(3), "-t", Math.min(duration, available).toFixed(3),
    "-volume", String(Math.round(volume)), track.assetUrl,
  ];
}

/** Owns at most one ffplay process and is safe to reuse as the browser selection moves. */
export class MusicPreviewController {
  private active: { track: MusicTrack; spawned: SpawnedMusicPreview } | null = null;
  private disposed = false;

  constructor(private readonly spawner: MusicPreviewSpawner = spawnMusicPreview) {}

  get activeTrack(): MusicTrack | null {
    return this.active?.track ?? null;
  }

  play(reference: string, options: MusicPreviewOptions = {}): MusicTrack {
    if (this.disposed) throw new Error("Music preview controller has been disposed.");
    const track = findMusicTrack(reference);
    if (!track) throw new Error(`Music track "${reference}" was not found.`);
    this.stop();
    const spawned = this.spawner(track, musicPreviewArguments(track, options));
    this.active = { track, spawned };
    spawned.process.once("error", (error) => {
      if (this.active?.spawned !== spawned) return;
      this.active = null;
      options.onError?.(error, track);
    });
    spawned.process.once("close", (code) => {
      if (this.active?.spawned !== spawned) return;
      this.active = null;
      if (code === 0) options.onEnd?.(track);
      else options.onError?.(new Error(spawned.errorOutput().trim() || `ffplay exited with code ${code}`), track);
    });
    return track;
  }

  stop(): void {
    const active = this.active;
    this.active = null;
    terminateProcess(active?.spawned.process);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
  }
}

async function writeMusicSelection(selection: MusicSelection, path: string): Promise<MusicSelection> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(selection, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  return selection;
}

function emptySelection(): MusicSelection {
  return { schemaVersion: 1, trackId: null, updatedAt: null };
}

function boundedNumber(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return result;
}

function spawnMusicPreview(_track: MusicTrack, args: readonly string[]): SpawnedMusicPreview {
  let stderr = "";
  const process = trackProcess(spawn("ffplay", [...args], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  }));
  process.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  return { process, errorOutput: () => stderr };
}
