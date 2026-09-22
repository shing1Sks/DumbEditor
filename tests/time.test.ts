import assert from "node:assert/strict";
import test from "node:test";
import { extractRanges, formatTime, parseCrop, parseSpeedFactor, parseTimestamp } from "../src/core/time.js";

test("parses editor timestamps", () => {
  assert.equal(parseTimestamp("01:23.5", 200), 83.5);
  assert.equal(parseTimestamp("1:02:03", 5000), 3723);
  assert.equal(parseTimestamp("750ms", 10), 0.75);
  assert.equal(parseTimestamp("the end", 42), 42);
  assert.equal(parseTimestamp("playhead", 42, 12.5), 12.5);
  assert.equal(parseTimestamp("01:60", 200), null);
  assert.equal(parseTimestamp("1:60:00", 5000), null);
});

test("accepts sentence punctuation after a range", () => {
  assert.deepEqual(extractRanges("Please remove from 2 to 4 seconds.", 10), [{ start: 2, end: 4 }]);
});

test("extracts and merges multiple removal ranges", () => {
  assert.deepEqual(
    extractRanges("remove the video from 0.0 till 0.26 and from 7.55 to the end", 10),
    [{ start: 0, end: 0.26 }, { start: 7.55, end: 10 }],
  );
});

test("uses the marked range for this section", () => {
  assert.deepEqual(
    extractRanges("speed up this section at 3x", 20, 12, { in: 4, out: 9 }),
    [{ start: 4, end: 9 }],
  );
  assert.equal(parseSpeedFactor("speed up this section at 3x"), 3);
});

test("parses crop dimensions and formats time", () => {
  assert.deepEqual(parseCrop("crop to 1280x720 at 20,40"), { width: 1280, height: 720, x: 20, y: 40 });
  assert.deepEqual(parseCrop("crop to 1280×720"), { width: 1280, height: 720 });
  assert.equal(formatTime(83.56), "01:23.5");
});
