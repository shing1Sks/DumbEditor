import type { WriteStream } from "node:tty";

const SYNCHRONIZED_OUTPUT_START = "\u001B[?2026h";
const SYNCHRONIZED_OUTPUT_END = "\u001B[?2026l";

let directOutput: NodeJS.WriteStream = process.stdout;
let retainedLayer = "";

/**
 * Ink owns the text grid while the preview is painted with a terminal image
 * protocol. Retain that image and composite it into every Ink frame in one
 * synchronized terminal update.
 */
export function createLayeredStdout(output: NodeJS.WriteStream): NodeJS.WriteStream {
  directOutput = output;
  const layeredWrite = function write(
    chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const content = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding);
    const frame = retainedLayer
      ? `${SYNCHRONIZED_OUTPUT_START}${content}${retainedLayer}${SYNCHRONIZED_OUTPUT_END}`
      : content;
    return output.write(frame, encoding, done);
  };

  return new Proxy(output, {
    get(target, property, receiver) {
      if (property === "write") return layeredWrite;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as WriteStream;
}

export function retainTerminalLayer(output: string): void {
  retainedLayer = output;
}

export function clearRetainedTerminalLayer(): void {
  retainedLayer = "";
}

export function writeTerminalLayer(output: string): void {
  if (!output) return;
  directOutput.write(`${SYNCHRONIZED_OUTPUT_START}${output}${SYNCHRONIZED_OUTPUT_END}`);
}
