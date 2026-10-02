import {
  CombinedAutocompleteProvider, CURSOR_MARKER, Editor, visibleWidth, type TUI, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { CommandDefinition } from "../../core/commands.js";
import { accent, dim, faint, fitLine, muted, selected, warn } from "./style.js";

const TOP_MARK = "\u0000top";
const BOTTOM_MARK = "\u0000bottom";
/** Columns the frame takes: "│ ❯ " on the left and " │" on the right. */
const FRAME = 6;
const LEFT = 3;
/** Free columns outside the box on each side, in line with the header and the chat. */
const MARGIN = 2;

export type ComposerTone = "idle" | "working" | "blocked";

const PLACEHOLDER = "Describe an edit, or type / for commands";

/** pi-tui's multi-line editor drawn as a rounded box with a prompt, a title in the top edge and a hint when empty. */
class StudioEditor extends Editor {
  title = "";
  tone: ComposerTone = "idle";
  private above = 0;
  private below = 0;

  protected override renderTopBorder(_width: number, hiddenLineCount: number): string { this.above = hiddenLineCount; return TOP_MARK; }
  protected override renderBottomBorder(_width: number, hiddenLineCount: number): string { this.below = hiddenLineCount; return BOTTOM_MARK; }

  override render(width: number): string[] {
    const inner = Math.max(1, width - FRAME - MARGIN * 2);
    const lines = super.render(inner);
    const top = lines.indexOf(TOP_MARK);
    const bottom = lines.indexOf(BOTTOM_MARK);
    if (top < 0 || bottom < 0) return lines;
    const edge = this.tone === "idle" ? faint : warn;
    const content = lines.slice(top + 1, bottom);
    if (this.getText() === "" && content.length > 0) {
      const cursor = this.focused ? `${CURSOR_MARKER}\u001B[7m \u001B[0m` : " ";
      content[0] = fitLine(`${cursor}${faint(PLACEHOLDER)}`, inner);
    }
    const outside = " ".repeat(MARGIN);
    const boxWidth = width - MARGIN * 2;
    const rows = content.map((line, index) => `${outside}${edge("│")} ${index === 0 ? accent("❯") : " "} ${fitLine(line, inner)} ${edge("│")}`);
    return [
      outside + this.frameEdge("╭", "╮", boxWidth, [this.title, this.above > 0 ? `↑ ${this.above} more` : ""].filter(Boolean).join(" · "), edge),
      ...rows,
      outside + this.frameEdge("╰", "╯", boxWidth, this.below > 0 ? `↓ ${this.below} more` : "", edge),
      ...lines.slice(bottom + 1).map((line) => `${" ".repeat(LEFT + MARGIN)}${line}`),
    ];
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return super.handleMouse({ ...event, x: event.x - LEFT - MARGIN, width: Math.max(1, event.width - FRAME - MARGIN * 2) });
  }

  private frameEdge(left: string, right: string, width: number, label: string, edge: (text: string) => string): string {
    const text = label ? ` ${label} ` : "";
    const room = Math.max(0, width - 2 - 1);
    const shown = visibleWidth(text) > room - 1 ? text.slice(0, Math.max(0, room - 1)) : text;
    const fill = Math.max(0, width - 2 - 1 - visibleWidth(shown));
    return `${edge(`${left}─`)}${shown ? muted(shown) : ""}${edge(`${"─".repeat(fill)}${right}`)}`;
  }
}

export interface ComposerOptions {
  commands: readonly CommandDefinition[];
  /** Folder that `@file` completion starts from. */
  cwd: string;
  onSubmit(text: string): void;
}

/** The message box: pi-tui's multi-line editor with slash-command completion. It grows, then scrolls inside itself. */
export class Composer {
  readonly editor: Editor;
  private readonly studio: StudioEditor;

  constructor(tui: TUI, options: ComposerOptions) {
    this.studio = new StudioEditor(tui, {
      borderColor: faint,
      selectList: { selectedPrefix: accent, selectedText: (text) => selected(accent(text)), description: dim, scrollInfo: dim, noMatch: dim },
    });
    this.editor = this.studio;
    this.studio.setAutocompleteProvider(new CombinedAutocompleteProvider(
      options.commands.map((command) => ({ name: command.name.replace(/^\//, ""), description: `${command.usage}  ${command.description}` })),
      options.cwd,
    ));
    this.studio.onSubmit = (text) => {
      const request = text.trim();
      if (!request) return;
      this.studio.addToHistory(request);
      this.clear();
      options.onSubmit(request);
    };
  }

  get text(): string { return this.studio.getText(); }
  isEmpty(): boolean { return this.studio.getText().length === 0; }
  clear(): void { this.studio.setText(""); }
  /** Put text back, after whatever is already typed. */
  restore(text: string): void {
    const current = this.studio.getText();
    this.studio.setText(current ? `${current} ${text}` : text);
  }
  /** What the top edge of the box says (for example the permission mode and model) and how it is tinted. */
  setStatus(title: string, tone: ComposerTone): void {
    this.studio.title = title;
    this.studio.tone = tone;
  }
}
