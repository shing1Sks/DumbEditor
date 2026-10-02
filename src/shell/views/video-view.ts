import type { Component } from "@earendil-works/pi-tui";
import type { ShellState } from "../state/shell-state.js";
import { dim } from "./style.js";

/** Reserves the video rectangle as blank cells. The picture itself is painted over them by the preview host. */
export class VideoView implements Component {
  constructor(private readonly state: ShellState, private readonly bandRows: () => number) {}

  render(width: number): string[] {
    const rows = this.bandRows();
    const lines = Array.from({ length: rows }, () => " ".repeat(width));
    if (!this.state.media) {
      const text = "No video loaded";
      lines[Math.floor(rows / 2)] = " ".repeat(Math.max(0, Math.floor((width - text.length) / 2))) + dim(text) + " ".repeat(Math.max(0, width - Math.floor((width - text.length) / 2) - text.length));
    }
    return lines;
  }

  invalidate(): void { /* stateless */ }
}
