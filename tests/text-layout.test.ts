import assert from "node:assert/strict";
import test from "node:test";
import { chatViewport, inputViewport, moveInputCursorVertically } from "../src/ui/text-layout.js";

test("wraps chat by terminal rows and keeps model labels consistent", () => {
  const messages = [
    { role: "assistant" as const, content: "**First option** with enough words to wrap over several rows in a narrow terminal.", at: "1" },
    { role: "user" as const, content: "show me more", at: "2" },
  ];
  const view = chatViewport(messages, "gpt-6-sol", 28, 3, 0);
  assert.equal(view.lines.length, 3);
  assert.equal(view.endRow, view.totalRows);
  assert.equal(view.scrollRows, 0);
  assert.equal(view.lines.some((line) => line.prefix.startsWith("gpt-6-sol")), false);
  const older = chatViewport(messages, "gpt-6-sol", 28, 3, view.maxScroll);
  assert.equal(older.startRow, 0);
  assert.equal(older.lines[0]?.prefix, "gpt-6-sol › ");
  assert.equal(older.lines.some((line) => line.text.includes("**")), false);
});

test("bounds multiline input and moves the cursor by visual rows", () => {
  const value = "abcdefghijklmnopqrstuvwxyz";
  const viewport = inputViewport(value, value.length, 12, 2);
  assert.equal(viewport.rows, 2);
  assert.equal(viewport.lines[0]?.prefix, "↑ ");
  assert.equal(moveInputCursorVertically(value, 23, viewport.capacity, -1), 13);
});
