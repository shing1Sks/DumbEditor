import assert from "node:assert/strict";
import test from "node:test";
import { commandSuggestions, parseEditCommand } from "../src/core/commands.js";

const context = { duration: 100, currentTime: 12, selection: { in: 4, out: 9 } };

test("discovers slash commands by prefix", () => {
  assert.deepEqual(commandSuggestions("/clip").map((item) => item.name), ["/clip-remove", "/clip-keep"]);
  assert.ok(commandSuggestions("/").length > 6);
  assert.ok(commandSuggestions("/").some((item) => item.name === "/model"));
  assert.ok(commandSuggestions("/").some((item) => item.name === "/version-limits"));
  assert.equal(commandSuggestions("normal request").length, 0);
});

test("parses deterministic editing commands", () => {
  assert.deepEqual(parseEditCommand("/clip-remove 0 2.5 01:20 end", context), {
    action: "remove", ranges: [{ start: 0, end: 2.5 }, { start: 80, end: 100 }],
  });
  assert.deepEqual(parseEditCommand("/clip-keep in out", context), { action: "trim", range: { start: 4, end: 9 } });
  assert.deepEqual(parseEditCommand("/speed 2s 8s 2x", context), { action: "speed", range: { start: 2, end: 8 }, factor: 2 });
  assert.deepEqual(parseEditCommand("/mute playhead end", context), { action: "mute", range: { start: 12, end: 100 } });
  assert.deepEqual(parseEditCommand("/crop 1280x720 20,40", context), { action: "crop", width: 1280, height: 720, x: 20, y: 40 });
});

test("reports command usage for incomplete edits", () => {
  assert.throws(() => parseEditCommand("/clip-remove 2", context), /Usage: \/clip-remove/);
  assert.throws(() => parseEditCommand("/speed 0 5 99x", context), /between 0.25x and 16x/);
});
