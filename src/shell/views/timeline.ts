import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { formatTime } from "../../core/time.js";
import type { Selection } from "../../types.js";
import type { ShellState } from "../state/shell-state.js";
import { accent, bad, faint, fitLine, good, info, muted } from "./style.js";

/** The transport row under the video: play state, time, the bar with the playhead and marks, length and volume. */
export class TimelineView implements Component {
  constructor(private readonly state: ShellState, private readonly geometry: () => { leftPad: number; videoColumns: number }) {}

  render(width: number): string[] {
    const { media, playhead, selection, playing, volume } = this.state;
    if (!media) return [fitLine("", width)];
    const { leftPad, videoColumns } = this.geometry();
    const time = formatTime(playhead);
    const total = formatTime(media.duration);
    const level = videoColumns >= 64 ? volumeBar(volume) : "";
    const fixed = 1 + 2 + time.length + 1 + 1 + total.length + (level ? 2 + visibleWidth(level) : 0) + 1;
    const length = Math.max(10, Math.min(120, videoColumns - fixed));
    const line = `${playing ? accent("▶") : muted("‖")} ${info(time)} ${timelineBar(playhead, media.duration, selection, length)} ${muted(total)}${level ? `  ${level}` : ""}`;
    return [fitLine(`${" ".repeat(leftPad + 1)}${line}`, width)];
  }

  invalidate(): void { /* stateless */ }
}

export function volumeBar(volume: number): string {
  const filled = Math.round(Math.max(0, Math.min(100, volume)) / 10);
  return `${faint("♪")} ${muted("▮".repeat(filled))}${faint("▯".repeat(10 - filled))} ${muted(`${volume}%`)}`;
}

/** The line itself: played part bright, the rest faint, the playhead as a diamond, in and out marks as bars. */
export function timelineBar(current: number, duration: number, selection: Selection, length: number): string {
  const cursor = position(current, duration, length);
  const inPoint = selection.in === null ? -1 : position(selection.in, duration, length);
  const outPoint = selection.out === null ? -1 : position(selection.out, duration, length);
  let bar = "";
  for (let index = 0; index < length; index += 1) {
    if (index === cursor) bar += info("◆");
    else if (index === inPoint) bar += good("▌");
    else if (index === outPoint) bar += bad("▐");
    else if (index < cursor) bar += accent("━");
    else bar += faint("─");
  }
  return bar;
}

function position(value: number, duration: number, width: number): number {
  if (duration <= 0) return 0;
  return Math.max(0, Math.min(width - 1, Math.round((value / duration) * (width - 1))));
}
