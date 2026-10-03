import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { accent, bold, dim, inverse, muted } from "../views/style.js";
import { box, centered, Panel, wrapIndex, type PanelContext } from "./frame.js";

export type AgentMode = "ask" | "auto";

const MODES: ReadonlyArray<{ id: AgentMode; title: string; detail: string }> = [
  { id: "ask", title: "ask", detail: "Shows what the agent wants to do and waits before it spends money, overrides a model or runs a script." },
  { id: "auto", title: "auto", detail: "The agent goes ahead on its own, including paid generation. The spend limit still applies." },
];

/** How the agent gets permission: a two-way pick, so nothing has to be typed. */
export class ModePanel extends Panel {
  private selected: number;

  constructor(context: PanelContext, private readonly options: { current: AgentMode; apply(mode: AgentMode): void; close(): void }) {
    super(context);
    this.selected = Math.max(0, MODES.findIndex((mode) => mode.id === options.current));
  }

  render(width: number): string[] {
    const panelWidth = Math.min(80, width - 4);
    const room = Math.max(10, panelWidth - 6);
    const lines = [
      bold(accent("Agent mode")),
      muted("Who decides when the agent may act?"),
      "",
      ...MODES.flatMap((mode, index) => {
        const active = index === this.selected;
        const head = `${active ? "›" : " "} ${mode.title}${mode.id === this.options.current ? "  (now)" : ""}`;
        return [active ? inverse(head) : head, ...wrapTextWithAnsi(mode.detail, room - 2).map((line) => `  ${dim(line)}`)];
      }),
      "",
      dim("↑/↓ chooses · Enter applies · Esc cancels · Shift+Tab flips it from anywhere"),
    ];
    return centered(box(lines, panelWidth, { border: "round", color: accent, paddingX: 2 }), width, this.rows);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) { this.options.close(); return; }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.selected = wrapIndex(this.selected, matchesKey(data, "up") ? -1 : 1, MODES.length);
    } else if (matchesKey(data, "enter")) {
      this.options.apply(MODES[this.selected]!.id);
      this.options.close();
      return;
    }
    this.context.requestRender();
  }
}
