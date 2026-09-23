import type { DirectEdit, Selection } from "../types.js";
import { parseTimestamp } from "./time.js";

export interface CommandDefinition {
  name: string;
  usage: string;
  description: string;
}

export const COMMANDS: CommandDefinition[] = [
  { name: "/clip-remove", usage: "/clip-remove <FROM> <TO> [FROM TO ...]", description: "Remove one or more ranges" },
  { name: "/clip-keep", usage: "/clip-keep <FROM> <TO>", description: "Keep only one range" },
  { name: "/speed", usage: "/speed <FROM> <TO> <FACTOR>", description: "Change speed, for example 2x" },
  { name: "/mute", usage: "/mute <FROM> <TO>", description: "Mute one range" },
  { name: "/crop", usage: "/crop <WIDTH>x<HEIGHT> [X,Y]", description: "Crop the frame" },
  { name: "/open", usage: "/open <VIDEO PATH>", description: "Open a video" },
  { name: "/version", usage: "/version [all]", description: "Show version history" },
  { name: "/version-limits", usage: "/version-limits [1-100]", description: "Show or set retained edit versions" },
  { name: "/revert", usage: "/revert <VERSION>", description: "Switch to a saved version" },
  { name: "/undo", usage: "/undo", description: "Go to the parent version" },
  { name: "/export", usage: "/export <OUTPUT PATH>", description: "Export the active version" },
  { name: "/model", usage: "/model [PROVIDER] [TYPE] [MODEL]", description: "View or set provider model defaults" },
  { name: "/status", usage: "/status", description: "Show project details" },
  { name: "/play", usage: "/play", description: "Play the preview" },
  { name: "/pause", usage: "/pause", description: "Pause the preview" },
  { name: "/clear", usage: "/clear", description: "Clear visible chat" },
  { name: "/help", usage: "/help", description: "Show controls" },
  { name: "/quit", usage: "/quit", description: "Exit DumbEditor" },
];

export function commandSuggestions(input: string): CommandDefinition[] {
  if (!input.startsWith("/") || input.includes(" ")) return [];
  const query = input.toLowerCase();
  return COMMANDS.filter((command) => command.name.startsWith(query));
}

export function parseEditCommand(
  line: string,
  context: { duration: number; currentTime: number; selection: Selection },
): DirectEdit | null {
  const [rawCommand = "", ...tokens] = tokenize(line);
  const command = rawCommand.toLowerCase();
  if (!["/clip-remove", "/clip-keep", "/speed", "/mute", "/crop"].includes(command)) return null;

  if (command === "/crop") {
    if (tokens.length < 1 || tokens.length > 2) throw usageError(command);
    const size = tokens[0]?.match(/^(\d{2,5})[x×](\d{2,5})$/i);
    if (!size) throw usageError(command);
    const edit: DirectEdit = { action: "crop", width: Number(size[1]), height: Number(size[2]) };
    if (tokens[1]) {
      const position = tokens[1].match(/^(\d{1,5})[,x:](\d{1,5})$/i);
      if (!position) throw usageError(command);
      edit.x = Number(position[1]);
      edit.y = Number(position[2]);
    }
    return edit;
  }

  if (command === "/speed") {
    if (tokens.length !== 3) throw usageError(command);
    const range = parseRange(tokens[0]!, tokens[1]!, context);
    const factor = Number(tokens[2]!.replace(/x$/i, ""));
    if (!Number.isFinite(factor) || factor < 0.25 || factor > 16) throw new Error("Speed factor must be between 0.25x and 16x.");
    return { action: "speed", range, factor };
  }

  if (command === "/clip-remove") {
    if (tokens.length < 2 || tokens.length % 2 !== 0) throw usageError(command);
    const ranges = [];
    for (let index = 0; index < tokens.length; index += 2) ranges.push(parseRange(tokens[index]!, tokens[index + 1]!, context));
    return { action: "remove", ranges };
  }

  if (tokens.length !== 2) throw usageError(command);
  const range = parseRange(tokens[0]!, tokens[1]!, context);
  return command === "/clip-keep" ? { action: "trim", range } : { action: "mute", range };
}

function parseRange(from: string, to: string, context: { duration: number; currentTime: number; selection: Selection }) {
  const start = resolveTime(from, "in", context);
  const end = resolveTime(to, "out", context);
  if (start === null || end === null) throw new Error(`Could not read range “${from} ${to}”. Use seconds, mm:ss, start, end, playhead, in, or out.`);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function resolveTime(token: string, mark: "in" | "out", context: { duration: number; currentTime: number; selection: Selection }) {
  if (token.toLowerCase() === mark) return context.selection[mark];
  return parseTimestamp(token, context.duration, context.currentTime);
}

function usageError(command: string): Error {
  const definition = COMMANDS.find((item) => item.name === command);
  return new Error(`Usage: ${definition?.usage ?? command}`);
}

function tokenize(line: string): string[] {
  return Array.from(line.matchAll(/"([^"]*)"|'([^']*)'|\S+/g), (match) => match[1] ?? match[2] ?? match[0]);
}
