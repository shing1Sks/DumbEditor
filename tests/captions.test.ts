import assert from "node:assert/strict";
import test from "node:test";
import { parseCues } from "../src/core/captions.js";

test("parses an SRT with a BOM, CRLF and a sequence number", () => {
  const srt = "﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello there\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nSecond\r\nline\r\n";
  assert.deepEqual(parseCues(srt, ".srt"), [
    { start: 1, end: 2.5, text: "Hello there" },
    { start: 3, end: 4, text: "Second\nline" },
  ]);
});

test("strips tags and positioning codes, drops empty cues and keeps cues sorted", () => {
  const srt = "2\n00:00:05,000 --> 00:00:06,000\n{\\an8}<i>Top</i> <font color=\"red\">text</font>\n\n1\n00:00:01,000 --> 00:00:02,000\n   \n\n3\n00:00:00,500 --> 00:00:01,000\nFirst\n";
  assert.deepEqual(parseCues(srt, ".srt"), [
    { start: 0.5, end: 1, text: "First" },
    { start: 5, end: 6, text: "Top text" },
  ]);
});

test("overlapping cues are both kept", () => {
  const cues = parseCues("1\n00:00:01,000 --> 00:00:03,000\nA\n\n2\n00:00:02,000 --> 00:00:04,000\nB\n", ".srt");
  assert.equal(cues.length, 2);
});

test("parses WebVTT with a header, notes, cue ids, short timestamps and settings", () => {
  const vtt = "WEBVTT\n\nNOTE written by hand\n\nintro\n00:01.000 --> 00:02.000 align:start position:10%\nHi\n\n00:00:03.500 --> 00:00:05.000\n<v Bob>Hello</v>\n";
  assert.deepEqual(parseCues(vtt, ".vtt"), [
    { start: 1, end: 2, text: "Hi" },
    { start: 3.5, end: 5, text: "Hello" },
  ]);
});

test("ignores cues whose end is not after the start, and returns nothing for an empty file", () => {
  assert.deepEqual(parseCues("1\n00:00:02,000 --> 00:00:01,000\nbad\n", ".srt"), []);
  assert.deepEqual(parseCues("", ".srt"), []);
  assert.deepEqual(parseCues("not a subtitle file at all", ".srt"), []);
});
