import type { Component } from "@earendil-works/pi-tui";
import { formatTime } from "../../core/time.js";
import { formatUsd } from "../../core/usage.js";
import type { ShellState } from "../state/shell-state.js";
import { SPINNER_FRAMES } from "./header.js";
import { chip, faint, fitLine, good, muted, shorten, spaceBetween, warn } from "./style.js";

/** The row under the play bar: the marked range on the left, the keys that matter on the right. */
export class ControlsView implements Component {
  constructor(private readonly state: ShellState, private readonly backend: () => string) {}

  render(width: number): string[] {
    const { selection } = this.state;
    const marks: string[] = [];
    if (selection.in !== null) marks.push(`in ${formatTime(selection.in)}`);
    if (selection.out !== null) marks.push(`out ${formatTime(selection.out)}`);
    if (selection.in !== null && selection.out !== null && selection.out > selection.in) marks.push(`${(selection.out - selection.in).toFixed(1)}s selected`);
    const left = marks.length > 0 ? `  ${muted(marks.join(" · "))}` : "";
    const hint = width >= 120
      ? `${this.backend().toUpperCase()} · Ctrl+P play · ←/→ seek 5s · +/- volume · [ ] marks · Ctrl+G chat  `
      : "Ctrl+P play · ←/→ seek · +/- volume · [ ] marks · Ctrl+G chat  ";
    return [fitLine(spaceBetween(left, faint(hint), width), width)];
  }

  invalidate(): void { /* stateless */ }
}

/** The bottom row: model, what has been spent, permission mode and the latest note, with the keys that matter now. */
export class StatusView implements Component {
  constructor(private readonly state: ShellState) {}

  render(width: number): string[] {
    const { loader, usage, agentModel, agentRunning, videoMutationActive, status, permissionMode } = this.state;
    const money = muted(`${formatUsd(usage.totalUsd)}`);
    const mode = chip(permissionMode, permissionMode === "auto" ? warn : muted);
    let left: string;
    let right: string;
    if (loader) {
      const frame = SPINNER_FRAMES[this.state.spinner % SPINNER_FRAMES.length] ?? "⠋";
      left = `  ${warn(frame)} ${muted(`${loader.source} is working`)}  ${money}  ${mode}`;
      right = agentRunning ? "Enter steers · Esc stops  " : videoMutationActive ? "video updating · ↑/↓ chat  " : "↑/↓ chat · ←/→ seek · Ctrl+P play  ";
    } else {
      left = `  ${good("●")} ${muted(shorten(agentModel, 26))}  ${money}  ${mode}  ${faint(shorten(status, Math.max(10, width - 90)))}`;
      right = "Enter send · Ctrl+C quit  ";
    }
    return [fitLine(spaceBetween(left, faint(right), width), width)];
  }

  invalidate(): void { /* stateless */ }
}
