import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ApprovalDecision } from "../../core/engine/events.js";
import type { ApprovalRequest } from "../state/shell-state.js";
import { bold, green, inverse, red, yellow } from "../views/style.js";
import { box, centered, Panel, wrapIndex, type PanelContext } from "./frame.js";

/** Choices shown for a request, the last one being the safe default. */
export function approvalOptions(request: ApprovalRequest): string[] {
  return request.kind === "budget" ? ["Continue", "Stop"] : ["Allow once", "Allow this session", "Deny"];
}

export function approvalDecision(request: ApprovalRequest, index: number): ApprovalDecision {
  if (request.kind === "budget") return index === 0 ? "once" : "deny";
  return (["once", "session", "deny"] as const)[index] ?? "deny";
}

const RISK_NOTE: Record<string, string> = {
  spend: "This can spend money with a model provider.",
  code: "This runs custom FFmpeg or a script the agent wrote.",
};

/** Asks before the agent spends money or runs code, or when a run reaches its spend limit. Esc denies. */
export class ApprovalPanel extends Panel {
  private selected: number;

  constructor(context: PanelContext, private readonly options: { request: ApprovalRequest; decide(decision: ApprovalDecision): void }) {
    super(context);
    this.selected = approvalOptions(options.request).length - 1;
  }

  render(width: number): string[] {
    const { request } = this.options;
    const choices = approvalOptions(request);
    const args = request.args === undefined ? null : JSON.stringify(request.args);
    // Inside the box: its two border columns and two columns of padding on each side. Long text is wrapped so the
    // user reads all of what they are about to allow.
    const room = Math.max(10, Math.min(86, width - 4) - 6);
    const lines = [
      bold(yellow(request.kind === "budget" ? "Spend limit reached" : "Permission required")),
      ...wrapTextWithAnsi(request.summary, room).map((line) => bold(line)),
      ...(RISK_NOTE[request.risk] ? wrapTextWithAnsi(RISK_NOTE[request.risk] as string, room) : []),
      ...(args ? [`Arguments: ${args}`] : []),
      "",
      choices.map((choice, index) => {
        const label = ` ${choice} `;
        return index === this.selected ? inverse((index === choices.length - 1 ? red : green)(label)) : label;
      }).join("  "),
      "←/→ or Tab chooses · Enter confirms · Esc denies",
    ];
    return centered(box(lines, Math.min(86, width - 4), { border: "round", color: yellow, paddingX: 2 }), width, this.rows);
  }

  handleInput(data: string): void {
    const { request } = this.options;
    const count = approvalOptions(request).length;
    if (matchesKey(data, "escape")) { this.options.decide("deny"); return; }
    if (matchesKey(data, "left") || matchesKey(data, "up")) this.selected = wrapIndex(this.selected, -1, count);
    else if (matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "tab")) this.selected = wrapIndex(this.selected, 1, count);
    else if (matchesKey(data, "enter")) { this.options.decide(approvalDecision(request, this.selected)); return; }
    this.context.requestRender();
  }
}
