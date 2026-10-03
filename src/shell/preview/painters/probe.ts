export interface ProbeResult {
  /** The terminal answered the Kitty graphics query. */
  kitty: boolean;
  /** Its device attributes list Sixel (attribute 4). */
  sixel: boolean;
  /** Pixel size of one cell, from the `CSI 16 t` answer. */
  cell: { width: number; height: number } | null;
  /** The name it gives itself (`CSI > 0 q`), like "kitty(0.35.2)" or "WezTerm 20240203". */
  name: string | null;
}

export interface ProbeTransport {
  write(data: string): void;
  /** Listen for what the terminal sends back; returns the function that stops listening. */
  onData(listener: (data: string) => void): () => void;
}

const ESC = "\u001B";
/**
 * Four questions in one write. The device-attributes query goes last: every terminal answers it, and answers it after
 * the others, so its reply means "everything that was going to answer has answered".
 *  - a Kitty graphics query (a 1x1 image, never shown),
 *  - the size of a cell in pixels,
 *  - the terminal's name and version,
 *  - the primary device attributes (attribute 4 means Sixel).
 */
export const PROBE_QUERY = `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\\${ESC}[16t${ESC}[>0q${ESC}[c`;

/** What the buffered replies say, or null until the device-attributes reply (the last one) has arrived. */
export function parseProbeReply(buffer: string): ProbeResult | null {
  const attributes = /\u001B\[\?([0-9;]*)c/.exec(buffer);
  if (!attributes) return null;
  const cell = /\u001B\[6;(\d+);(\d+)t/.exec(buffer);
  const name = /\u001BP>\|([^\u001B]*)\u001B\\/.exec(buffer);
  const width = cell ? Number(cell[2]) : 0;
  const height = cell ? Number(cell[1]) : 0;
  return {
    kitty: /\u001B_Gi=31;OK\u001B\\/.test(buffer),
    sixel: (attributes[1] ?? "").split(";").includes("4"),
    cell: width >= 4 && height >= 4 && width <= 200 && height <= 400 ? { width, height } : null,
    name: name?.[1]?.trim() || null,
  };
}

/**
 * Ask the terminal what it can do. Resolves with the answer, or with null when no device-attributes reply came in
 * time. After a timeout it keeps swallowing input a moment longer, so a late reply does not turn into typed text.
 */
export function probeTerminal(transport: ProbeTransport, timeoutMs: number, lateMs = 150): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    let buffer = "";
    let finished = false;
    const stop = transport.onData((data) => {
      buffer += data;
      if (finished) return;
      const result = parseProbeReply(buffer);
      if (result) { finished = true; clearTimeout(timer); stop(); resolve(result); }
    });
    const timer = setTimeout(() => {
      finished = true;
      setTimeout(() => { stop(); resolve(null); }, lateMs);
    }, timeoutMs);
    transport.write(PROBE_QUERY);
  });
}

interface StdinLike {
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  isPaused(): boolean;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

/** The real terminal: raw input on for the duration of the probe, and put back exactly as it was by `restore`. */
export function stdioTransport(stdin: StdinLike, stdout: { write(data: string): unknown }): ProbeTransport & { restore(): void } {
  const wasRaw = Boolean(stdin.isRaw);
  const wasPaused = stdin.isPaused();
  const listeners = new Set<(data: string) => void>();
  const handler = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const listener of [...listeners]) listener(text);
  };
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.on("data", handler);
  return {
    write: (data) => { stdout.write(data); },
    onData(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    restore() {
      stdin.off("data", handler);
      stdin.setRawMode?.(wasRaw);
      if (wasPaused) stdin.pause();
    },
  };
}
