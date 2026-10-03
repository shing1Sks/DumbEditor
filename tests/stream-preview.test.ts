import assert from "node:assert/strict";
import test from "node:test";
import { audioPlayerArguments, extractRawFrame, streamRawPreview } from "../src/core/media.js";
import { stillFrame } from "../src/shell/preview/playback.js";
import { makeProject } from "./helpers/project.js";

test("starts at the seek point right away, then delivers frames in real time", { timeout: 60_000 }, async () => {
  // The test video has one keyframe at 0, so seeking to 3 s means decoding 3 s of video first. FFmpeg's -re
  // paced that decoding in real time, so the first picture used to arrive about three seconds late.
  const project = await makeProject();
  try {
    const frames: Array<{ time: number; at: number }> = [];
    const began = Date.now();
    let ended = false;
    streamRawPreview({
      filePath: project.store.current.filePath, start: 3, size: { width: 160, height: 90 }, fps: 12,
      onFrame: (_frame, time) => frames.push({ time, at: Date.now() - began }),
      onEnd: () => { ended = true; },
    });
    const deadline = Date.now() + 20_000;
    while (!ended && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(ended, "the stream ends when the video does");
    assert.ok(frames.length >= 6, `expected about a second of frames, got ${frames.length}`);
    assert.equal(frames[0]?.time, 3);
    assert.ok((frames[0]?.at ?? Infinity) < 1500, `the first picture arrived after ${frames[0]?.at} ms`);
    const spanMs = (frames.at(-1)?.at ?? 0) - (frames[0]?.at ?? 0);
    const videoMs = ((frames.at(-1)?.time ?? 0) - (frames[0]?.time ?? 0)) * 1000;
    assert.ok(spanMs >= videoMs * 0.8, `frames must not run faster than the video: ${spanMs} ms for ${videoMs} ms of video`);
    assert.ok(frames.every((frame, index) => index === 0 || frame.time > (frames[index - 1]?.time ?? 0)), "frame times only go forward");
  } finally {
    await project.cleanup();
  }
});

test("stopping a stream stops its frames", { timeout: 60_000 }, async () => {
  const project = await makeProject();
  try {
    let count = 0;
    const stream = streamRawPreview({
      filePath: project.store.current.filePath, start: 0, size: { width: 160, height: 90 }, fps: 12,
      onFrame: () => { count += 1; }, onEnd: () => undefined,
    });
    const deadline = Date.now() + 10_000;
    while (count < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    stream.stop();
    const seen = count;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(count - seen <= 1, "no frames after stop");
  } finally {
    await project.cleanup();
  }
});

test("plays only the sound, so seeking lands exactly where asked instead of on the previous video keyframe", () => {
  const args = audioPlayerArguments("C:/videos/clip.mp4", 11.4, 70);
  assert.deepEqual(args, ["-nodisp", "-vn", "-autoexit", "-loglevel", "error", "-ss", "11.400", "-volume", "70", "C:/videos/clip.mp4"]);
  assert.equal(audioPlayerArguments("a.mp3", -2, 5).includes("0.000"), true, "a negative start is clamped to zero");
});

test("a still picture at the very end of the video is a whole picture, and so is the one before it", { timeout: 60_000 }, async () => {
  // Seeking to the end (or playing to it) asks for a frame at exactly the duration, where the file has none.
  const project = await makeProject();
  try {
    const { filePath } = project.store.current;
    const duration = project.store.current.duration;
    const size = { width: 160, height: 90 };
    const wanted = size.width * size.height * 3;
    const signal = new AbortController().signal;
    assert.ok((await extractRawFrame(filePath, duration, size, signal)).length < wanted, "the plain request really comes back empty");
    for (const time of [duration, duration - 0.02, duration / 2, 0]) {
      assert.equal((await stillFrame(filePath, time, duration, size, signal)).length, wanted, `a whole picture at ${time}`);
    }
  } finally {
    await project.cleanup();
  }
});
