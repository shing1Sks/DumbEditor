import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  clearRetainedTerminalLayer,
  createLayeredStdout,
  retainTerminalLayer,
  writeTerminalLayer,
} from "../src/ui/terminal-layers.js";

test("composites the retained video layer into synchronized Ink frames", () => {
  const sink = new PassThrough();
  let output = "";
  sink.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const layered = createLayeredStdout(sink as unknown as NodeJS.WriteStream);

  clearRetainedTerminalLayer();
  layered.write("plain");
  retainTerminalLayer("<video>");
  layered.write("ink");
  writeTerminalLayer("frame");

  assert.equal(
    output,
    "plain\u001B[?2026hink<video>\u001B[?2026l\u001B[?2026hframe\u001B[?2026l",
  );
  clearRetainedTerminalLayer();
});
