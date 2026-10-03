import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseTextRenderer, loadCapabilities, parseEncoders, parseFilters, parseVersion, type FfmpegCapabilities,
} from "../src/core/ffmpeg-capabilities.js";

const FILTERS = `Filters:
  T.. = Timeline support
  .S. = Slice threading
  ..C = Command support
  A = Audio input/output
  V = Video input/output
  | = Source or sink filter
 ... abench            A->A       Benchmark part of a filtergraph.
 T.C adelay            A->A       Delay one or more audio channels.
 ... scale             V->V       Scale the input video size and/or convert the image format.
 T.. overlay           VV->V      Overlay a video source on top of the input.
 ..C ass               V->V       Render ASS subtitles onto input video using the libass library.
 ... subtitles         V->V       Render text subtitles onto input video using the libass library.
`;
const SLIM_FILTERS = FILTERS.split("\n").filter((line) => !/ ass | subtitles /.test(line)).join("\n");
const ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V.S... gif                  GIF (Graphics Interchange Format)
 A....D aac                  AAC (Advanced Audio Coding)
 S..... srt                  SubRip subtitle
`;
const VERSION = "ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with Apple clang\n";

test("parses filter names and ignores the legend", () => {
  const names = parseFilters(FILTERS);
  for (const name of ["abench", "adelay", "scale", "overlay", "ass", "subtitles"]) assert.ok(names.has(name), name);
  assert.equal(names.has("="), false);
  assert.equal(names.size, 6);
});

test("parses the two-column format newer FFmpeg builds print", () => {
  const newer = `Filters:
  T = Timeline support
  S = Slice threading
  A = Audio input/output
  V = Video input/output
  N = Dynamic number of inputs/outputs
  | = Source or sink filter
  ------
 TS aap               AA->A      Apply Affine Projection algorithm to first audio stream.
 .. abench            A->A       Benchmark part of a filtergraph.
 .. ass               V->V       Render ASS subtitles onto input video using the libass library.
 T. overlay           VV->V      Overlay a video source on top of the input.
`;
  assert.deepEqual([...parseFilters(newer)].sort(), ["aap", "abench", "ass", "overlay"]);
});

test("parses encoder names and ignores the legend", () => {
  const names = parseEncoders(ENCODERS);
  assert.deepEqual([...names].sort(), ["aac", "gif", "libx264", "srt"]);
});

test("encoder names with a hyphen are kept", () => {
  assert.ok(parseEncoders(" V....D libaom-av1            libaom AV1\n V....D libvpx-vp9           libvpx VP9\n").has("libaom-av1"));
});

test("parses the version", () => {
  assert.equal(parseVersion(VERSION), "7.1.1");
  assert.equal(parseVersion("nonsense"), null);
});

test("loads the three outputs through the injected runner and tolerates a failing one", async () => {
  const run = async (_command: string, args: string[]) => (args.includes("-filters") ? FILTERS : args.includes("-encoders") ? ENCODERS : VERSION);
  const caps = await loadCapabilities(run);
  assert.equal(caps?.version, "7.1.1");
  assert.ok(caps?.filters.has("ass"));
  assert.ok(caps?.encoders.has("libx264"));
  assert.equal(await loadCapabilities(async () => { throw new Error("no ffmpeg"); }), null);
});

test("reads the real FFmpeg on this machine", async () => {
  const caps = await loadCapabilities();
  assert.ok(caps, "ffmpeg runs");
  assert.ok(caps.filters.size > 50, `parsed ${caps.filters.size} filters`);
  for (const name of ["scale", "overlay", "volume", "fps", "crop"]) assert.ok(caps.filters.has(name), `filter ${name}`);
  for (const name of ["libx264", "aac"]) assert.ok(caps.encoders.has(name), `encoder ${name}`);
  assert.ok(caps.version, "version");
});

test("picks libass when the ass filter exists, images when it does not, libass when FFmpeg cannot be asked", () => {
  const full: FfmpegCapabilities = { version: "7", filters: parseFilters(FILTERS), encoders: new Set() };
  const slim: FfmpegCapabilities = { version: "7", filters: parseFilters(SLIM_FILTERS), encoders: new Set() };
  assert.equal(chooseTextRenderer(full, {}), "libass");
  assert.equal(chooseTextRenderer(slim, {}), "images");
  assert.equal(chooseTextRenderer(null, {}), "libass", "an unreadable probe keeps today's behaviour");
});

test("DUMBEDITOR_TEXT_RENDERER forces a path", () => {
  const full: FfmpegCapabilities = { version: "7", filters: parseFilters(FILTERS), encoders: new Set() };
  assert.equal(chooseTextRenderer(full, { DUMBEDITOR_TEXT_RENDERER: "images" }), "images");
  assert.equal(chooseTextRenderer(null, { DUMBEDITOR_TEXT_RENDERER: " IMAGES " }), "images");
  const slim: FfmpegCapabilities = { version: "7", filters: parseFilters(SLIM_FILTERS), encoders: new Set() };
  assert.equal(chooseTextRenderer(slim, { DUMBEDITOR_TEXT_RENDERER: "libass" }), "libass");
  assert.equal(chooseTextRenderer(full, { DUMBEDITOR_TEXT_RENDERER: "nonsense" }), "libass");
});
