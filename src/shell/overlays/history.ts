import { matchesKey } from "@earendil-works/pi-tui";
import { formatTime } from "../../core/time.js";
import type { ShellState } from "../state/shell-state.js";
import { bold, dim, green, magenta } from "../views/style.js";
import { box, fill, Panel, type PanelContext } from "./frame.js";

/** The version list. Newest first; shows the latest eight unless asked for all. */
export class HistoryPanel extends Panel {
  constructor(context: PanelContext, private readonly options: { state: ShellState; showAll: boolean; close: () => void }) { super(context); }

  render(width: number): string[] {
    const { state, showAll } = this.options;
    const versions = showAll ? state.versions : state.versions.slice(0, 8);
    const lines = [
      bold(magenta("Version history")),
      ...versions.map((version) => {
        const current = version.id === state.versionId;
        const line = `${current ? "●" : "○"} ${version.id}  ${formatTime(version.duration)}  ${version.action}`;
        return current ? green(line) : line;
      }),
      dim("Use /revert v0001 · /version all · Esc to close"),
    ];
    return fill(box(lines, width, { border: "round", color: magenta }), width, this.rows);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.options.close();
  }
}
