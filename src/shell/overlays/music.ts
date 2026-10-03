import { Input, matchesKey } from "@earendil-works/pi-tui";
import { listMusicTracks, searchMusicTracks, type MusicTrack } from "../../core/music-catalog.js";
import { bold, accent, dim, inverse, yellow } from "../views/style.js";
import { box, fill, isPrintable, listWindow, Panel, setValueAtEnd, wrapIndex, type PanelContext } from "./frame.js";

export interface MusicPanelServices {
  /** Start previewing a track; `onEnd` and `onError` report back when it stops. Throws if it cannot start. */
  play(trackId: string, callbacks: { onEnd(): void; onError(error: Error): void }): void;
  stop(): void;
  /** Save the choice. Reject with an Error to report it in the status line. */
  select(track: MusicTrack): Promise<void>;
  clearSelection(): Promise<void>;
  setStatus(text: string): void;
  close(): void;
}

/** Search, preview and choose background music from the open-license catalog. */
export class MusicPanel extends Panel {
  private selected = 0;
  private previewId: string | null = null;
  private readonly search = new Input({ prompt: "Search › " });

  constructor(context: PanelContext, private readonly services: MusicPanelServices, private selectedId: string | null, query: string) {
    super(context);
    setValueAtEnd(this.search, query);
  }

  get tracks(): MusicTrack[] {
    const query = this.search.getValue();
    return query.trim() ? searchMusicTracks(query) : listMusicTracks();
  }

  render(width: number): string[] {
    this.search.focused = this.focused;
    const tracks = this.tracks;
    this.selected = Math.min(this.selected, Math.max(0, tracks.length - 1));
    const { start, end } = listWindow(tracks.length, this.selected, this.rows - 12);
    const highlighted = tracks[this.selected];
    const lines = [
      `${bold(accent("Background music"))}  ${dim("open license catalog")}`,
      ...this.search.render(Math.max(10, width - 8)),
      dim("  TITLE                    MOOD                 LENGTH   LICENSE"),
      ...(tracks.length === 0 ? [yellow("No tracks match this search.")] : tracks.slice(start, end).map((track, offset) => {
        const index = start + offset;
        const marker = this.previewId === track.id ? "▶" : this.selectedId === track.id ? "✓" : " ";
        const text = `${index === this.selected ? "›" : " "} ${marker} ${fit(track.title, 24)} ${fit(track.moods.slice(0, 2).join(", "), 20)} ${fit(formatDuration(track.durationSeconds), 8)} CC BY 4.0`;
        return index === this.selected ? inverse(accent(text)) : text;
      })),
      "",
      ...(highlighted
        ? [bold(`${highlighted.title} · ${highlighted.artist}`), highlighted.description, dim(highlighted.license.attribution)]
        : [dim("Try a mood such as bright, calm, reflective, or uplifting.")]),
      dim("↑/↓ choose · Space preview/stop · Enter select · type to search · Ctrl+U clear · Ctrl+K unselect · Esc close"),
    ];
    return fill(box(lines, width, { border: "round", color: accent, paddingX: 2 }), width, this.rows);
  }

  handleInput(data: string): void {
    const tracks = this.tracks;
    if (matchesKey(data, "escape") || matchesKey(data, "left")) { this.stopPreview(); this.services.close(); return; }
    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "tab")) {
      this.selected = wrapIndex(this.selected, matchesKey(data, "up") ? -1 : 1, tracks.length);
    } else if (data === " ") {
      this.togglePreview(tracks[this.selected]);
    } else if (matchesKey(data, "enter") || matchesKey(data, "right")) {
      const track = tracks[this.selected];
      if (track) void this.choose(track);
      return;
    } else if (matchesKey(data, "ctrl+k")) {
      void this.services.clearSelection().then(() => { this.selectedId = null; this.services.setStatus("Background music selection cleared"); this.context.requestRender(); })
        .catch((error: unknown) => this.services.setStatus(message(error)));
      return;
    } else if (matchesKey(data, "ctrl+u")) {
      this.search.setValue(""); this.selected = 0;
    } else if (isPrintable(data) || matchesKey(data, "backspace") || matchesKey(data, "delete")) {
      const before = this.search.getValue();
      this.search.handleInput(data);
      if (this.search.getValue() !== before) this.selected = 0;
    }
    this.context.requestRender();
  }

  dispose(): void { this.stopPreview(); }

  private togglePreview(track: MusicTrack | undefined): void {
    if (!track) return;
    if (this.previewId === track.id) { this.stopPreview(); return; }
    try {
      this.services.play(track.id, {
        onEnd: () => { this.previewId = null; this.context.requestRender(); },
        onError: (error) => { this.previewId = null; this.services.setStatus(error.message); this.context.requestRender(); },
      });
      this.previewId = track.id;
    } catch (error) {
      this.services.setStatus(message(error));
    }
  }

  private stopPreview(): void {
    this.services.stop();
    this.previewId = null;
  }

  private async choose(track: MusicTrack): Promise<void> {
    try {
      await this.services.select(track);
      this.stopPreview();
      this.selectedId = track.id;
      this.services.close();
    } catch (error) {
      this.services.setStatus(message(error));
    }
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function fit(value: string, width: number): string {
  const clipped = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
  return clipped.padEnd(width);
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
