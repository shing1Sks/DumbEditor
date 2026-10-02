import { Container, ScrollView, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { TranscriptMessage } from "../state/shell-state.js";
import { accent, bad, bold, faint, good, info, muted, styleMarkdown, warn } from "./style.js";

/** Space kept free at the left and right of the conversation, in line with the header and the prompt box. */
const MARGIN = "  ";

/**
 * One message with a gutter symbol instead of a name: `❯` for you, `◆` for the agent, `▸ ✓ ✗` for tool steps,
 * `·` for notes from the editor. Wrapped lines line up under the text. A blank row separates your messages.
 */
export class MessageView implements Component {
  constructor(private readonly message: TranscriptMessage, private readonly spaceBefore = false) {}

  render(width: number): string[] {
    const { message } = this;
    const { gutter, style } = this.look();
    const indent = " ".repeat(visibleWidth(gutter));
    const room = Math.max(4, width - indent.length - MARGIN.length * 2);
    // Tool steps start with their own symbol (▸ ✓ ✗); the gutter shows it, so the text is shown without it.
    const text = message.label === "tool" ? message.text.replace(/^[▸✓✗]\s*/, "") : message.text;
    const output: string[] = [];
    for (const logical of text.split(/\r?\n/)) {
      const pieces = logical.trim() === "" ? [""] : wrapTextWithAnsi(style(styleMarkdown(logical)), room);
      for (const piece of pieces) output.push(`${MARGIN}${output.length === 0 ? gutter : indent}${piece}`);
    }
    if (output.length === 0) output.push(`${MARGIN}${gutter}`);
    return this.spaceBefore ? ["", ...output] : output;
  }

  private look(): { gutter: string; style: (text: string) => string } {
    const { message } = this;
    if (message.role === "user") return { gutter: `${bold(info("❯"))} `, style: (text) => text };
    if (message.label === "error") return { gutter: `${bad("✗")} `, style: bad };
    if (message.label === "editor") return { gutter: `${faint("·")} `, style: muted };
    if (message.label === "tool") {
      const glyph = message.text.startsWith("✓") ? good("✓") : message.text.startsWith("✗") ? bad("✗") : warn("▸");
      return { gutter: `  ${glyph} `, style: muted };
    }
    return { gutter: `${accent("◆")} `, style: (text) => text };
  }

  invalidate(): void { /* rendered fresh every frame */ }
}

/** The conversation: a scrolling list of messages that follows the newest line until the user scrolls up. */
export class TranscriptView {
  readonly view: ScrollView;
  private readonly container = new Container();
  private ids: string[] = [];

  constructor() {
    this.view = new ScrollView(this.container, { follow: "end", primary: true });
  }

  /** Make the list match the messages. Streaming changes to an existing message need no rebuild. */
  sync(messages: readonly TranscriptMessage[]): void {
    const ids = messages.map((message) => message.id);
    if (ids.length === this.ids.length && ids.every((id, index) => id === this.ids[index])) return;
    this.container.clear();
    messages.forEach((message, index) => this.container.addChild(new MessageView(message, index > 0 && message.role === "user")));
    this.ids = ids;
  }

  /** Positive rows scroll toward older messages. */
  scrollBy(rows: number): void { this.view.scrollBy(-rows); }
  scrollToEnd(): void { this.view.scrollToEnd(); }
  /** A page: the visible height minus one row of overlap. */
  pageRows(): number { return Math.max(1, this.view.viewportHeight - 1); }
}
