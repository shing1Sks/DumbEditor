import { visibleWidth, type Component, type Focusable, type Input } from "@earendil-works/pi-tui";
import { fitLine, inverse } from "../views/style.js";

export type BorderStyle = "round" | "single" | "double";

const CHARS: Record<BorderStyle, { tl: string; tr: string; bl: string; br: string; h: string; v: string }> = {
  round: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  single: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
};

/** What every panel needs from the screen. */
export interface PanelContext {
  /** Height of the band the panel fills. */
  bandRows: () => number;
  requestRender: () => void;
}

/** A panel that replaces the video band and receives the keys while it is open. */
export abstract class Panel implements Component, Focusable {
  focused = false;
  constructor(protected readonly context: PanelContext) {}
  abstract render(width: number): string[];
  abstract handleInput(data: string): void;
  invalidate(): void { /* rebuilt every frame */ }
  protected get rows(): number { return this.context.bandRows(); }
}

/** A box around `lines`, exactly `width` columns wide and `lines.length + 2` rows tall. */
export function box(lines: readonly string[], width: number, options: { border: BorderStyle; color: (text: string) => string; paddingX?: number }): string[] {
  const chars = CHARS[options.border];
  const paddingX = options.paddingX ?? 1;
  const inner = Math.max(1, width - 2);
  const content = Math.max(1, inner - paddingX * 2);
  const gap = " ".repeat(paddingX);
  return [
    options.color(`${chars.tl}${chars.h.repeat(inner)}${chars.tr}`),
    ...lines.map((line) => `${options.color(chars.v)}${gap}${fitLine(line, content)}${gap}${options.color(chars.v)}`),
    options.color(`${chars.bl}${chars.h.repeat(inner)}${chars.br}`),
  ];
}

/** Make `lines` exactly `height` rows of exactly `width` columns, padding with blanks or cutting. */
export function fill(lines: readonly string[], width: number, height: number): string[] {
  return Array.from({ length: height }, (_, index) => fitLine(lines[index] ?? "", width));
}

/** Put a box in the middle of a `width` x `height` area. */
export function centered(boxLines: readonly string[], width: number, height: number): string[] {
  const boxWidth = boxLines.reduce((widest, line) => Math.max(widest, visibleWidth(line)), 0);
  const left = Math.max(0, Math.floor((width - boxWidth) / 2));
  const top = Math.max(0, Math.floor((height - boxLines.length) / 2));
  const rows = Array.from({ length: height }, (_, index) => {
    const line = boxLines[index - top];
    return line === undefined ? "" : `${" ".repeat(left)}${line}`;
  });
  return fill(rows, width, height);
}

/** The slice of a long list to show so that `selected` stays visible. */
export function listWindow(count: number, selected: number, capacity: number): { start: number; end: number } {
  const room = Math.max(1, capacity);
  const start = Math.min(Math.max(0, selected - room + 1), Math.max(0, count - room));
  return { start, end: Math.min(count, start + room) };
}

/** A list row, highlighted when selected. */
export function row(text: string, selected: boolean, color: (value: string) => string): string {
  return selected ? inverse(color(text)) : text;
}

export function wrapIndex(index: number, delta: number, count: number): number {
  return count === 0 ? 0 : (index + delta + count) % count;
}

/** True for typed text, false for control keys and escape sequences. */
export function isPrintable(data: string): boolean {
  return data.length > 0 && data.charCodeAt(0) !== 27 && ![...data].some((character) => character < " ");
}

/** True for typed text and for a bracketed paste (terminals wrap pasted text in ESC[200~ ... ESC[201~). */
export function isTextInput(data: string): boolean {
  return isPrintable(data) || data.startsWith("[200~");
}

/** Set a text field's value with the cursor at the end, where the user expects to keep typing. */
export function setValueAtEnd(input: Input, value: string): void {
  input.setValue(value);
  input.handleInput(String.fromCharCode(5));
}
