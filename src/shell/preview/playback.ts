import {
  extractRawFrame, streamRawPreview,
  type PreviewBackend, type PreviewSize, type PreviewStream,
} from "../../core/media.js";
import type { MediaInfo } from "../../types.js";
import { playbackStart } from "../input/keys.js";
import { painterFor } from "./painters/index.js";

/**
 * One picture at `time`. A video has no frame at exactly its duration (the end of a seek or of playback), so the
 * request stays just inside it, and tries a little earlier again if the file's last frame is not where its length says.
 */
export async function stillFrame(filePath: string, time: number, duration: number, size: PreviewSize, signal: AbortSignal): Promise<Buffer> {
  const wanted = size.width * size.height * 3;
  const last = Math.max(0, duration - 0.1);
  const first = await extractRawFrame(filePath, Math.min(time, last), size, signal);
  if (first.length >= wanted || time < last) return first;
  return extractRawFrame(filePath, Math.max(0, duration - 0.6), size, signal);
}

export interface PlaybackInput {
  filePath: string | null | undefined;
  media: MediaInfo | null;
  /** Room for the picture, in terminal cells. */
  columns: number;
  rows: number;
  backend: PreviewBackend;
  playing: boolean;
  /** Where to show a still frame, or where playing starts. */
  time: number;
}

export interface PlaybackFrame {
  encoded: string;
  size: PreviewSize;
  backend: PreviewBackend;
  time: number;
}

export interface PlaybackCallbacks {
  onFrame(frame: PlaybackFrame): void;
  /** The video played to its end. Not called when playback is stopped or replaced. */
  onEnd(): void;
  onError(error: Error): void;
}

/**
 * Turns "what should the preview show" into pictures. While paused it shows one frame at the playhead; while
 * playing it streams frames from FFmpeg. Calling `update` again with the same input does nothing, so it can be
 * called on every state change.
 */
export class PlaybackController {
  private key = "";
  private generation = 0;
  private stopCurrent: () => void = () => undefined;
  private pending: { buffer: Buffer; time: number } | null = null;
  private draining = false;

  /** `stream` is replaceable so a test can see what the controller asks FFmpeg for. */
  constructor(private readonly callbacks: PlaybackCallbacks, private readonly deps: { stream?: typeof streamRawPreview } = {}) {}

  update(input: PlaybackInput): void {
    const key = JSON.stringify([input.filePath, input.media?.duration, input.media?.width, input.media?.height, input.columns, input.rows, input.backend, input.playing, input.playing ? null : input.time]);
    if (key === this.key) return;
    this.key = key;
    this.stop();
    const { filePath, media } = input;
    if (!filePath || !media) return;
    const painter = painterFor(input.backend);
    const size = painter.renderSize(media, input.columns, input.rows);
    if (size.width === 0 || size.height === 0) return;
    const generation = this.generation;
    const deliver = (buffer: Buffer, time: number) => this.queue(generation, buffer, time, size, input.backend);

    if (!input.playing) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        void stillFrame(filePath, input.time, media.duration, size, controller.signal)
          .then((frame) => deliver(frame, input.time))
          .catch((error: unknown) => { if (!controller.signal.aborted && generation === this.generation) this.callbacks.onError(toError(error)); });
      }, 40);
      this.stopCurrent = () => { clearTimeout(timer); controller.abort(); };
      return;
    }

    const preview: PreviewStream = (this.deps.stream ?? streamRawPreview)({
      filePath, start: playbackStart(input.time, media.duration), size, fps: painter.fps,
      onFrame: (frame, time) => deliver(frame, Math.min(time, media.duration)),
      onEnd: () => { if (generation === this.generation) this.callbacks.onEnd(); },
      onError: (error) => { if (generation === this.generation) this.callbacks.onError(error); },
    });
    this.stopCurrent = () => preview.stop();
  }

  dispose(): void {
    this.key = "";
    this.stop();
  }

  private stop(): void {
    this.generation += 1;
    this.pending = null;
    this.stopCurrent();
    this.stopCurrent = () => undefined;
  }

  /** Keep only the newest frame while the previous one is still being encoded. */
  private queue(generation: number, buffer: Buffer, time: number, size: PreviewSize, backend: PreviewBackend): void {
    if (generation !== this.generation) return;
    this.pending = { buffer, time };
    if (this.draining) return;
    this.draining = true;
    const flush = (): void => {
      const next = this.pending;
      this.pending = null;
      if (next && generation === this.generation) {
        try {
          this.callbacks.onFrame({ encoded: painterFor(backend).encode(next.buffer, size), size, backend, time: next.time });
        } catch (error) {
          this.callbacks.onError(toError(error));
        }
      }
      if (this.pending && generation === this.generation) setImmediate(flush);
      else this.draining = false;
    };
    setImmediate(flush);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
