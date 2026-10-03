import { inflateSync } from "node:zlib";

/** One finished Kitty graphics command, as a terminal would see it after joining the chunks of a transmission. */
export interface KittyCommand {
  keys: Record<string, string>;
  /** The decoded pixel data for a transmission (base64 removed, zlib undone when o=z), empty for other commands. */
  data: Buffer;
  /** How many escape sequences (chunks) made up the command, and the longest payload among them. */
  chunks: number;
  longestPayload: number;
}

/**
 * Reads the Kitty graphics escape sequences (ESC _ G keys ; payload ESC \) out of a stream the way a terminal does:
 * keys come from the first chunk, later chunks only carry m= and more payload, and a command ends at m=0.
 * Anything that is not an APC graphics sequence is ignored.
 */
export function decodeKitty(stream: string): KittyCommand[] {
  const commands: KittyCommand[] = [];
  const pattern = /\u001B_G([^;\u001B]*)(?:;([^\u001B]*))?\u001B\\/g;
  let current: { keys: Record<string, string>; payload: string; chunks: number; longest: number } | null = null;
  for (const match of stream.matchAll(pattern)) {
    const keys: Record<string, string> = {};
    for (const pair of (match[1] ?? "").split(",")) {
      const [name, value] = pair.split("=");
      if (name) keys[name] = value ?? "";
    }
    const payload = match[2] ?? "";
    if (current === null) current = { keys, payload: "", chunks: 0, longest: 0 };
    else for (const [name, value] of Object.entries(keys)) if (name !== "m") current.keys[name] = value;
    current.payload += payload;
    current.chunks += 1;
    current.longest = Math.max(current.longest, payload.length);
    if (keys.m !== "1") {
      const raw = Buffer.from(current.payload, "base64");
      delete current.keys.m;
      commands.push({
        keys: current.keys,
        data: current.keys.o === "z" ? inflateSync(raw) : raw,
        chunks: current.chunks,
        longestPayload: current.longest,
      });
      current = null;
    }
  }
  if (current !== null) throw new Error("a transmission was left open: the last chunk did not say m=0");
  return commands;
}
