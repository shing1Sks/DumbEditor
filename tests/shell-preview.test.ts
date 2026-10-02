import assert from "node:assert/strict";
import test from "node:test";
import { extractRawFrame, previewRenderSize, type PreviewSize } from "../src/core/media.js";
import { buildVideoLayer } from "../src/shell/preview/video-layer.js";
import { LayeredTerminal, type VideoLayer } from "../src/shell/preview/layered-terminal.js";
import { AudioController } from "../src/shell/preview/audio.js";
import { PlaybackController, type PlaybackFrame } from "../src/shell/preview/playback.js";
import { PreviewHost } from "../src/shell/preview/preview-host.js";
import { FakeTerminal, sixelPlacements, STUB_SIXEL } from "./helpers/fake-terminal.js";
import { makeProject } from "./helpers/project.js";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("places a Sixel picture centred in the video rectangle, and block pictures row by row", () => {
  const size: PreviewSize = { width: 400, height: 200 };
  const sixel = buildVideoLayer({ encoded: STUB_SIXEL, size, backend: "sixel" }, { x: 22, y: 1, w: 60, h: 10 });
  assert.deepEqual(sixelPlacements(sixel), [[2, 22 + 1 + 10]], "rectangle x 22, 40 columns wide picture in 60 columns leaves 10 either side");
  assert.ok(sixel.startsWith("\x1b7") && sixel.endsWith("\x1b8"), "cursor is saved and restored");
  assert.ok(!sixel.includes("\x1b[?25l"), "the cursor must stay visible for the composer");
  const blocks = buildVideoLayer({ encoded: "aaa\nbbb\nccc", size: { width: 3, height: 6 }, backend: "blocks" }, { x: 0, y: 1, w: 7, h: 2 });
  assert.ok(blocks.includes("\x1b[2;3Haaa") && blocks.includes("\x1b[3;3Hbbb"));
  assert.ok(!blocks.includes("ccc"), "rows beyond the rectangle are cut");
});

function layered(initial: Partial<VideoLayer> = {}) {
  const inner = new FakeTerminal(80, 24);
  const state = { layer: { rect: { x: 10, y: 1, w: 40, h: 10 }, revision: 1, output: "<IMG>", ...initial } as VideoLayer | null, band: "band-a" };
  const terminal = new LayeredTerminal(inner, { layer: () => state.layer, bandText: () => state.band });
  return { inner, state, terminal };
}

test("writes each frame and the video layer as one synchronized update", async () => {
  const { inner, terminal } = layered();
  terminal.write("frame-one");
  terminal.write("frame-two");
  await tick();
  assert.equal(inner.writes.length, 1, "frames written in the same tick are sent together");
  assert.equal(inner.writes[0], `${SYNC_START}frame-oneframe-two<IMG>${SYNC_END}`);
  terminal.write(`${SYNC_START}x${SYNC_END}`);
  terminal.write("");
  await tick();
  assert.equal(inner.writes.at(-1), `${SYNC_START}x${SYNC_END}`, "unchanged picture is not sent again");
});

test("sends the picture again only when the video, its rectangle, or the text under it changed", async () => {
  const { inner, state, terminal } = layered();
  const frame = async (text = "f") => { terminal.write(`${SYNC_START}${text}${SYNC_END}`); await tick(); return inner.writes.at(-1) ?? ""; };
  assert.ok((await frame()).includes("<IMG>"), "first frame");
  assert.ok(!(await frame()).includes("<IMG>"), "nothing changed");
  state.layer = { ...state.layer!, revision: 2 };
  assert.ok((await frame()).includes("<IMG>"), "new video frame");
  state.layer = { ...state.layer!, rect: { x: 11, y: 1, w: 40, h: 10 } };
  assert.ok((await frame()).includes("<IMG>"), "rectangle moved");
  state.band = "band-b";
  assert.ok((await frame()).includes("<IMG>"), "text under the picture was rewritten");
  assert.ok(!(await frame()).includes("<IMG>"), "and then it settles");
});

test("brings the picture back after it was hidden, after a clear, and after the window is resized", async () => {
  const { inner, state, terminal } = layered();
  const frame = async () => { terminal.write(`${SYNC_START}f${SYNC_END}`); await tick(); return inner.writes.at(-1) ?? ""; };
  await frame();
  const visible = state.layer;
  state.layer = null;
  assert.ok(!(await frame()).includes("<IMG>"), "hidden while a panel covers it");
  state.layer = visible;
  assert.ok((await frame()).includes("<IMG>"), "back when the panel closes");
  assert.ok(!(await frame()).includes("<IMG>"));
  terminal.clearScreen();
  assert.ok((await frame()).includes("<IMG>"), "after a screen clear");
  assert.ok(!(await frame()).includes("<IMG>"));
  terminal.force();
  assert.ok((await frame()).includes("<IMG>"), "when asked, for example when the window regains focus");
});

test("draws the picture again when the window regains focus, and still passes the key on", async () => {
  const { inner, terminal } = layered();
  const received: string[] = [];
  terminal.start((data) => received.push(data), () => undefined);
  terminal.write(`${SYNC_START}f${SYNC_END}`);
  await tick();
  terminal.write(`${SYNC_START}f${SYNC_END}`);
  await tick();
  assert.ok(!(inner.writes.at(-1) ?? "").includes("<IMG>"), "settled");
  inner.send(String.fromCharCode(27) + "[I");
  await tick();
  assert.ok((inner.writes.at(-1) ?? "").includes("<IMG>"), "the picture is sent again without waiting for pi-tui");
  assert.deepEqual(received, [String.fromCharCode(27) + "[I"]);
});

test("playback gives a still frame, then streams frames while playing, and stops when disposed", { timeout: 60_000 }, async () => {
  const project = await makeProject();
  try {
    const media = project.state.media;
    const rect = { columns: 60, rows: 12 };
    const size = previewRenderSize(media, rect.columns, rect.rows, "sixel");
    const direct = await extractRawFrame(project.store.current.filePath, 1, size);
    assert.equal(direct.length, size.width * size.height * 3);

    const frames: PlaybackFrame[] = [];
    let ended = 0;
    const errors: Error[] = [];
    const playback = new PlaybackController({
      onFrame: (frame) => frames.push(frame), onEnd: () => { ended += 1; }, onError: (error) => errors.push(error),
    });
    const input = { filePath: project.store.current.filePath, media, columns: rect.columns, rows: rect.rows, backend: "sixel" as const, playing: false, time: 1 };
    playback.update(input);
    await waitFor(() => frames.length > 0);
    assert.equal(frames[0]?.time, 1);
    assert.match(frames[0]?.encoded ?? "", /^\x1bP[\d;]*q/, "a Sixel picture");
    assert.deepEqual(frames[0]?.size, size);

    const still = frames.length;
    playback.update({ ...input });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(frames.length, still, "the same input does not start the work again");

    playback.update({ ...input, playing: true, time: 0 });
    await waitFor(() => frames.length > still + 2);
    assert.ok(frames.at(-1)!.time >= 0);
    await waitFor(() => ended === 1, 20_000);
    assert.deepEqual(errors, []);

    playback.update({ ...input, time: 2 });
    await waitFor(() => frames.at(-1)?.time === 2);
    playback.update({ ...input, playing: true, time: 2 });
    const resumed = frames.length;
    await waitFor(() => frames.length > resumed + 1);
    const before = frames.length;
    playback.dispose();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(frames.length - before <= 1, "no frames after dispose");
    assert.equal(ended, 1, "disposing is not the same as reaching the end");
  } finally {
    await project.cleanup();
  }
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("audio plays only while the preview plays, and a burst of volume changes restarts it once", async () => {
  const started: Array<[number, number]> = [];
  let stopped = 0;
  const audio = new AudioController(() => undefined, {
    spawn: (_file, start, volume) => { started.push([start, volume]); return {} as never; },
    terminate: (child) => { if (child) stopped += 1; },
    debounceMs: 30,
  });
  const base = { filePath: "a.mp4", hasAudio: true, start: 2, volume: 70 };
  audio.update({ ...base, playing: false });
  assert.deepEqual(started, [], "nothing plays while paused");
  audio.update({ ...base, playing: true });
  assert.deepEqual(started, [[2, 70]]);
  audio.update({ ...base, playing: true, volume: 75, start: 3 });
  audio.update({ ...base, playing: true, volume: 80, start: 4 });
  assert.equal(started.length, 1, "waits for the volume to settle");
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.deepEqual(started.at(-1), [4, 80], "restarts once, from the current position, at the final volume");
  assert.equal(stopped, 1);
  audio.update({ ...base, volume: 80, start: 5, playing: false });
  assert.equal(stopped, 2, "pausing stops the sound");
  audio.update({ ...base, hasAudio: false, playing: true });
  assert.equal(started.length, 2, "a video without a sound track plays nothing");
  audio.dispose();
});

test("the preview host paints each new picture in the video rectangle, and hides it on request", async () => {
  const inner = new FakeTerminal(80, 24);
  let visible = true;
  const host = new PreviewHost(inner, { visible: () => visible, rect: () => ({ x: 0, y: 1, w: 80, h: 10 }), screenLines: () => [] });
  const frame = { encoded: STUB_SIXEL, size: { width: 400, height: 200 }, backend: "sixel" as const };
  host.setFrame(frame);
  await tick();
  assert.deepEqual(sixelPlacements(inner.writes.join("")), [[2, 21]], "centred: 40 columns wide in 80");
  const mark = inner.mark();
  host.setFrame(frame);
  await tick();
  assert.equal(sixelPlacements(inner.since(mark)).length, 1, "a new picture is painted at once, without a pi-tui frame");
  const again = inner.mark();
  host.repaint();
  await tick();
  assert.equal(sixelPlacements(inner.since(again)).length, 1, "repaint draws it again");
  visible = false;
  const hidden = inner.mark();
  host.setFrame(frame);
  await tick();
  assert.equal(sixelPlacements(inner.since(hidden)).length, 0, "not drawn while a panel covers it");
  visible = true;
  host.clear();
  host.terminal.write("x");
  await tick();
  assert.equal(sixelPlacements(inner.since(hidden)).length, 0, "nothing to draw after clear");
});

test("stopping writes what is pending straight away and leaves no picture behind", async () => {
  const { inner, terminal } = layered();
  terminal.write("restore the screen");
  terminal.stop();
  assert.equal(inner.writes.at(-1), "restore the screen", "written at once: queued work never runs while the process is exiting");
  await tick();
  assert.ok(!inner.writes.join("").includes("<IMG>"), "no picture after the terminal was given back");
});

test("does not draw a picture that no longer fits the video rectangle", async () => {
  const inner = new FakeTerminal(80, 24);
  const host = new PreviewHost(inner, { visible: () => true, rect: () => ({ x: 0, y: 2, w: 80, h: 11 }), screenLines: () => [] });
  host.setFrame({ encoded: STUB_SIXEL, size: { width: 1800, height: 900 }, backend: "sixel" });
  await tick();
  assert.equal(sixelPlacements(inner.writes.join("")).length, 0, "a picture made for a bigger window would cover the chat and the prompt box");
  host.setFrame({ encoded: STUB_SIXEL, size: { width: 400, height: 200 }, backend: "sixel" });
  await tick();
  assert.equal(sixelPlacements(inner.writes.join("")).length, 1, "one that fits is drawn");
});
