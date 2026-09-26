import type { ChatMessage } from "../types.js";

export interface ChatLine {
  role: ChatMessage["role"];
  prefix: string;
  text: string;
}

export interface InputLine {
  prefix: string;
  before: string;
  cursor: string;
  after: string;
}

export function chatViewport(
  messages: ChatMessage[],
  assistantLabel: string,
  width: number,
  height: number,
  scrollRows: number,
): { lines: ChatLine[]; maxScroll: number; totalRows: number; startRow: number; endRow: number; scrollRows: number } {
  const rows = messages.flatMap((message) => wrapMessage(message, assistantLabel, Math.max(12, width)));
  const visibleHeight = Math.max(1, height);
  const maxScroll = Math.max(0, rows.length - visibleHeight);
  const offset = Math.max(0, Math.min(maxScroll, scrollRows));
  const end = rows.length - offset;
  const start = Math.max(0, end - visibleHeight);
  return {
    lines: rows.slice(start, end),
    maxScroll,
    totalRows: rows.length,
    startRow: start,
    endRow: end,
    scrollRows: offset,
  };
}

export function inputViewport(value: string, cursor: number, width: number, maxRows = 4): { lines: InputLine[]; rows: number; capacity: number } {
  const capacity = Math.max(8, width - 2);
  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  const totalRows = Math.max(1, Math.floor(value.length / capacity) + 1);
  const cursorRow = Math.floor(safeCursor / capacity);
  const visibleRows = Math.min(Math.max(1, maxRows), totalRows);
  const startRow = Math.max(0, Math.min(cursorRow - visibleRows + 1, totalRows - visibleRows));
  const lines: InputLine[] = [];
  for (let row = startRow; row < startRow + visibleRows; row += 1) {
    const start = row * capacity;
    const text = value.slice(start, start + capacity);
    const hasCursor = row === cursorRow;
    const cursorOffset = hasCursor ? safeCursor - start : -1;
    lines.push({
      prefix: row === 0 ? "› " : row === startRow && startRow > 0 ? "↑ " : "│ ",
      before: hasCursor ? text.slice(0, cursorOffset) : text,
      cursor: hasCursor ? (text[cursorOffset] ?? " ") : "",
      after: hasCursor ? text.slice(cursorOffset + (cursorOffset < text.length ? 1 : 0)) : "",
    });
  }
  return { lines, rows: visibleRows, capacity };
}

export function moveInputCursorVertically(value: string, cursor: number, capacity: number, direction: -1 | 1): number {
  const row = Math.floor(cursor / capacity);
  const column = cursor % capacity;
  const targetRow = Math.max(0, row + direction);
  const target = targetRow * capacity + column;
  return Math.max(0, Math.min(value.length, target));
}

function wrapMessage(message: ChatMessage, assistantLabel: string, width: number): ChatLine[] {
  const label = message.role === "user" ? "you" : (message.label ?? assistantLabel);
  const prefix = `${label} › `;
  const indent = `${" ".repeat(Math.min(label.length, Math.max(1, width - 4)))} │ `;
  const content = cleanTerminalMarkdown(message.content);
  const logicalLines = content.split(/\r?\n/);
  const output: ChatLine[] = [];
  let first = true;
  for (const logical of logicalLines) {
    const activePrefix = first ? prefix : indent;
    const chunks = wrapWords(logical, Math.max(4, width - activePrefix.length));
    for (const [index, chunk] of chunks.entries()) {
      output.push({ role: message.role, prefix: first && index === 0 ? prefix : indent, text: chunk });
      first = false;
    }
  }
  return output.length > 0 ? output : [{ role: message.role, prefix, text: "" }];
}

function wrapWords(value: string, width: number): string[] {
  if (!value) return [""];
  const words = value.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > width) {
      if (current) { lines.push(current); current = ""; }
      for (let start = 0; start < word.length; start += width) lines.push(word.slice(start, start + width));
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > width && current) { lines.push(current); current = word; }
    else current = candidate;
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function cleanTerminalMarkdown(value: string): string {
  return value
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ");
}
