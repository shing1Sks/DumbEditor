import assert from "node:assert/strict";
import test from "node:test";
import { isBackspace, isFocusReport, playbackStart } from "../src/ui/keys.js";

test("treats the macOS and Linux Backspace byte, which Ink reports as delete, as Backspace", () => {
  assert.equal(isBackspace({ backspace: true, delete: false }), true);
  assert.equal(isBackspace({ backspace: false, delete: true }), true);
  assert.equal(isBackspace({ backspace: false, delete: false }), false);
});

test("recognises focus reports with and without the escape Ink strips", () => {
  for (const input of ["[I", "[O", "\u001B[I", "\u001B[O"]) assert.equal(isFocusReport(input), true);
  for (const input of ["I", "O", "[", "[Ix", "hello"]) assert.equal(isFocusReport(input), false);
});

test("restarts playback from zero when the playhead is at the end", () => {
  assert.equal(playbackStart(12, 12), 0);
  assert.equal(playbackStart(11.97, 12), 0);
  assert.equal(playbackStart(5, 12), 5);
  assert.equal(playbackStart(0, 12), 0);
});
