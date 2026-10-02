import { Input, matchesKey } from "@earendil-works/pi-tui";
import type { ChoicePrompt } from "../state/shell-state.js";
import { bold, accent, dim, inverse } from "../views/style.js";
import { box, centered, isPrintable, Panel, wrapIndex, type PanelContext } from "./frame.js";

/** The agent asks the user to pick one option, optionally with a typed answer. Esc cancels. */
export class ChoicePanel extends Panel {
  private selected = 0;
  private customActive = false;
  private readonly custom = new Input({ prompt: "" });

  constructor(context: PanelContext, private readonly options: { request: ChoicePrompt; answer(answer: string | null): void }) { super(context); }

  render(width: number): string[] {
    const { request } = this.options;
    const panelWidth = Math.min(92, width - 4);
    this.custom.focused = this.focused && this.customActive;
    const lines = [
      bold(accent("Choose a direction")),
      request.question,
      "",
      ...request.options.map((option, index) => {
        const active = !this.customActive && index === this.selected;
        return active ? inverse(`› ${option}`) : `  ${option}`;
      }),
      ...(request.allowCustom ? [
        "",
        this.customActive ? accent("Custom answer") : "Custom answer",
        ...this.custom.render(Math.max(8, panelWidth - 6)),
      ] : []),
      dim("↑/↓ chooses · Tab custom answer · Enter sends · Esc cancels"),
    ];
    return centered(box(lines, panelWidth, { border: "round", color: accent, paddingX: 2 }), width, this.rows);
  }

  handleInput(data: string): void {
    const { request } = this.options;
    if (matchesKey(data, "escape")) { this.options.answer(null); return; }
    if (matchesKey(data, "tab") && request.allowCustom) this.customActive = !this.customActive;
    else if (matchesKey(data, "enter")) {
      const answer = this.customActive ? this.custom.getValue().trim() : request.options[this.selected];
      if (answer) this.options.answer(answer);
      return;
    } else if (!this.customActive && (matchesKey(data, "up") || matchesKey(data, "down"))) {
      this.selected = wrapIndex(this.selected, matchesKey(data, "up") ? -1 : 1, request.options.length);
    } else if (this.customActive) {
      if (matchesKey(data, "up") || matchesKey(data, "down")) { this.customActive = false; this.selected = wrapIndex(this.selected, matchesKey(data, "up") ? -1 : 1, request.options.length); }
      else this.custom.handleInput(data);
    } else if (request.allowCustom && isPrintable(data)) {
      // Typing without choosing the custom box first starts a custom answer.
      this.customActive = true;
      this.custom.handleInput(data);
    }
    this.context.requestRender();
  }
}
