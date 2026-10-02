import { backgroundAnsi, foregroundAnsi, getTerminalColorMode, parseColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// The look: one calm violet accent on a dark ground, with sky blue for "you" and the play position. Colours are
// written as hex and converted to what the terminal can show (true colour, or the nearest of 256).
const PALETTE = {
  accent: "#a78bfa",
  info: "#7dd3fc",
  good: "#4ade80",
  warn: "#fbbf24",
  bad: "#f87171",
  muted: "#9aa3b2",
  faint: "#566070",
} as const;

const SURFACE = {
  bar: "#181826",
  chip: "#262638",
  panel: "#13131b",
  selected: "#34285a",
} as const;

const colourCache = new Map<string, ReturnType<typeof parseColor>>();
const colourOf = (hex: string) => {
  let colour = colourCache.get(hex);
  if (!colour) { colour = parseColor(hex); colourCache.set(hex, colour); }
  return colour;
};
const foreground = (hex: string) => (text: string): string => `${foregroundAnsi(colourOf(hex), getTerminalColorMode())}${text}\u001B[39m`;
// A background that survives a nested one ending: text inside (a chip, say) turns the background off when it ends,
// so the outer background is switched back on right after.
const background = (hex: string) => (text: string): string => {
  const open = backgroundAnsi(colourOf(hex), getTerminalColorMode());
  return `${open}${text.replaceAll("\u001B[49m", `\u001B[49m${open}`).replaceAll("\u001B[0m", `\u001B[0m${open}`)}\u001B[49m`;
};
const attribute = (open: number, close: number) => (text: string): string => `\u001B[${open}m${text}\u001B[${close}m`;

export const bold = attribute(1, 22);
export const dim = attribute(2, 22);
export const italic = attribute(3, 23);

export const accent = foreground(PALETTE.accent);
export const info = foreground(PALETTE.info);
export const good = foreground(PALETTE.good);
export const warn = foreground(PALETTE.warn);
export const bad = foreground(PALETTE.bad);
export const muted = foreground(PALETTE.muted);
export const faint = foreground(PALETTE.faint);

/** A soft highlight for the selected row of a list. */
export const selected = background(SURFACE.selected);
/** The tinted ground of the header bar and of small chips. */
export const onBar = background(SURFACE.bar);
export const onChip = background(SURFACE.chip);
/** The soft ground of the sidebars. */
export const onPanel = background(SURFACE.panel);

/** A small label with its own ground, for things like the permission mode. */
export const chip = (text: string, colour: (text: string) => string = muted): string => onChip(colour(` ${text} `));

// Older names, now mapped to the theme so every panel shares the same colours.
export const inverse = selected;
export const red = bad;
export const green = good;
export const yellow = warn;
export const magenta = accent;
export const cyan = info;
export const gray = faint;

/** Cut to the width (without an ellipsis marker when it already fits) and pad with spaces to exactly that width. */
export function fitLine(text: string, width: number): string {
  const cut = visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

/** Put `left` and `right` on one line of exactly `width` columns, dropping the right side first when it does not fit. */
export function spaceBetween(left: string, right: string, width: number): string {
  const free = width - visibleWidth(left) - visibleWidth(right);
  if (free >= 1) return `${left}${" ".repeat(free)}${right}`;
  return fitLine(left, width);
}

/** A project's name without the date and time added when it was created: "clip · 2026-10-03 00:46" is "clip". */
export function shortProjectName(name: string): string {
  const cut = name.split(" · ")[0]?.trim();
  return cut ? cut : name;
}

/** Collapse whitespace and cut a value to a number of characters, ending in an ellipsis when cut. */
export function shorten(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(1, limit - 1))}…`;
}

/** Remove escape sequences, for tests and for measuring. */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]|\u001B\][^\u0007]*\u0007|\u001B_[^\u001B]*\u001B\\/g, "");
}

/** Light markdown for the chat: bold, inline code, headings and bullets. */
export function styleMarkdown(line: string): string {
  const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
  if (heading) return bold(accent(heading[1] ?? ""));
  return line
    .replace(/^(\s*)[-*]\s+/, (_all, indent: string) => `${indent}${faint("•")} `)
    .replace(/\*\*(.+?)\*\*/g, (_all, text: string) => bold(text))
    .replace(/__(.+?)__/g, (_all, text: string) => bold(text))
    .replace(/`([^`]+)`/g, (_all, text: string) => accent(text));
}
