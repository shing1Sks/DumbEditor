import type { ChildProcess } from "node:child_process";
import { playAudio } from "../../core/media.js";
import { terminateProcess } from "../../core/process.js";

export interface AudioInput {
  filePath: string | undefined;
  hasAudio: boolean;
  playing: boolean;
  /** Where in the video the sound should start from. */
  start: number;
  volume: number;
}

export interface AudioDeps {
  spawn?: (filePath: string, start: number, volume: number, onError: (error: Error) => void) => ChildProcess | null;
  terminate?: (child: ChildProcess | null) => void;
  /** How long a volume change waits before the sound restarts, so a burst of key presses restarts it once. */
  debounceMs?: number;
}

/**
 * Plays the video's sound while the preview plays. ffplay cannot change volume while running, so a volume
 * change restarts it; the restart is debounced.
 */
export class AudioController {
  private child: ChildProcess | null = null;
  private key = "";
  private appliedVolume = 0;
  private latest: AudioInput | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly spawn: NonNullable<AudioDeps["spawn"]>;
  private readonly terminate: NonNullable<AudioDeps["terminate"]>;
  private readonly debounceMs: number;

  constructor(private readonly onError: (message: string) => void, deps: AudioDeps = {}) {
    this.spawn = deps.spawn ?? playAudio;
    this.terminate = deps.terminate ?? terminateProcess;
    this.debounceMs = deps.debounceMs ?? 400;
  }

  update(input: AudioInput): void {
    this.latest = input;
    const active = input.playing && input.hasAudio && Boolean(input.filePath);
    const key = `${input.filePath}|${active}`;
    if (key !== this.key) {
      this.key = key;
      this.clearTimer();
      this.stop();
      if (active) this.start(input);
      return;
    }
    if (active && input.volume !== this.appliedVolume && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        const current = this.latest;
        if (!current || !(current.playing && current.hasAudio && current.filePath)) return;
        this.stop();
        this.start(current);
      }, this.debounceMs);
      this.timer.unref();
    }
  }

  dispose(): void {
    this.clearTimer();
    this.key = "";
    this.stop();
  }

  private start(input: AudioInput): void {
    if (!input.filePath) return;
    this.appliedVolume = input.volume;
    this.child = this.spawn(input.filePath, input.start, input.volume, (error) => this.onError(`Audio preview unavailable: ${error.message}`));
  }

  private stop(): void {
    this.terminate(this.child);
    this.child = null;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
