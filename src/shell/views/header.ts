import type { Component } from "@earendil-works/pi-tui";
import type { ShellState } from "../state/shell-state.js";
import { accent, bold, faint, fitLine, good, muted, onBar, shortProjectName, shorten, spaceBetween, warn } from "./style.js";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The top bar, like a breadcrumb: the name, the project and its version; and on the right what is going on. */
export class HeaderView implements Component {
  constructor(private readonly state: ShellState) {}

  render(width: number): string[] {
    const { loader, projectName, versionId } = this.state;
    const crumbs = projectName
      ? `  ${faint("›")}  ${bold(shorten(shortProjectName(projectName), Math.max(8, width - 60)))}  ${accent(versionId)}`
      : "";
    const left = `  ${accent("◆")} ${bold("DumbEditor")}${crumbs}`;
    let right: string;
    if (loader) {
      const frame = SPINNER_FRAMES[this.state.spinner % SPINNER_FRAMES.length] ?? "⠋";
      const source = loader.source === "Sandbox" ? "SANDBOX" : loader.source;
      right = warn(`${frame} ${source} · ${loader.stage}${this.state.videoMutationActive ? " · video updating" : ""}`);
    } else {
      right = projectName ? `${good("●")} ${muted("ready")}` : faint("No video");
    }
    return [onBar(fitLine(spaceBetween(left, `${right}  `, width), width))];
  }

  invalidate(): void { /* stateless */ }
}
